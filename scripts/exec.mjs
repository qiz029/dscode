// `dscode exec`: run one prompt through the full dscode agent without the TUI,
// stream the reply to stdout, and exit with the turn's outcome. Tool activity
// and the session id go to stderr so stdout stays pipeable.
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, provision, runDsh, runtimeHome } from './harness.mjs';
import { parseExecArgs, execOverlay, readStream, USAGE } from '../plugins/exec/cli.mjs';

export { parseExecArgs, execOverlay, readStream, USAGE };


export async function runExec(argv, { home = process.env.DSCODE_EXEC_HOME ?? runtimeHome, stdin = process.stdin, stdout = 'inherit', stderr = 'inherit' } = {}) {
  const options = parseExecArgs(argv);
  if (options.help) { process.stdout.write(USAGE + '\n'); return 0; }
  const prompt = options.prompt && options.prompt !== '-' ? options.prompt : await readStream(stdin);
  if (!prompt.trim()) throw new Error('Prompt is empty. Pass it as an argument or on stdin.');
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  provision(home);
  const cwd = realpathSync(resolve(options.cwd ?? process.cwd()));
  const scratch = mkdtempSync(join(tmpdir(), 'dscode-exec-'));
  try {
    const promptFile = join(scratch, 'prompt.txt');
    const optionsFile = join(scratch, 'options.json');
    const overlay = join(scratch, 'exec.patch.yml');
    writeFileSync(promptFile, prompt);
    writeFileSync(optionsFile, JSON.stringify({ promptFile, cwd, model: options.model, effort: options.effort, permission: options.permission, approveAll: options.approveAll, resume: options.resume, json: options.json, quiet: options.quiet, timeoutMs: options.timeoutMs }));
    writeFileSync(overlay, execOverlay(join(root, 'plugins/exec/index.mjs')));
    const overlays = [];
    for (const file of ['mcp.local.yml', 'harness.local.yml']) {
      const path = join(root, 'config', file);
      if (existsSync(path)) overlays.push('--patch', path);
    }
    const child = runDsh([...overlays, '--patch', overlay, ...options.patches.flatMap(path => ['--patch', resolve(path)])], { home, cwd, stdio: ['ignore', stdout, stderr], env: { DSCODE_EXEC_OPTIONS: optionsFile } });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
    return await new Promise((resolveExit, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => resolveExit(code ?? (signal ? 130 : 0)));
    });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runExec(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
