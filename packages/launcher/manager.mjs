import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { acquireLock, activeRuns, registerRun } from './locks.mjs';
export { acquireLock } from './locks.mjs';
const require = createRequire(import.meta.url);
export function stateHome(env = process.env) {
  return resolve(env.DSCODE_HOME || join(homedir(), '.local/share/dscode-hub'));
}
export function commandPlan(args, release, installed) {
  const [command, ...rest] = args;
  if (command === 'resume') {
    const id = rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
    return { launch: [...(id ? ['--resume', id] : ['--continue']), ...rest], install: !installed };
  }
  const flags = ['--profile', 'dscode'];
  if (command === 'install' || command === 'update') {
    if (rest.length > 1 || rest[0] && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(rest[0])) throw Error('Usage: dscode install|update [exact-version]');
    return { hub: ['profile', installed ? 'upgrade' : 'apply', release.slug, '--version', rest[0] ?? release.version, ...flags] };
  }
  if (command === 'rollback') {
    if (rest.length > 1 || rest[0]?.startsWith('-')) throw Error('Usage: dscode rollback [revision]');
    return { hub: ['profile', 'rollback', ...rest, ...flags] };
  }
  if (command === 'history') {
    if (rest.length) throw Error('Usage: dscode ' + command);
    return { hub: ['profile', command, ...flags] };
  }
  if (command === 'doctor') {
    if (rest.length > 1 || rest[0] && !['--local', '--preview'].includes(rest[0])) throw Error('Usage: dscode doctor [--local|--preview]');
    return { doctor: rest[0]?.slice(2) ?? 'analyze' };
  }
  return { launch: args, install: !installed };
}
// Recommendations are advisory. Resolve from the installed bundle (including
// pnpm's nested graph), not from the launcher or a globally installed Harness.
export function warnCompatibility(profile, release, metadata, warn = console.error) {
  const differences = [];
  if (metadata.version !== release.version) {
    differences.push(`DSCODE bundle: installed ${metadata.version}, recommended ${release.version} for this launcher`);
  }
  const bundleRequire = createRequire(join(profile, 'node_modules', release.bundle, 'package.json'));
  const expected = Object.fromEntries(Object.entries(metadata.dependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/')));
  expected['@deepseek-ai/dsh'] ??= release.runtime;
  for (const [name, version] of Object.entries(expected)) {
    if (!version) continue;
    try {
      const path = bundleRequire.resolve(`${name}/package.json`);
      const actual = JSON.parse(readFileSync(path, 'utf8')).version;
      if (actual !== version) differences.push(`${name}: installed ${actual}, recommended ${version}`);
    } catch {
      differences.push(`${name}: version could not be checked; recommended ${version}`);
    }
  }
  // This is the entry point actually executed below; it may differ from the
  // bundle's resolution when a user overrides the profile's dependencies.
  try {
    const actual = JSON.parse(readFileSync(join(profile, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
    const version = expected['@deepseek-ai/dsh'];
    if (version && actual !== version) differences.push(`Harness launch entry: installed ${actual}, recommended ${version}`);
  } catch {
    differences.push('Harness launch entry: version could not be checked');
  }
  if (differences.length) warn(`[DSCODE warning] This installation differs from the recommended version combination:\n${differences.map(line => `  ${line}`).join('\n')}\nContinuing without confirmation. Compatibility has not been verified for this combination.\n`);
  return differences;
}
export async function run(args, release) {
  const home = stateHome();
  const envFile = join(home, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const hub = join(dirname(require.resolve('@dsh-plugin-hub/cli')), 'bin.js');
  const pnpm = join(dirname(fileURLToPath(import.meta.url)), 'tools');
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), PATH: process.env.PATH };
  const exec = (entry, argv, cwd = process.cwd(), lease, started = () => {}) => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], { env: entry === hub ? { ...env, PATH: pnpm + ':' + env.PATH, npm_config_ignore_scripts: 'true', DSH_HUB_MACHINE: '1' } : env, cwd, stdio: lease ? ['inherit', 'inherit', 'inherit', lease.fd] : 'inherit' });
    started();
    const forward = signal => child.kill(signal);
    const handlers = ['SIGTERM','SIGHUP'].map(signal => { const handler = () => forward(signal); process.on(signal,handler); return [signal,handler]; });
    const cleanup = () => handlers.forEach(([signal,handler]) => process.off(signal,handler));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); code === 0 ? resolvePromise() : reject(Error(`DSCODE process exited: ${signal ?? code}`)); });
  });
  if (args[0] === 'doctor') {
    const mode = commandPlan(args, release, true).doctor;
    const profile = join(home, 'profiles/dscode');
    const state = join(home, '.hub/installations/dscode/current.json');
    if (!existsSync(state) || !existsSync(join(profile, 'package.json'))) throw Error('DSCODE is not installed. Run dscode install first.');
    const dsh = join(profile, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
    const runner = join(profile, 'node_modules', release.bundle, 'plugins/tui-tools/doctor-cli.mjs');
    if (!existsSync(dsh) || !existsSync(runner)) throw Error('DSCODE installation is incomplete. Run dscode update first.');
    const overlay = join(home, 'diagnostics', 'doctor-cli.patch.yml');
    mkdirSync(join(home, 'diagnostics'), { recursive: true, mode: 0o700 });
    writeFileSync(overlay, `${['tui-startup', 'tui-runner', 'dscode-session-bridge', 'dscode-session-cards', 'dscode-memory', 'dscode-email-tools', 'dscode-hooks', 'dscode-auto-review', 'dscode-session-metrics', 'dscode-tui-tools']
      .map(id => `- id: ${id}\n  disabled: true`).join('\n')}\n- insert:\n    - id: dscode-doctor-cli\n      name: ${JSON.stringify(runner)}\n      config:\n        local: ${mode === 'local'}\n        preview: ${mode === 'preview'}\n`, { mode: 0o600 });
    await exec(dsh, ['--profile', 'dscode', '--patch', overlay]);
    return;
  }
  const releaseLock = await acquireLock(home);
  let lease;
  try {
    const profile = join(home, 'profiles/dscode');
    const state = join(home, '.hub/installations/dscode/current.json');
    const installed = existsSync(state) && existsSync(join(profile, 'package.json'));
    if (!installed && existsSync(profile)) throw Error('Existing unmanaged/incomplete dscode profile; inspect ' + profile);
    const plan = commandPlan(args, release, installed);
    const running = await activeRuns(home);
    const mutatesProfile = plan.install || plan.hub && !['history', 'doctor'].includes(plan.hub[1]);
    if (mutatesProfile && running.length) throw Error('DSCODE sessions are running. Exit them before installing, updating or rolling back this profile.');
    if (plan.hub) return await exec(hub, plan.hub, process.cwd(), releaseLock);
    if (plan.install) {
      console.log(`Installing DSCODE ${release.version} from dshpluginhub.ai…`);
      await exec(hub, ['profile','apply',release.slug,'--version',release.version,'--profile','dscode'], process.cwd(), releaseLock);
    }
    const metadata = JSON.parse(readFileSync(join(profile,'node_modules',release.bundle,'package.json'),'utf8'));
    if (metadata.name !== release.bundle) throw Error('Unexpected DSCODE bundle');
    warnCompatibility(profile, release, metadata);
    const dshPackage = join(profile, 'node_modules/@deepseek-ai/dsh/package.json');
    const dsh = join(dirname(dshPackage),'lib/bin.js');
    const overlays = ['mcp.local.yml','harness.local.yml'].flatMap(file => {
      const path=join(home,'config',file); return existsSync(path) ? ['--patch',path] : [];
    });
    const launch = [...plan.launch];
    let cwd = process.cwd();
    const index = launch.indexOf('--cwd');
    if(index >= 0) { if(!launch[index+1]) throw Error('--cwd requires a directory'); cwd=resolve(launch[index+1]); launch.splice(index,2); }
    lease = await registerRun(home);
    await exec(dsh, ['--profile','dscode',...overlays,...launch], cwd, lease, releaseLock);
  } finally { lease?.release(); releaseLock(); }
}
