import { composePlugins } from './composition.mjs';
import { spawn } from 'node:child_process';
import { validateHooks } from '../plugins/tui-tools/hooks.mjs';
import { writeHookConfig } from '../plugins/tui-tools/hook-sources.mjs';
import { ancestorSkillDirs, writeWorkspaceInstructions } from '../plugins/tui-tools/workspace-discovery.mjs';
import { patchRuntime } from './patch-runtime.mjs';
import { patchInkFrame } from './patch-ink.mjs';
import { provisionPreset } from './preset.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
export const runtimeHome = join(root, '.runtime');
export const profileName = 'tui';
export const dshEntry = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js');

export function provision(home = runtimeHome, { cwd = root, env = process.env } = {}) {
  if (!existsSync(dshEntry)) throw new Error('Dependencies missing. Run npm ci first.');
  // The terminal is vendored at packages/tui and edited as source: the text-patch
  // pass over dsh-code's published bundle is retired. Host-plane patches below
  // stay until @deepseek-ai/dsh-* carries the behaviour upstream.
  // Ink owns the frame repaint; the vendored terminal cannot carry this one.
  patchInkFrame(root);
  patchRuntime(root);
  const presets = provisionPreset(root, home);
  const hooksPath = join(root, 'config/hooks.local.json');
  if (!existsSync(hooksPath)) writeFileSync(hooksPath, '{"hooks": {}}\n', { mode: 0o600, flag: 'wx' });
  validateHooks(JSON.parse(readFileSync(hooksPath, 'utf8')));
  const hookConfig = writeHookConfig({ root, cwd, home, env });
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
  const plugins = composePlugins({ root, hooks: hookConfig.path, presets });
  writeFileSync(join(profile, 'cordis.patch.yml'), [
    readFileSync(join(root, 'config/cordis.patch.yml'), 'utf8'),
    readFileSync(join(root, 'config/auto-review.patch.yml'), 'utf8'),
    plugins,
  ].join('\n'));
  return profile;
}

export function environment(home = runtimeHome, cwd = process.cwd()) {
  const userHome = homedir();
  // Ancestor discovery is resolved here because only the launcher knows the
  // session directory; the preset reads the results from these two variables.
  const instructions = writeWorkspaceInstructions({ cwd, home: userHome, stateDir: home });
  return {
    ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
    DSCODE_SKILL_ANCESTOR_DIRS: JSON.stringify(ancestorSkillDirs({ cwd, home: userHome })),
    DSCODE_INSTRUCTION_HOME: instructions ?? home,
    DSH_TUI_REVIEW_ENTRY: join(root, 'plugins/auto-review/index.mjs'),
  };
}

// node:sqlite still ships experimental in the supported Node range, and the memory
// and mailbox stores import it as the profile boots. The flag is prepended to any
// caller-supplied node arguments, so every DSH child is quiet without each call
// site repeating it.
const quietNodeArgs = ['--disable-warning=ExperimentalWarning'];

export function runDsh(args, { home = runtimeHome, cwd = root, stdio = 'inherit', env = {}, nodeArgs = [] } = {}) {
  return spawn(process.execPath, [...quietNodeArgs, ...nodeArgs, dshEntry, '--profile', profileName, ...args], {
    cwd, env: { ...environment(home, cwd), ...env }, stdio,
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
  let cwd = defaultCwd;
  const cwdIndex = args.indexOf('--cwd');
  if (cwdIndex !== -1) {
    if (!args[cwdIndex + 1]) throw new Error('--cwd requires a directory');
    cwd = realpathSync(resolve(args[cwdIndex + 1]));
    args.splice(cwdIndex, 2);
  }
  const profile = provision(runtimeHome, { cwd });
  if (command === 'setup') {
    console.log(`Ready: ${profile}\nStart with npm start. State stays in ${runtimeHome}`);
    return;
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
