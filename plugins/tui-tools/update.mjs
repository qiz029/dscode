import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// DSCODE update surface for the TUI: the `/update` command schedules this module as a
// detached helper, which waits for the interactive session to exit and then runs the
// same `dscode update` entry the CLI uses (npm/Hub launcher or tar/source self-update).

export const LAUNCHER_PACKAGE = '@toddzheng024/dscode';
export const REGISTRY_URL = `https://registry.npmjs.org/${LAUNCHER_PACKAGE}/latest`;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/** Whether `candidate` is newer than `current`; a prerelease sorts below its release. */
export function newerVersion(candidate, current) {
  const split = value => {
    const text = String(value);
    const at = text.indexOf('-');
    return { core: (at === -1 ? text : text.slice(0, at)).split('.').map(Number), pre: at === -1 ? '' : text.slice(at + 1) };
  };
  const left = split(candidate), right = split(current);
  for (let index = 0; index < Math.max(left.core.length, right.core.length); index++) {
    const x = left.core[index] ?? 0, y = right.core[index] ?? 0;
    if (x !== y) return x > y;
  }
  if (left.pre === right.pre) return false;
  if (left.pre === '') return true;
  if (right.pre === '') return false;
  return false;
}

/** Newest launcher version on npm, or undefined when the registry cannot be read. */
export async function fetchLatestVersion({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(REGISTRY_URL, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: controller.signal });
    if (!response.ok) return undefined;
    const version = (await response.json())?.version;
    return typeof version === 'string' && VERSION_PATTERN.test(version) ? version : undefined;
  } catch { return undefined; }
  finally { clearTimeout(timer); }
}

/** State directory shared by every install shape, matching the launcher's own default. */
export function stateHome(env = process.env, home = process.env.HOME) {
  return resolve(env.DSH_HOME || env.DSCODE_HOME || join(home ?? '.', '.local/share/dscode-hub'));
}

/**
 * The command that upgrades this installation once no session is running: a sibling
 * `bin/dscode.mjs` for tar and source trees, otherwise the npm launcher from PATH.
 */
export function planUpdate({ moduleUrl, version = 'latest', execPath = process.execPath } = {}) {
  const root = resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
  const entry = join(root, 'bin/dscode.mjs');
  if (existsSync(entry)) return { label: `tar/source ${root}`, command: execPath, args: [entry, 'update', version] };
  if (existsSync(join(root, 'node_modules', LAUNCHER_PACKAGE, 'cli.mjs'))) return { label: 'npm launcher (bundle tree)', command: execPath, args: [join(root, 'node_modules', LAUNCHER_PACKAGE, 'cli.mjs'), 'update', version] };
  return { label: 'npm/Hub launcher from PATH', command: 'dscode', args: ['update', version] };
}

/** Start the detached helper that finishes the update once `pid` (the TUI) exits. */
export function scheduleUpdate({ helperModuleUrl, pid, version = 'latest', env = process.env, spawnImpl = spawn, execPath = process.execPath }) {
  const helper = fileURLToPath(helperModuleUrl);
  const child = spawnImpl(execPath, [helper, String(pid), version], { detached: true, stdio: 'ignore', env });
  child.unref();
  return { helper, log: logPath(stateHome(env)) };
}

export function logPath(home) {
  return join(home, 'update.log');
}

function append(log, text) {
  mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
  appendFileSync(log, text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
}

export async function runUpdateAfterExit({ pid, version = 'latest', home, moduleUrl = import.meta.url, spawnImpl, now = Date.now, sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)), maxWaitMs = 12 * 3600000 } = {}) {
  const log = logPath(home);
  const started = now();
  append(log, `${new Date(started).toISOString()} scheduled: pid ${pid} exit, then ${version}`);
  while (now() - started < maxWaitMs) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) break;
    await sleep(1000);
  }
  await sleep(1500);
  const plan = planUpdate({ moduleUrl, version });
  append(log, `${new Date().toISOString()} running: ${plan.command} ${plan.args.join(' ')} (${plan.label})`);
  const result = await spawnImpl(plan.command, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (output) append(log, output);
  const ok = result.status === 0;
  append(log, `${new Date().toISOString()} ${ok ? 'finished' : `failed with ${result.status ?? result.signal}`}`);
  writeFileSync(join(home, 'update-result.json'), `${JSON.stringify({ version, status: ok ? 'done' : 'failed', code: result.status ?? null, at: new Date().toISOString(), log }, null, 2)}\n`, { mode: 0o600 });
  return { status: ok ? 'done' : 'failed', log };
}

async function main(argv) {
  const [pid, version = 'latest'] = argv;
  const home = stateHome();
  await runUpdateAfterExit({ pid: Number(pid), version, home, moduleUrl: import.meta.url,
    spawnImpl: (command, args, options) => spawnSync(command, args, { ...options, encoding: 'utf8' }) });
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main(process.argv.slice(2)).catch(error => { try { append(logPath(stateHome()), `${new Date().toISOString()} helper failed: ${error.message}`); } catch { /* best effort */ } });
