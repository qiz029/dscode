import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookEvents, validateHooks } from './hooks.mjs';
import { enabledFlag } from './workspace-discovery.mjs';

// Project hook files layer on top of the installation file by default. They run as
// the OS user outside tool approval, so a cloned repository can install gates;
// DSCODE_PROJECT_HOOKS=0/off/false loads the installation file alone.
// `.codex/hooks.json` and `.dsh/hooks.json` are the bridge's own shape;
// `.claude/settings.json` keeps hooks under a top-level `hooks` key and is skipped
// when that key is absent.
export const projectHookFiles = Object.freeze([
  { path: '.codex/hooks.json' },
  { path: '.dsh/hooks.json' },
  { path: '.claude/settings.json', nested: true },
]);

export const resolvedHookFile = 'hooks.resolved.json';
export const hookReportFile = 'hooks.resolved.report.json';

export function projectHooksEnabled(env = process.env) {
  const value = env.DSCODE_PROJECT_HOOKS;
  return value === undefined ? true : enabledFlag(value);
}

function extractHooks(parsed, nested) {
  const hooks = parsed?.hooks !== undefined ? parsed.hooks : (nested ? undefined : parsed);
  if (hooks === undefined) return undefined;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('hooks must be an event map');
  return hooks;
}

// The installation file is trusted and must fail loudly on anything this bridge
// cannot run.
export function readInstallationHooks(path) {
  return validateHooks(JSON.parse(readFileSync(path, 'utf8')));
}

// A project file is only filtered: a Claude Code settings.json routinely carries
// events this bridge does not implement, and skipping them must not stop dscode
// from starting. Every skip is reported so it is visible rather than silent.
export function readProjectHooks(path, { nested = false } = {}) {
  const hooks = extractHooks(JSON.parse(readFileSync(path, 'utf8')), nested);
  if (hooks === undefined) return undefined;
  const kept = {};
  const skipped = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!hookEvents.includes(event)) { skipped.push(event); continue; }
    // A project file is untrusted input: a gate this bridge cannot run is dropped
    // with its reason rather than allowed to stop dscode from starting.
    try {
      validateHooks({ hooks: { [event]: groups } });
    } catch (error) {
      const reason = error.message.startsWith(`${event}: `) ? error.message.slice(event.length + 2) : error.message;
      skipped.push(`${event} (${reason})`);
      continue;
    }
    kept[event] = groups;
  }
  return { hooks: Object.keys(kept).length ? kept : undefined, skipped };
}

export function resolveHookSources({ root, cwd = root, env = process.env }) {
  const installation = join(root, 'config/hooks.local.json');
  const sources = [{ path: installation, hooks: readInstallationHooks(installation) }];
  const skipped = [];
  if (!projectHooksEnabled(env)) return { sources, skipped };
  for (const file of projectHookFiles) {
    const path = join(cwd, file.path);
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = readProjectHooks(path, file);
    } catch (error) {
      // Unreadable JSON (a Claude settings file may even carry comments) is a
      // report, not a startup failure, for a file dscode did not write.
      skipped.push({ path: file.path, events: [`(not loaded: ${error.message})`] });
      continue;
    }
    if (!parsed) continue;
    if (parsed.skipped.length) skipped.push({ path: file.path, events: parsed.skipped });
    if (parsed.hooks) sources.push({ path, hooks: parsed.hooks });
  }
  return { sources, skipped };
}

export function mergeHooks(sources) {
  const hooks = {};
  for (const source of sources) {
    for (const [event, groups] of Object.entries(source.hooks ?? {})) hooks[event] = [...(hooks[event] ?? []), ...groups];
  }
  return { hooks };
}

// The pinned bridge takes one config path for the whole process, so layered files
// are merged into a single resolved file. A single source stays where it is edited.
export function writeHookConfig({ root, cwd = root, home, env = process.env }) {
  const { sources, skipped } = resolveHookSources({ root, cwd, env });
  const paths = sources.map(source => source.path);
  const resolved = join(home, resolvedHookFile);
  const report = join(home, hookReportFile);
  if (sources.length === 1) {
    // A stale merge must not outlive the layers it came from: /hooks reads the
    // report, and a leftover one would describe sources that are no longer loaded.
    if (existsSync(resolved)) rmSync(resolved);
    if (existsSync(report)) rmSync(report);
    return { path: sources[0].path, sources: paths, skipped };
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(resolved, JSON.stringify(mergeHooks(sources), null, 2) + '\n', { mode: 0o600 });
  writeFileSync(report, JSON.stringify({ sources: paths, skipped }, null, 2) + '\n', { mode: 0o600 });
  return { path: resolved, sources: paths, skipped };
}
