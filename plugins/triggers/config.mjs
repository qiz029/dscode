// Trigger definitions: the configuration half of the trigger mechanism
// (docs/triggers-design.md). A definition says what produces an event, which
// folder the session binds to, what it is asked to do, and the limits that
// keep an unattended run bounded. Nothing here starts a run: the ingress, the
// runner and the source installers are separate work, and `/triggers` reads this
// layer only.
//
// One bad file never hides the rest: discovery returns the definitions it could
// read plus a per-file problem list, so a listing always shows what is usable.

import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateCalendar } from './schedule.mjs';

/** Source kinds this version accepts; each has its own required fields. */
export const SOURCE_KINDS = Object.freeze(['interval', 'calendar', 'watch', 'poll', 'external', 'script']);

/** The default fresh-session overlap policy; persistent sessions queue instead. */
export const OVERLAP = 'skip';

/** The only notification policy for now: append to the run log. */
export const NOTIFY = 'log';

/** Defaults a definition may omit. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  preset: 'dscode',
  permission: 'workspace-write',
  maxGoalRounds: 20,
  timeoutSeconds: 1800,
  maxRunsPerDay: 24,
  minIntervalSeconds: 60,
});

/** Permission presets an unattended run may use; `ask` can never complete. */
const UNATTENDED_PERMISSIONS = Object.freeze(['auto-review', 'auto', 'workspace-write', 'read-only', 'danger-full-access']);

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

class TriggerConfigError extends Error {}

const fail = message => { throw new TriggerConfigError(message); };

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function positiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail(`${label} must be a positive number`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive whole number`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
  return value.trim();
}

/** Reject a key this version does not read, so a typo cannot fall back silently. */
function knownKeys(raw, allowed, label) {
  const unknown = Object.keys(raw).filter(key => !allowed.includes(key));
  if (unknown.length > 0) fail(`${label} has no such field: ${unknown.join(', ')} (accepted: ${allowed.join(', ')})`);
}

/** Validate and normalize one source block. */
function normalizeSource(raw) {
  if (!isPlainObject(raw)) fail('source must be an object');
  const kind = nonEmptyString(raw.kind, 'source.kind');
  if (!SOURCE_KINDS.includes(kind)) fail(`source.kind must be one of: ${SOURCE_KINDS.join(', ')}`);
  const fields = kind === 'interval' ? ['kind', 'seconds']
    : kind === 'calendar' ? ['kind', 'cron', 'timezone', 'misfire']
      : kind === 'watch' ? ['kind', 'paths']
        : kind === 'poll' ? ['kind', 'everySeconds', 'check']
          : kind === 'script' ? ['kind', 'mode', 'command', 'everySeconds', 'timeoutSeconds', 'permission'] : ['kind'];
  knownKeys(raw, fields, `source (${kind})`);
  if (kind === 'script') {
    if (!['poll', 'daemon'].includes(raw.mode)) fail('source.mode must be poll or daemon');
    if (!Array.isArray(raw.command) || !raw.command.length || raw.command.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !raw.command[0].trim()) fail('source.command must be a non-empty argv array');
    const permission = raw.permission ?? 'read-only';
    if (!['read-only', 'workspace-write'].includes(permission)) fail('source.permission must be read-only or workspace-write');
    if (raw.mode === 'daemon' && (raw.everySeconds !== undefined || raw.timeoutSeconds !== undefined)) fail('daemon sources do not accept everySeconds or timeoutSeconds');
    return { kind, mode: raw.mode, command: raw.command, permission, ...(raw.mode === 'poll' ? { everySeconds: positiveInteger(raw.everySeconds, 'source.everySeconds'), timeoutSeconds: positiveInteger(raw.timeoutSeconds ?? 60, 'source.timeoutSeconds') } : {}) };
  }
  if (kind === 'interval') return { kind, seconds: positiveInteger(raw.seconds, 'source.seconds') };
  if (kind === 'calendar') {
    const cron = nonEmptyString(raw.cron, 'source.cron');
    const timezone = raw.timezone === undefined ? Intl.DateTimeFormat().resolvedOptions().timeZone : nonEmptyString(raw.timezone, 'source.timezone');
    const misfire = raw.misfire ?? 'run-once';
    if (!['run-once', 'skip'].includes(misfire)) fail('source.misfire must be run-once or skip');
    validateCalendar(cron, timezone);
    return { kind, cron, timezone, misfire };
  }
  if (kind === 'watch') {
    if (!Array.isArray(raw.paths) || raw.paths.length === 0) fail('source.paths must be a non-empty list of paths');
    return { kind, paths: raw.paths.map((path, index) => nonEmptyString(path, `source.paths[${index}]`)) };
  }
  if (kind === 'poll') {
    return { kind, everySeconds: positiveInteger(raw.everySeconds, 'source.everySeconds'), check: nonEmptyString(raw.check, 'source.check') };
  }
  return { kind };
}

/**
 * Validate one raw definition into the normalized shape.
 * @param raw - the parsed YAML/JSON body.
 * @param meta - where it came from: `{ origin, path }`.
 * @returns the normalized definition.
 * @throws {TriggerConfigError} with a user-facing message.
 */
export function normalizeTrigger(raw, { origin, path } = {}) {
  if (!isPlainObject(raw)) fail('a trigger definition must be a mapping');
  knownKeys(raw, ['id', 'enabled', 'source', 'workspace', 'prompt', 'preset', 'permission', 'model', 'effort', 'session', 'goal', 'limits', 'overlap', 'notify'], 'the definition');
  const id = nonEmptyString(raw.id, 'id');
  if (!ID_PATTERN.test(id)) fail('id must start with a letter or digit and use only a-z, 0-9, dot, underscore or dash');
  const workspace = nonEmptyString(raw.workspace, 'workspace');
  if (!isAbsolute(workspace)) fail('workspace must be an absolute path: a triggered session binds to it and cannot change folders');
  const prompt = nonEmptyString(raw.prompt, 'prompt');
  const enabled = raw.enabled === undefined ? DEFAULTS.enabled : raw.enabled;
  if (typeof enabled !== 'boolean') fail('enabled must be true or false');

  const permission = raw.permission === undefined ? DEFAULTS.permission : nonEmptyString(raw.permission, 'permission');
  if (!UNATTENDED_PERMISSIONS.includes(permission)) {
    fail(`permission must be one of: ${UNATTENDED_PERMISSIONS.join(', ')} — an unattended run cannot ask for approval`);
  }

  const session = raw.session === undefined ? { mode: 'new' } : raw.session;
  if (!isPlainObject(session)) fail('session must be an object with mode: new or persistent');
  knownKeys(session, ['mode'], 'session');
  if (!['new', 'persistent'].includes(session.mode)) fail('session.mode must be new or persistent');

  const goal = raw.goal;
  if (!isPlainObject(goal)) fail('goal must be an object with the objective to finish');
  knownKeys(goal, ['objective', 'maxRounds'], 'goal');
  const objective = nonEmptyString(goal.objective, 'goal.objective');
  const maxRounds = goal.maxRounds === undefined ? DEFAULTS.maxGoalRounds : positiveInteger(goal.maxRounds, 'goal.maxRounds');

  const limits = raw.limits === undefined ? {} : raw.limits;
  if (!isPlainObject(limits)) fail('limits must be an object');
  knownKeys(limits, ['timeoutSeconds', 'maxRunsPerDay', 'minIntervalSeconds', 'maxCostUsd'], 'limits');
  const timeoutSeconds = limits.timeoutSeconds === undefined ? DEFAULTS.timeoutSeconds : positiveInteger(limits.timeoutSeconds, 'limits.timeoutSeconds');
  const maxRunsPerDay = limits.maxRunsPerDay === undefined ? DEFAULTS.maxRunsPerDay : positiveInteger(limits.maxRunsPerDay, 'limits.maxRunsPerDay');
  const minIntervalSeconds = limits.minIntervalSeconds === undefined ? DEFAULTS.minIntervalSeconds : positiveInteger(limits.minIntervalSeconds, 'limits.minIntervalSeconds');
  const maxCostUsd = limits.maxCostUsd === undefined ? undefined : positiveNumber(limits.maxCostUsd, 'limits.maxCostUsd');

  const overlap = session.mode === 'persistent' ? 'queue' : OVERLAP;
  if (raw.overlap !== undefined && raw.overlap !== overlap) fail(`overlap must be "${overlap}" for session.mode ${session.mode}`);
  if (raw.notify !== undefined && raw.notify !== NOTIFY) fail(`notify must be "${NOTIFY}"`);

  const source = normalizeSource(raw.source);
  return {
    id, enabled, source, workspace, prompt,
    preset: raw.preset === undefined ? DEFAULTS.preset : nonEmptyString(raw.preset, 'preset'),
    permission,
    ...(raw.model === undefined ? {} : { model: nonEmptyString(raw.model, 'model') }),
    ...(raw.effort === undefined ? {} : { effort: nonEmptyString(raw.effort, 'effort') }),
    goal: { objective, maxRounds },
    limits: { timeoutSeconds, maxRunsPerDay, minIntervalSeconds, ...(maxCostUsd === undefined ? {} : { maxCostUsd }) },
    session: { mode: session.mode },
    overlap,
    notify: NOTIFY,
    origin: origin ?? 'user',
    path: path ?? '',
  };
}

/** Parse one file body: JSON or YAML by extension, YAML as the general form. */
function parseBody(text, path) {
  if (/\.json$/iu.test(path)) {
    try { return JSON.parse(text); } catch (error) { fail(`not valid JSON: ${error.message}`); }
  }
  try { return parseYaml(text); } catch (error) { fail(`not valid YAML: ${error.message}`); }
}

/** Read one directory of definitions, returning definitions and problems. */
function readDirectory(directory, origin) {
  const definitions = [];
  const problems = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    // Absent is normal (most machines and projects have no triggers); anything
    // else must be reported, or a permission problem reads as "none defined".
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
      problems.push({ path: directory, message: `cannot read the trigger directory: ${error?.code ?? error?.message ?? error}` });
    }
    return { definitions, problems };
  }
  for (const entry of entries.sort()) {
    if (!/\.(ya?ml|json)$/iu.test(entry)) continue;
    const path = join(directory, entry);
    try {
      const normalized = normalizeTrigger(parseBody(readFileSync(path, 'utf8'), path), { origin, path });
      if (normalized.id !== entry.replace(/\.(ya?ml|json)$/iu, '')) {
        fail(`id "${normalized.id}" must match the file name ("${entry}")`);
      }
      definitions.push(normalized);
    } catch (error) {
      problems.push({ path, message: error instanceof TriggerConfigError ? error.message : String(error?.message ?? error) });
    }
  }
  return { definitions, problems };
}

/**
 * Discover trigger definitions. User-level files live under `<state>/triggers/`;
 * project files under `<workspace>/.dsh/triggers/` and win on an id collision, so
 * a repository can pin its own definition and have it reviewed in a pull request.
 * @param options - `{ home, workspace }`; either may be absent.
 * @returns `{ definitions, problems }`, definitions sorted by id.
 */
export function loadTriggerDefinitions({ home, workspace } = {}) {
  const user = home === undefined ? { definitions: [], problems: [] } : readDirectory(join(home, 'triggers'), 'user');
  const project = workspace === undefined ? { definitions: [], problems: [] } : readDirectory(join(resolve(workspace), '.dsh', 'triggers'), 'project');
  const byId = new Map();
  for (const definition of user.definitions) byId.set(definition.id, definition);
  for (const definition of project.definitions) byId.set(definition.id, { ...definition, overrides: byId.has(definition.id) });
  return {
    definitions: [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    problems: [...user.problems, ...project.problems],
  };
}

/** The newest run in one line; `formatRun` in log.mjs owns the vocabulary. */
function formatLastRun(record) {
  const when = new Date(record.startedAt).toISOString().replace('T', ' ').slice(0, 19);
  const reason = record.reason === null || record.reason === undefined ? '' : ` (${record.reason})`;
  return `${when} ${record.outcome}${reason} · exit ${record.exitCode}`;
}

/** One line, bounded: a listing row must never be forged out of a value. */
const inline = (text, limit = 96) => {
  const folded = String(text).replace(/\s+/gu, ' ').trim();
  return folded.length > limit ? `${folded.slice(0, limit - 1)}…` : folded;
};

/**
 * One definition as the text `/triggers` prints.
 * @param definition - a normalized definition.
 * @param options - `{ lastRun }`: the newest run record, when the log has one.
 * @returns the aligned block.
 */
export function formatTrigger(definition, { lastRun } = {}) {
  const source = definition.source.kind === 'interval' ? `every ${definition.source.seconds}s`
    : definition.source.kind === 'calendar' ? `cron ${definition.source.cron} (${definition.source.timezone}, ${definition.source.misfire})`
      : definition.source.kind === 'watch' ? `watch ${definition.source.paths.join(', ')}`
        : definition.source.kind === 'poll' ? `poll ${definition.source.everySeconds}s: ${definition.source.check}`
          : definition.source.kind === 'script' ? `script ${definition.source.mode}: ${definition.source.command.join(' ')}` : 'external (emit only)';
  return [
    `${definition.enabled ? 'on ' : 'off'} ${definition.id}${definition.overrides ? ' (project overrides user)' : ''}`,
    `    source:    ${source}`,
    `    workspace: ${definition.workspace}`,
    `    session:   ${definition.session?.mode ?? 'new'}`,
    `    goal:      ${inline(definition.goal.objective)} (max ${definition.goal.maxRounds} rounds)`,
    `    prompt:    ${inline(definition.prompt)}`,
    `    limits:    ${definition.limits.timeoutSeconds}s, ${definition.limits.maxRunsPerDay}/day${definition.limits.maxCostUsd === undefined ? '' : `, $${definition.limits.maxCostUsd}`}`,
    `    run as:    ${definition.preset}/${definition.permission}${definition.model === undefined ? '' : ` · ${definition.model}`}`,
    `    file:      ${definition.path === '' ? '(unknown)' : definition.path}`,
    ...(lastRun === undefined ? [] : [`    last:      ${formatLastRun(lastRun)}`]),
  ].join('\n');
}
