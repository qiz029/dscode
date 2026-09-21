// The portable half of `dscode trigger`: argument parsing, deciding, recording,
// and the read-only or file-editing commands. It imports nothing from the
// launcher or the harness, so the same module serves a source checkout
// (scripts/trigger.mjs supplies the spawning) and the published launcher (which
// ships this file and supplies its own).
//
// Everything that needs a process — spawning the Host, calling launchctl — is
// injected, which is also what makes the whole command testable.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadTriggerDefinitions, formatTrigger } from './config.mjs';
import { formatEvent, emitEvent, listEvents, consumeEvent } from './spool.mjs';
import { appendRun, formatRun, readRuns, writeRunTail } from './log.mjs';
import { finishTriggerRun, planTriggerRun, releaseTriggerRun } from './run.mjs';
import { renderPrompt } from './options.mjs';
import { evaluateCheck } from './poll.mjs';
import { agentPath, crontabLine, launchAgent } from './launchd.mjs';

export const USAGE = `Usage: dscode trigger <command> [options]

Commands:
  run <id>              Start one run now (respecting the trigger's limits)
  fire <id>             Post an event and run it: --text "..." or --event FILE
  emit <id>             Only post an event for the next drain
  events [id]           Print the events waiting in a trigger's spool
  list                  List the trigger definitions and their last outcome
  show <id>             Print one definition
  log [id]              Print recorded runs, newest first (--failed for failures only)
  new <id>              Write a starter definition into the project
  enable|disable <id>   Set the definition's enabled flag in its own file
  install <id>          Schedule the trigger with launchd (or print the crontab)
  uninstall <id>        Remove the schedule

Options:
  --event FILE          Event body as JSON; "-" reads stdin
  --text TEXT           Event body text (with "fire"/"emit")
  --event-id ID         Identity of the posted event; retry with the same one
  --workspace DIR       Workspace for "new" (default: the project directory)
  --project DIR         Project whose .dsh/triggers definitions are read (default: cwd)
  -h, --help            Show this help

Exit codes are the run's: 0 completed, skipped or nothing to do; 1 failed;
2 round or cost cap; 3 the goal is blocked or paused; 124 timeout; 130 interrupted.
An orderly stop writes a result file; only a Host that died leaves none behind.`;

const COMMANDS = ['run', 'fire', 'emit', 'events', 'list', 'show', 'log', 'new', 'enable', 'disable', 'install', 'uninstall'];

/** Parse the arguments after `trigger`. */
export function parseTriggerArgs(argv) {
  const options = { command: '', id: '', event: undefined, text: undefined, eventId: undefined, project: undefined, workspace: undefined, failed: false, help: false, error: undefined };
  const words = [...argv];
  options.command = words.shift() ?? '';
  if (options.command === '' || options.command === '--help' || options.command === '-h') { options.help = true; return options; }
  if (!COMMANDS.includes(options.command)) { options.error = `unknown command "${options.command}"`; return options; }
  if (['list', 'log'].includes(options.command)) {
    if (words.length > 0 && !words[0].startsWith('-')) options.id = words.shift();
  } else {
    const id = words.shift() ?? '';
    if (id === '' || id.startsWith('-')) { options.error = `${options.command} needs a trigger id`; return options; }
    options.id = id;
  }
  while (words.length > 0) {
    const flag = words.shift();
    const value = () => { const next = words.shift(); if (next === undefined) { options.error = `${flag} needs a value`; return undefined; } return next; };
    if (flag === '--event') { const next = value(); if (next === undefined) return options; options.event = next; continue; }
    if (flag === '--text') { const next = value(); if (next === undefined) return options; options.text = next; continue; }
    if (flag === '--event-id') { const next = value(); if (next === undefined) return options; options.eventId = next; continue; }
    if (flag === '--project') { const next = value(); if (next === undefined) return options; options.project = next; continue; }
    if (flag === '--workspace') { const next = value(); if (next === undefined) return options; options.workspace = next; continue; }
    if (flag === '--failed') { options.failed = true; continue; }
    if (flag === '-h' || flag === '--help') { options.help = true; return options; }
    options.error = `unknown option "${flag}"`;
    return options;
  }
  return options;
}

/**
 * The identity of a firing the scheduler produced. It must be stable per cadence
 * window, not per invocation: a replayed or duplicated scheduler tick inside the
 * same window has to be recognised as the same firing, which is what the run
 * decision de-duplicates on. External producers pass their own id instead.
 * @param definition - a normalized definition.
 * @param now - the invocation time.
 * @returns an identity string recorded with the run.
 */
export function firingIdentity(definition, now) {
  const minute = new Date(now).toISOString().slice(0, 16);
  switch (definition.source.kind) {
    case 'interval': return `interval:${Math.floor(now / (definition.source.seconds * 1000))}`;
    case 'poll': return `poll:${Math.floor(now / (definition.source.everySeconds * 1000))}`;
    case 'calendar': return `calendar:${minute}`;
    // A file event has no payload of its own, so changes inside one minute
    // collapse into one run rather than firing a session per touched file.
    case 'watch': return `watch:${minute}`;
    default: return `manual:${new Date(now).toISOString()}`;
  }
}

/** The state directory: the child gets it as DSH_HOME, so all three agree. */
export function stateHome(env = {}) {
  const value = env.DSH_HOME ?? env.DSCODE_HOME;
  return value === undefined ? undefined : resolve(value);
}

/** A starter definition a person can edit; the file name must equal the id. */
export function scaffoldTrigger(id, { workspace }) {
  return [
    `id: ${id}`,
    `workspace: ${workspace}`,
    'prompt: describe what this run should do',
    'source: { kind: interval, seconds: 300 }',
    'goal: { objective: describe the finished state, maxRounds: 20 }',
    'limits: { timeoutSeconds: 1800, maxRunsPerDay: 24, minIntervalSeconds: 60 }',
    '',
  ].join('\n');
}

/**
 * Set the `enabled` flag in one definition file's text, preserving everything
 * else byte for byte: these files are hand-written and reviewed in a pull
 * request, so an edit must not reformat them.
 * @param text - the file's current text.
 * @param enabled - the value to set.
 * @returns the new text.
 */
export function setEnabledFlag(text, enabled) {
  // Matching a top-level line is only safe for a single-document file: a second
  // document could carry its own `id:` and be edited instead of this one.
  if (/^(?:---|\.\.\.)\s*$/mu.test(text.replace(/^---\s*\n/u, ''))) {
    throw new Error('this file holds more than one YAML document; set "enabled" by hand');
  }
  const line = `enabled: ${enabled ? 'true' : 'false'}`;
  const next = /^enabled:[^\n]*$/mu.test(text) ? text.replace(/^enabled:[^\n]*$/mu, line)
    : (() => {
      const idLine = /^id:[^\n]*$/mu.exec(text);
      return idLine === null ? `${line}\n${text}`
        : `${text.slice(0, idLine.index + idLine[0].length)}\n${line}${text.slice(idLine.index + idLine[0].length)}`;
    })();
  // The edit is a line match, so prove what it did: parse both sides and require
  // every other top-level key to be untouched. A quoted multi-line scalar can put
  // a column-0 `id:`/`enabled:` line inside a value, which the match alone cannot
  // tell from a key — this catches it instead of corrupting the prompt.
  if (!sameExceptEnabled(text, next, enabled)) {
    throw new Error('refusing to edit: the change would alter more than the enabled flag; set it by hand');
  }
  return next;
}

/** True when two definition texts parse to the same mapping apart from `enabled`. */
function sameExceptEnabled(before, after, enabled) {
  const canonical = value => JSON.stringify(Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ));
  try {
    return canonical({ ...parseYaml(before), enabled }) === canonical(parseYaml(after));
  } catch {
    return false;
  }
}

/** Read an event body from a file, stdin, or the `--text` shorthand. */
async function readEventBody(options, stdin) {
  if (options.text !== undefined) return { text: options.text, source: 'cli' };
  if (options.event === undefined) return undefined;
  const fromStdin = options.event === '-';
  const raw = fromStdin ? await readStream(stdin) : readFileSync(options.event, 'utf8');
  if (raw.trim() === '') throw new Error(`${fromStdin ? 'stdin' : options.event} is empty: an event body is required`);
  try {
    const body = JSON.parse(raw);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('it must be a JSON object');
    return body;
  } catch (error) {
    throw new Error(`${fromStdin ? 'stdin' : options.event} is not a valid event body: ${error?.message ?? error}`, { cause: error });
  }
}

export function readStream(stream) {
  return new Promise((resolveRead, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => { text += chunk; });
    stream.on('end', () => resolveRead(text));
    stream.on('error', reject);
  });
}

/** Resolve one definition by id from the user and project layers. */
function findDefinition(home, project, id) {
  const { definitions, problems } = loadTriggerDefinitions({ home, workspace: project });
  const definition = definitions.find(entry => entry.id === id);
  if (definition === undefined) {
    const known = definitions.map(entry => entry.id).join(', ') || '(none)';
    throw new Error(`no trigger "${id}" in ${join(home ?? '', 'triggers')} or ${join(project, '.dsh', 'triggers')}; known ids: ${known}${problems.length === 0 ? '' : ` (${problems.length} unreadable definition file(s))`}`);
  }
  return definition;
}

/** Map a bare exit code to a record when the Host could not report one. */
export function outcomeForCode(code) {
  if (!Number.isSafeInteger(code)) return { outcome: 'failed', reason: 'interrupted' };
  if (code === 0) return { outcome: 'completed', reason: null };
  if (code === 2) return { outcome: 'overrun', reason: 'round_cap' };
  if (code === 3) return { outcome: 'blocked', reason: 'goal_blocked' };
  if (code === 124) return { outcome: 'timedout', reason: 'timeout' };
  if (code === 130) return { outcome: 'failed', reason: 'interrupted' };
  return { outcome: 'failed', reason: 'model_error' };
}

/**
 * Record a decision that started no session, before any lock was taken.
 * @returns the exit code, always 0: a skip is not a failure.
 */
function recordSkip(home, definition, { reason, eventId, now }) {
  appendRun(home, {
    triggerId: definition.id, runId: `skip-${now}`, startedAt: now, endedAt: now,
    eventId, outcome: 'skipped', reason, exitCode: 0, cwd: definition.workspace,
  });
  return 0;
}

/**
 * Record a run that WAS locked but started no session (a poll with nothing to
 * do). It must go through `finishTriggerRun` with that same handle, or the lock
 * outlives the attempt and every later drain reads `already_running`.
 * @returns the exit code, always 0: nothing to do is not a failure.
 */
function recordLockedSkip(home, definition, handle, { reason, eventId, details, now }) {
  const record = finishTriggerRun(home, handle, { outcome: 'skipped', reason, exitCode: 0, eventId, endedAt: now });
  if (details !== undefined && details !== '') {
    try { writeRunTail(home, definition.id, record.runId, details); } catch { /* the record still explains the skip */ }
  }
  return 0;
}

/** Run the CLI. `deps` supplies the process-facing parts; see the module header. */
export async function runTriggerCli(argv, deps = {}) {
  const options = parseTriggerArgs(argv);
  const out = text => (deps.stdout ?? process.stdout).write(text + '\n');
  const err = text => (deps.stderr ?? process.stderr).write(text + '\n');
  if (options.help) { out(USAGE); return 0; }
  if (options.error !== undefined) { err(options.error); err(USAGE); return 1; }

  const home = stateHome(deps.home === undefined ? process.env : { DSH_HOME: deps.home });
  if (home === undefined) { err('dscode trigger needs a state directory: set DSH_HOME or DSCODE_HOME'); return 1; }
  const project = resolve(options.project ?? deps.project ?? process.cwd());
  const now = deps.now ?? Date.now();
  const platform = deps.platform ?? process.platform;
  // No fallback: the driver always knows its own entry point, and guessing here
  // would write a schedule that runs the wrong program (or a module launchd
  // cannot execute at all).
  const dscodePath = deps.dscodePath;
  const launchctl = deps.launchctl;

  // A CLI function returns an exit code: an unknown id, an unreadable definition
  // or a missing workspace is a user-facing message, not a thrown stack.
  try {
    if (options.command === 'list') {
      const { definitions, problems } = loadTriggerDefinitions({ home, workspace: project });
      if (definitions.length === 0 && problems.length === 0) { out('No triggers defined.'); return 0; }
      for (const definition of definitions) out(formatTrigger(definition, { lastRun: readRuns(home, { triggerId: definition.id, limit: 1 })[0] }));
      for (const problem of problems) err(`${problem.path}: ${problem.message}`);
      return problems.length === 0 ? 0 : 1;
    }
    if (options.command === 'show') {
      const definition = findDefinition(home, project, options.id);
      out(formatTrigger(definition, { lastRun: readRuns(home, { triggerId: definition.id, limit: 1 })[0] }));
      return 0;
    }
    if (options.command === 'log') {
      const all = readRuns(home, options.id === '' ? {} : { triggerId: options.id });
      const runs = options.failed ? all.filter(run => run.outcome !== 'completed' && run.outcome !== 'skipped') : all;
      if (runs.length === 0) out(options.failed ? 'No failed runs recorded.' : 'No runs recorded.');
      else for (const run of runs) out(`${run.triggerId} ${formatRun(run)}`);
      return 0;
    }
    if (options.command === 'events') {
      if (options.id === '') {
        const { definitions } = loadTriggerDefinitions({ home, workspace: project });
        let total = 0;
        for (const definition of definitions) for (const event of listEvents(home, definition.id)) { out(`${definition.id} ${formatEvent(event)}`); total += 1; }
        if (total === 0) out('No pending events.');
        return 0;
      }
      const pending = listEvents(home, options.id);
      if (pending.length === 0) out(`No pending events for ${options.id}.`);
      else for (const event of pending) out(formatEvent(event));
      return 0;
    }
    if (options.command === 'new') {
      const directory = join(project, '.dsh', 'triggers');
      const path = join(directory, `${options.id}.yml`);
      if (existsSync(path)) { err(`${path} already exists`); return 1; }
      const workspace = resolve(options.workspace ?? project);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, scaffoldTrigger(options.id, { workspace }), { mode: 0o644 });
      out(`wrote ${path}`);
      out('Edit the prompt, the goal objective and the source, then run it with: dscode trigger run ' + options.id);
      return 0;
    }
    if (options.command === 'enable' || options.command === 'disable') {
      const definition = findDefinition(home, project, options.id);
      if (definition.path === '') { err(`cannot edit ${options.id}: its definition path is unknown`); return 1; }
      const enabled = options.command === 'enable';
      const text = readFileSync(definition.path, 'utf8');
      const next = setEnabledFlag(text, enabled);
      if (next !== text) writeFileSync(definition.path, next, { mode: 0o644 });
      out(`${enabled ? 'enabled' : 'disabled'} ${options.id} in ${definition.path}`);
      return 0;
    }
    if (options.command === 'install' || options.command === 'uninstall') {
      const definition = findDefinition(home, project, options.id);
      const path = agentPath(home, definition.id);
      if (options.command === 'uninstall') {
        if (launchctl !== undefined && platform === 'darwin') await launchctl(['bootout', `gui/${process.getuid?.() ?? ''}/${'ai.dscode.trigger.' + definition.id}`], { ignoreFailure: true });
        rmSync(path, { force: true });
        out(`removed the schedule for ${options.id} (${path})`);
        return 0;
      }
      if (dscodePath === undefined) {
        err(`cannot install ${options.id}: this build does not know its own dscode program path`);
        return 1;
      }
      // launchd executes the program directly: it must be a real, executable file.
      let runnable = existsSync(dscodePath);
      if (runnable) {
        try { runnable = (statSync(dscodePath).mode & 0o111) !== 0; } catch { runnable = false; }
      }
      if (!runnable) {
        err(`cannot install ${options.id}: ${dscodePath} is not an executable file, and launchd runs no shell profile`);
        return 1;
      }
      const plist = launchAgent(definition, { home, dscodePath, project });
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, plist, { mode: 0o600 });
      out(`wrote ${path}`);
      if (platform !== 'darwin' || launchctl === undefined) {
        out('launchd is not available here; add this line to crontab instead:');
      } else {
        await launchctl(['bootout', `gui/${process.getuid?.() ?? ''}/ai.dscode.trigger.${definition.id}`], { ignoreFailure: true });
        await launchctl(['bootstrap', `gui/${process.getuid?.() ?? ''}`, path]);
        out(`loaded ${'ai.dscode.trigger.' + definition.id} into launchd; the crontab equivalent is:`);
      }
      out(`  ${crontabLine(definition, { dscodePath, project })}`);
      return 0;
    }

    const definition = findDefinition(home, project, options.id);
    if (options.command === 'emit') {
      const body = (await readEventBody(options, deps.stdin ?? process.stdin)) ?? {};
      const event = emitEvent(home, definition.id, { source: 'cli', ...body }, { eventId: options.eventId ?? deps.eventId ?? `manual-${new Date(now).toISOString()}`, now });
      out(`posted ${event.eventId} to ${definition.id} (${listEvents(home, definition.id).length} pending)`);
      return 0;
    }
    let fired;
    if (options.command === 'fire') {
      const body = (await readEventBody(options, deps.stdin ?? process.stdin)) ?? {};
      fired = emitEvent(home, definition.id, { source: 'cli', ...body }, { eventId: options.eventId ?? deps.eventId ?? `fire-${new Date(now).toISOString()}`, now });
    }

    const pending = listEvents(home, definition.id);
    const wanted = options.eventId ?? deps.eventId;
    const matching = wanted === undefined ? undefined : pending.find(event => event.eventId === wanted);
    if (wanted !== undefined && fired === undefined && matching === undefined) {
      // Naming an identity that is not waiting would otherwise run the trigger
      // with no event payload at all, which is never what the caller meant.
      err(`no pending event "${wanted}" for ${definition.id}; post it with "emit", or omit --event-id`);
      return 1;
    }
    const chosen = fired ?? matching ?? (wanted === undefined ? pending[0] : undefined);
    const eventId = chosen?.eventId ?? wanted ?? firingIdentity(definition, now);
    const plan = planTriggerRun(definition, { home, now, eventId });
    if (plan.action === 'skip') {
      err(`skipped ${definition.id}: ${plan.reason}`);
      return recordSkip(home, definition, { reason: plan.reason, eventId, now });
    }

    // A poll source only runs when its predicate says there is work; without a
    // resident listener this scheduled invocation IS the poll.
    if (definition.source.kind === 'poll') {
      const check = await evaluateCheck(definition.source.check, { cwd: definition.workspace, timeoutMs: 60000, ...(deps.spawnCheck === undefined ? {} : { spawn: deps.spawnCheck }) });
      if (!check.matched) {
        err(`nothing to do for ${definition.id} (${check.code === null ? 'the check did not finish' : `check exited ${check.code}`})`);
        return recordLockedSkip(home, definition, plan.handle, { reason: 'no_match', eventId, details: check.output, now });
      }
    }

    const spec = {
      triggerId: definition.id,
      runId: plan.handle.runId,
      workspace: definition.workspace,
      prompt: renderPrompt(definition.prompt, chosen),
      preset: definition.preset,
      permission: definition.permission,
      ...(definition.model === undefined ? {} : { model: definition.model }),
      ...(definition.effort === undefined ? {} : { effort: definition.effort }),
      goal: { objective: definition.goal.objective, maxRounds: definition.goal.maxRounds },
      limits: definition.limits,
      eventId,
    };
    let code;
    let result;
    try {
      ({ code, result } = await (deps.spawnRun ?? missingSpawn)({ spec, home, cwd: definition.workspace }));
    } catch (error) {
      // The Host never ran, so the event is still pending and the lock must not
      // outlive the attempt: a later drain should be free to try it again.
      releaseTriggerRun(home, plan.handle);
      throw error;
    }
    // Consumed only once the Host has actually run: a failure before that leaves
    // the event pending rather than dropping it.
    if (chosen !== undefined) consumeEvent(home, definition.id, chosen.eventId);
    const fallback = outcomeForCode(code);
    const record = finishTriggerRun(home, plan.handle, {
      outcome: result?.outcome ?? fallback.outcome,
      reason: result?.reason ?? fallback.reason,
      // A Host killed by a signal reports no code; the record still needs one.
      exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : (Number.isSafeInteger(code) ? code : 130),
      sessionId: result?.sessionId ?? null,
      cost: result?.cost ?? null,
      rounds: result?.rounds ?? null,
      eventId,
      endedAt: Date.now(),
    });
    out(`${definition.id} ${formatRun(record)}${record.sessionId === null ? '' : ` · ${record.sessionId}`}`);
    return record.exitCode;
  } catch (error) {
    err(error?.message ?? String(error));
    return 1;
  }
}

/** The launcher and the source driver both must inject a spawn. */
function missingSpawn() {
  throw new Error('this build has no way to start a run: inject spawnRun');
}
