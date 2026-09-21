// `dscode trigger ...` in a source checkout: the portable CLI core
// (plugins/triggers/cli.mjs) plus the two things it cannot own — starting a Host
// through this installation's Harness, and calling launchctl. The published
// launcher supplies its own versions of both.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, provision, runDsh, runtimeHome } from './harness.mjs';
import { runTriggerCli as runTriggerCore, stateHome, parseTriggerArgs, USAGE } from '../plugins/triggers/cli.mjs';
import { readRunResult, writeRunSpec } from '../plugins/triggers/options.mjs';
import { triggerOverlay } from '../plugins/triggers/overlay.mjs';

export { stateHome, parseTriggerArgs, USAGE };

/**
 * Ask the child to stop when this process is asked to stop.
 * @param child - the spawned Host.
 * @returns a function that removes exactly the listeners this call added.
 */
export function watchSignals(child) {
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => {
    const handler = () => child.kill(signal);
    process.once(signal, handler);
    return [signal, handler];
  });
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
}

/**
 * Start one Host for a spec and read what it reported.
 * @param options - `{ spec, home, cwd, stdio }`.
 * @returns `{ code, result }`; `result` is undefined when the Host died first.
 */
export async function spawnTriggerHost({ spec, home, cwd, stdio = 'inherit' }) {
  const scratch = mkdtempSync(join(tmpdir(), 'dscode-trigger-'));
  try {
    const specPath = join(scratch, 'run.json');
    writeRunSpec(specPath, spec);
    const overlay = join(scratch, 'trigger.patch.yml');
    writeFileSync(overlay, triggerOverlay(join(root, 'plugins/triggers/host.mjs')));
    const overlays = [];
    for (const file of ['mcp.local.yml', 'harness.local.yml']) {
      const path = join(root, 'config', file);
      if (existsSync(path)) overlays.push('--patch', path);
    }
    // The run's cwd is the trigger's workspace: the session binds there and the
    // shell starts there, which is the folder rule the terminal also enforces.
    provision(home, { cwd });
    const child = runDsh([...overlays, '--patch', overlay], { home, cwd, stdio: ['ignore', stdio, stdio], env: { DSCODE_TRIGGER_OPTIONS: specPath } });
    const release = watchSignals(child);
    try {
      const code = await new Promise((resolveExit, reject) => {
        child.on('error', reject);
        child.on('exit', (exitCode, signal) => resolveExit(exitCode ?? (signal ? 130 : 0)));
      });
      return { code, result: readRunResult(`${specPath}.result.json`) };
    } finally {
      release();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Run launchctl, resolving with its exit code unless told to ignore failures. */
export function runLaunchctl(args, { ignoreFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('launchctl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => (ignoreFailure ? resolveRun(1) : reject(error)));
    child.once('exit', code => {
      if (code === 0 || ignoreFailure) { resolveRun(code ?? 0); return; }
      reject(new Error(`launchctl ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Run the CLI with this installation's defaults.
 * @param argv - arguments after `trigger`.
 * @param deps - test/embedding overrides; `home`, `project`, `spawnRun`, `launchctl`, `platform` and `now` pass straight through.
 * @returns the process exit code.
 */
export function runTriggerCli(argv, deps = {}) {
  return runTriggerCore(argv, {
    home: deps.home ?? process.env.DSH_HOME ?? process.env.DSCODE_HOME ?? runtimeHome,
    dscodePath: deps.dscodePath ?? resolve(process.argv[1] ?? 'dscode'),
    launchctl: deps.launchctl ?? runLaunchctl,
    spawnRun: deps.spawnRun ?? spawnTriggerHost,
    ...deps,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runTriggerCli(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
