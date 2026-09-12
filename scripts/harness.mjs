import { spawn } from 'node:child_process';
import { validateHooks } from '../plugins/tui-tools/hooks.mjs';
import { patchRuntime } from './patch-runtime.mjs';
import { provisionPreset } from './preset.mjs';
import { patchTui } from './patch-tui.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
export const runtimeHome = join(root, '.runtime');
export const profileName = 'tui';
export const dshEntry = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
export const chromeEntry = join(root, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js');

export function provision(home = runtimeHome) {
  if (!existsSync(dshEntry)) throw new Error('Dependencies missing. Run npm ci first.');
  patchTui(root);
  patchRuntime(root);
  const presets = provisionPreset(root, home);
  const hooksPath = join(root, 'config/hooks.local.json');
  if (!existsSync(hooksPath)) writeFileSync(hooksPath, '{"hooks": {}}\n', { mode: 0o600, flag: 'wx' });
  validateHooks(JSON.parse(readFileSync(hooksPath, 'utf8')));
  const profile = join(home, 'profiles', profileName);
  mkdirSync(profile, { recursive: true });
  const moduleLink = join(profile, 'node_modules');
  if (existsSync(moduleLink)) {
    if (!lstatSync(moduleLink).isSymbolicLink() || realpathSync(moduleLink) !== realpathSync(join(root, 'node_modules'))) {
      throw new Error(`Refusing to replace an independently managed profile: ${profile}`);
    }
  } else symlinkSync(join(root, 'node_modules'), moduleLink, 'dir');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'todd-dsh-tui-profile', private: true, type: 'module',
    dependencies: manifest.dependencies, dsh: manifest.dsh,
  }, null, 2) + '\n');
  const reviewerPatch = `\n- insert:\n    - id: dscode-auto-review\n      name: ${JSON.stringify(join(root, 'plugins/auto-review/index.mjs'))}\n      config:\n        timeoutMs: 30000\n        maxOutputTokens: 768\n        maxReviewsPerTurn: 20\n`;
  const controlsPatch = `\n- id: agent-presets\n  config:\n    default: dscode\n    roots:\n      - path: ${JSON.stringify(presets)}\n        trust: system\n- insert:\n    - id: dscode-session-metrics\n      name: ${JSON.stringify(join(root, 'plugins/session-metrics/index.mjs'))}\n    - id: dscode-session-cards\n      name: ${JSON.stringify(join(root, 'plugins/session-cards/index.mjs'))}\n    - id: dscode-session-bridge\n      name: ${JSON.stringify(join(root, 'plugins/session-bridge/index.mjs'))}\n    - id: dscode-memory\n      name: ${JSON.stringify(join(root, 'plugins/memory/index.mjs'))}\n    - id: dscode-tui-tools\n      name: ${JSON.stringify(join(root, 'plugins/tui-tools/index.mjs'))}\n    - id: dscode-hooks\n      name: '@deepseek-ai/dsh-hooks-codex'\n      config:\n        configPath: ${JSON.stringify(hooksPath)}\n        defaultTimeoutMs: 10000\n        stderrSummaryMaxChars: 500\n`;
  writeFileSync(join(profile, 'cordis.patch.yml'), readFileSync(join(root, 'config/cordis.patch.yml'), 'utf8') + '\n' + readFileSync(join(root, 'config/auto-review.patch.yml'), 'utf8') + reviewerPatch + controlsPatch);
  return profile;
}

export function environment(home = runtimeHome) {
  return { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TUI_CHROME_ENTRY: chromeEntry, DSH_TUI_REVIEW_ENTRY: join(root, 'plugins/auto-review/index.mjs') };
}

export function runDsh(args, { home = runtimeHome, cwd = root, stdio = 'inherit' } = {}) {
  return spawn(process.execPath, [dshEntry, '--profile', profileName, ...args], {
    cwd, env: environment(home), stdio,
  });
}

export async function main(argv = process.argv.slice(2), defaultCwd = root) {
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const [command = 'start', ...args] = argv;
  if (!['setup', 'start', 'doctor', 'config'].includes(command)) throw new Error(`Unknown command: ${command}`);
  if (command === 'doctor') {
    await import('./doctor.mjs');
    return;
  }
  const profile = provision();
  if (command === 'setup') {
    console.log(`Ready: ${profile}\nStart with npm start. State stays in ${runtimeHome}`);
    return;
  }
  let cwd = defaultCwd;
  const cwdIndex = args.indexOf('--cwd');
  if (cwdIndex !== -1) {
    if (!args[cwdIndex + 1]) throw new Error('--cwd requires a directory');
    cwd = realpathSync(resolve(args[cwdIndex + 1]));
    args.splice(cwdIndex, 2);
  }
  const overlays = [];
  for (const file of ['mcp.local.yml', 'harness.local.yml']) {
    const path = join(root, 'config', file);
    if (existsSync(path)) overlays.push('--patch', path);
  }
  const child = runDsh([...overlays, ...(command === 'config' ? ['--dump-config'] : args)], { cwd });
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
