import { mkdirSync, readFileSync, existsSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
export function stateHome(env = process.env) {
  return resolve(env.DSCODE_HOME || join(homedir(), '.local/share/dscode-hub'));
}
export function acquireLock(home) {
  mkdirSync(home, { recursive: true });
  const path = join(home, '.launcher.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try { const fd = openSync(path, 'wx', 0o600); writeFileSync(fd, String(process.pid)); closeSync(fd); return () => unlinkSync(path); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid DSCODE lock; inspect ' + path);
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { unlinkSync(path); continue; } throw error; }
      throw Error(`DSCODE is already running (pid ${pid}). Exit it before launching or changing versions.`);
    }
  }
  throw Error('Could not acquire DSCODE lock');
}
export function commandPlan(args, release, installed) {
  const [command, ...rest] = args;
  const flags = ['--profile', 'dscode'];
  if (command === 'install' || command === 'update') {
    if (rest.length > 1 || rest[0] && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(rest[0])) throw Error('Usage: dscode install|update [exact-version]');
    return { hub: ['profile', installed ? 'upgrade' : 'apply', release.slug, '--version', rest[0] ?? release.version, ...flags] };
  }
  if (command === 'rollback') {
    if (rest.length > 1 || rest[0]?.startsWith('-')) throw Error('Usage: dscode rollback [revision]');
    return { hub: ['profile', 'rollback', ...rest, ...flags] };
  }
  if (command === 'history' || command === 'doctor') {
    if (rest.length) throw Error('Usage: dscode ' + command);
    return { hub: ['profile', command, ...flags] };
  }
  return { launch: args, install: !installed };
}
export async function run(args, release) {
  const home = stateHome();
  const envFile = join(home, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const hub = join(dirname(require.resolve('@dsh-plugin-hub/cli')), 'bin.js');
  const pnpm = join(dirname(fileURLToPath(import.meta.url)), 'tools');
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), PATH: process.env.PATH };
  const exec = (entry, argv, cwd = process.cwd()) => new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], { env: entry === hub ? { ...env, PATH: pnpm + ':' + env.PATH, npm_config_ignore_scripts: 'true' } : env, cwd, stdio: 'inherit' });
    const forward = signal => child.kill(signal);
    const handlers = ['SIGTERM','SIGHUP'].map(signal => { const handler = () => forward(signal); process.on(signal,handler); return [signal,handler]; });
    const cleanup = () => handlers.forEach(([signal,handler]) => process.off(signal,handler));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); code === 0 ? resolvePromise() : reject(Error(`DSCODE process exited: ${signal ?? code}`)); });
  });
  const releaseLock = acquireLock(home);
  try {
    const profile = join(home, 'profiles/dscode');
    const state = join(home, '.hub/installations/dscode/current.json');
    const installed = existsSync(state) && existsSync(join(profile, 'package.json'));
    if (!installed && existsSync(profile)) throw Error('Existing unmanaged/incomplete dscode profile; inspect ' + profile);
    const plan = commandPlan(args, release, installed);
    if (plan.hub) return await exec(hub, plan.hub);
    if (plan.install) {
      console.log(`Installing DSCODE ${release.version} from dshpluginhub.ai…`);
      await exec(hub, ['profile','apply',release.slug,'--version',release.version,'--profile','dscode']);
    }
    const metadata = JSON.parse(readFileSync(join(profile,'node_modules',release.bundle,'package.json'),'utf8'));
    if (metadata.name !== release.bundle) throw Error('Unexpected DSCODE bundle');
    const dshPackage = join(profile, 'node_modules/@deepseek-ai/dsh/package.json');
    const dsh = join(dirname(dshPackage),'lib/bin.js');
    const overlays = ['mcp.local.yml','harness.local.yml'].flatMap(file => {
      const path=join(home,'config',file); return existsSync(path) ? ['--patch',path] : [];
    });
    const launch = [...plan.launch];
    let cwd = process.cwd();
    const index = launch.indexOf('--cwd');
    if(index >= 0) { if(!launch[index+1]) throw Error('--cwd requires a directory'); cwd=resolve(launch[index+1]); launch.splice(index,2); }
    await exec(dsh, ['--profile','dscode',...overlays,...launch], cwd);
  } finally { releaseLock(); }
}
