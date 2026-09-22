import { readFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { acquireLock, activeRuns, registerRun } from './locks.mjs';
export { acquireLock } from './locks.mjs';
const launchctl = (launchArgs, { ignoreFailure = false } = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn('launchctl', launchArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  child.once('error', error => (ignoreFailure ? resolvePromise(1) : reject(error)));
  child.once('exit', code => (code === 0 || ignoreFailure
    ? resolvePromise(code ?? 0)
    : reject(Error(`launchctl ${launchArgs[0]} failed (${code}): ${stderr.trim()}`))));
});

const require = createRequire(import.meta.url);
// The owning launcher remains stable when run() is imported or invoked via a wrapper.
const dscodePath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
// The exec CLI ships beside the published launcher; a source checkout reads it from plugins/. Only `dscode exec` loads it.
const loadExecCli = () => import(existsSync(new URL('./exec/cli.mjs', import.meta.url)) ? './exec/cli.mjs' : '../../plugins/exec/cli.mjs');
// The trigger CLI ships beside the published launcher too (the trigger modules are
// dependency-free apart from `yaml`); a source checkout reads them from plugins/.
const loadTriggerModules = async () => {
  const base = existsSync(fileURLToPath(new URL('./trigger/cli.mjs', import.meta.url)))
    ? new URL('./trigger/', import.meta.url)
    : new URL('../../plugins/triggers/', import.meta.url);
  const [cli, overlay, options] = await Promise.all([
    import(new URL('cli.mjs', base).href),
    import(new URL('overlay.mjs', base).href),
    import(new URL('options.mjs', base).href),
  ]);
  return { cli, triggerOverlay: overlay.triggerOverlay, writeRunSpec: options.writeRunSpec, readRunResult: options.readRunResult };
};
export function stateHome(env = process.env) {
  return resolve(env.DSCODE_HOME || join(homedir(), '.local/share/dscode-hub'));
}

/**
 * Whether Homebrew owns the launcher this process runs from. The formula writes
 * `.dscode-brew` beside its own `cli.mjs`, and `dscode update` then keeps the launcher with
 * Homebrew instead of installing a second one with npm that the formula cannot see.
 * @param directory - the launcher's own directory; injectable so a test can place the marker.
 */
export function brewManaged(directory = dirname(fileURLToPath(import.meta.url)), { exists = existsSync } = {}) {
  return exists(join(directory, '.dscode-brew'));
}

export function commandPlan(args, release, installed, launcherVersion) {
  const [command, ...rest] = args;
  if (command === 'exec') return { exec: rest, install: !installed };
  if (command === 'trigger') return { trigger: rest, install: !installed };
  if (command === 'resume') {
    const id = rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
    return { launch: [...(id ? ['--resume', id] : ['--continue']), ...rest], install: !installed };
  }
  const flags = ['--profile', 'dscode'];
  if (command === 'install' || command === 'update') {
    // "latest" is what the TUI's `/update` schedules when no version is named; it is the default here too.
    const explicit = rest[0] === 'latest' ? undefined : rest[0];
    if (rest.length > 1 || explicit && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(explicit)) throw Error('Usage: dscode install|update [exact-version]');
    if (command === 'install') return { hub: ['profile', installed ? 'upgrade' : 'apply', release.slug, '--version', explicit ?? release.version, ...flags] };
    // An exact argument updates launcher and profile to that version; without one, a newer
    // launcher found on npm moves both, and otherwise the profile follows this launcher.
    const wanted = explicit ?? launcherVersion;
    const version = wanted ?? release.version;
    return { hub: ['profile', installed ? 'upgrade' : 'apply', release.slug, '--version', version, ...flags],
      ...(wanted && wanted !== release.version ? { launcherUpdate: wanted } : {}) };
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

/** The message chain, causes included, so a failure keeps the reason it came from. */
export function describeError(error) {
  const seen = new Set();
  const parts = [];
  for (let current = error; current && !seen.has(current); current = current.cause) {
    seen.add(current);
    const reason = current instanceof Error ? current.message : current?.message ?? current?.code ?? current;
    const message = typeof reason === 'string' ? reason : String(reason ?? '');
    if (!message) continue;
    parts.push(typeof current?.code === 'string' && !message.includes(current.code) ? `${message} (${current.code})` : message);
    if (parts.length === 5) { parts.push('…'); break; }
  }
  return parts.join(' <- ') || 'Unknown error';
}

/**
 * What to check when the Hub or npm step cannot finish. A corporate network usually
 * reaches the internet through a proxy that Node's fetch ignores, while the prebuilt
 * GitHub release arrives without the Hub and without an npm registry.
 */
export function hubFailureHint(home, env = process.env) {
  const proxied = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some(name => env[name]);
  return [
    'That step reaches api.dshpluginhub.ai and an npm registry.',
    ...(proxied ? ['HTTP(S)_PROXY is set, but the Hub API call does not use it.'] : []),
    `For an internal Hub mirror, add DSH_HUB_API_URL to ${join(home, '.env')}.`,
    'A TLS-inspecting proxy needs its root CA in NODE_EXTRA_CA_CERTS.',
    'Without Hub access, install the prebuilt GitHub release: https://github.com/qiz029/dscode/releases',
  ];
}
/** What a failed command prints: the chain once, then the Hub hints when the failing step carried them. */
export function formatFailure(error) {
  const hint = error?.hubHint?.length ? `\nIf that failure was a network one, the usual causes on a managed network are:\n${error.hubHint.map(line => `  - ${line}`).join('\n')}` : '';
  return `${describeError(error)}${hint}`;
}

const LAUNCHER_PACKAGE = '@toddzheng024/dscode';
/** Semver-shaped comparison: numeric core, then a prerelease below its release. */
export function compareVersion(left, right) {
  const split = value => {
    const at = value.indexOf('-');
    return { core: (at === -1 ? value : value.slice(0, at)).split('.').map(Number), pre: at === -1 ? [] : value.slice(at + 1).split('.') };
  };
  const a = split(left), b = split(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index++) {
    const x = a.core[index] ?? 0, y = b.core[index] ?? 0;
    if (x !== y) return Math.sign(x - y);
  }
  if (a.pre.length === 0 || b.pre.length === 0) return Math.sign(b.pre.length - a.pre.length);
  for (let index = 0; index < Math.min(a.pre.length, b.pre.length); index++) {
    const x = a.pre[index], y = b.pre[index];
    const numeric = [ /^\d+$/.test(x), /^\d+$/.test(y) ];
    if (numeric[0] && numeric[1] && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The launcher version `dscode update` should move to: an explicit argument wins; without
 * one, the newest published launcher when it is newer than this one. A registry that cannot
 * be read falls back to this launcher's recommended version.
 */
export async function launcherUpdateVersion(arg, release, { fetchImpl = fetch, log = console.error } = {}) {
  if (arg && arg !== 'latest') return arg;
  try {
    // Plain JSON, not the abbreviated `application/vnd.npm.install-v1+json`: the registry
    // answers 406 for that type on the `/latest` dist-tag endpoint, which silently turned
    // every launcher self-update into "no newer version".
    const response = await fetchImpl(`https://registry.npmjs.org/${LAUNCHER_PACKAGE}/latest`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    const version = (await response.json()).version;
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) && compareVersion(version, release.version) > 0 ? version : undefined;
  } catch (error) {
    log(`[DSCODE] Could not check npm for a newer launcher (${error.message}); updating the profile to ${release.version}.`);
    return undefined;
  }
}

/** Replace the globally installed launcher binary itself; the profile step only runs when this kept its promise. */
export function installLauncher(version, { spawnImpl = spawn, log = console.error } = {}) {
  return new Promise((resolvePromise, reject) => {
    log(`Updating the DSCODE launcher to ${version} with npm…`);
    const child = spawnImpl('npm', ['install', '-g', `${LAUNCHER_PACKAGE}@${version}`], { stdio: 'inherit' });
    child.once('error', error => reject(Error(`npm could not update the launcher (${error.message}); run npm install -g ${LAUNCHER_PACKAGE}@${version} manually.`)));
    child.once('exit', code => code === 0 ? resolvePromise() : reject(Error(`npm install -g ${LAUNCHER_PACKAGE}@${version} exited with ${code}; the profile was not changed.`)));
  });
}

/** Single quotes for a shell command; a literal quote becomes '\''. */
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function run(args, release) {
  const home = stateHome();
  const envFile = join(home, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const vendoredHub = fileURLToPath(new URL('./vendor/hub-cli/dist/bin.js', import.meta.url));
  const hub = existsSync(vendoredHub) ? vendoredHub : join(dirname(require.resolve('@dsh-plugin-hub/cli')), 'bin.js');
  const pnpm = join(dirname(fileURLToPath(import.meta.url)), 'tools');
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSCODE_CLI_PATH: dscodePath, PATH: process.env.PATH };
  // `stdout: 'stderr'` keeps installer output off a pipeable exec stdout.
  const spawnRun = (entry, argv, { cwd = process.cwd(), lease, started = () => {}, extraEnv = {}, nodeArgs = [], stdout = 'inherit', triggerLease } = {}) => new Promise((resolvePromise, reject) => {
    const out = stdout === 'stderr' ? process.stderr : 'inherit';
    const child = spawn(process.execPath, [...nodeArgs, entry, ...argv], { env: entry === hub ? { ...env, PATH: pnpm + ':' + env.PATH, npm_config_ignore_scripts: 'true', DSH_HUB_MACHINE: '1' } : { ...env, ...extraEnv }, cwd, stdio: lease ? ['inherit', out, 'inherit', lease.fd, ...(triggerLease ? [triggerLease.fd] : [])] : ['inherit', out, 'inherit'] });
    started();
    const forward = signal => child.kill(signal);
    const handlers = ['SIGTERM','SIGHUP'].map(signal => { const handler = () => forward(signal); process.on(signal,handler); return [signal,handler]; });
    const cleanup = () => handlers.forEach(([signal,handler]) => process.off(signal,handler));
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolvePromise({ code, signal }); });
  });
  const exec = async (entry, argv, cwd = process.cwd(), lease, started, stdout) => {
    const { code, signal } = await spawnRun(entry, argv, { cwd, lease, started, stdout });
    if (code !== 0) throw Error(`DSCODE process exited: ${signal ?? code}`);
  };
  // A Hub failure carries its network hints to the single top-level reporter, so the chain is not printed twice.
  const hubFailure = error => Object.assign(error, { hubHint: hubFailureHint(home) });
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
  let triggerRequest;
  if (args[0] === 'trigger') {
    const modules = await loadTriggerModules();
    const triggerArgs = commandPlan(args, release, true).trigger;
    const parsed = modules.cli.parseTriggerArgs(triggerArgs);
    if (parsed.help) { console.log(modules.cli.USAGE); return; }
    if (parsed.error !== undefined) throw Error(`${parsed.error}\n${modules.cli.USAGE}`);
    if (!['run', 'fire', 'run-job'].includes(parsed.command)) {
      process.exitCode = await modules.cli.runTriggerCli(triggerArgs, {
        home, project: process.cwd(), platform: process.platform,
        dscodePath, launchctl,
      });
      return;
    }
    triggerRequest = { modules, triggerArgs };
  }
  let execOptions, execPrompt;
  if (args[0] === 'exec') {
    const cli = await loadExecCli();
    execOptions = cli.parseExecArgs(commandPlan(args, release, true).exec);
    execOptions.overlay = cli.execOverlay;
    if (execOptions.help) { console.log(cli.USAGE); return; }
    execPrompt = execOptions.prompt && execOptions.prompt !== '-' ? execOptions.prompt : await cli.readStream(process.stdin);
    if (!execPrompt.trim()) throw Error('Prompt is empty. Pass it as an argument or on stdin.');
  }
  const releaseLock = await acquireLock(home);
  let lease;
  try {
    const profile = join(home, 'profiles/dscode');
    const state = join(home, '.hub/installations/dscode/current.json');
    const installed = existsSync(state) && existsSync(join(profile, 'package.json'));
    if (!installed && existsSync(profile)) {
      // This check runs before the command is dispatched, so every command refuses while the directory is here.
      throw Error(`The dscode profile at ${profile} is not managed by this launcher, and it will not be replaced automatically.
Move it aside to install a managed profile, for example:
  mv ${shellQuote(profile)} ${shellQuote(profile + '.unmanaged')}`);
    }
    // A Homebrew launcher is never replaced with npm: the profile follows this launcher's
    // own version, and an explicit one is refused rather than leaving the profile ahead of it.
    const managed = brewManaged();
    const launcherVersion = args[0] === 'update' && !managed ? await launcherUpdateVersion(args[1], release) : undefined;
    const plan = commandPlan(args, release, installed, launcherVersion);
    if (managed) {
      if (plan.launcherUpdate) throw Error('This launcher is managed by Homebrew; run "brew upgrade dscode" to move it, then run "dscode update" for the profile.');
      if (args[0] === 'update') console.error(`[DSCODE] Homebrew owns this launcher; moving the profile to ${release.version}. Run "brew upgrade dscode" to move the launcher itself.`);
    }
    const running = await activeRuns(home);
    const mutatesProfile = plan.install || plan.hub && !['history', 'doctor'].includes(plan.hub[1]);
    if (mutatesProfile && running.length) throw Error('DSCODE sessions are running. Exit them before installing, updating or rolling back this profile.');
    if (plan.launcherUpdate) {
      await installLauncher(plan.launcherUpdate);
      // The launcher binary is replaced now; if the profile step fails, the next
      // `dscode update <version>` skips the npm pass and finishes the profile upgrade.
      try { return await exec(hub, plan.hub, process.cwd(), releaseLock); }
      catch (error) {
        throw hubFailure(Error(`The launcher itself was updated to ${plan.launcherUpdate}, but the profile upgrade failed; run "dscode update ${plan.launcherUpdate}" again to finish it.`, { cause: error }));
      }
    }
    if (plan.hub) {
      try { return await exec(hub, plan.hub, process.cwd(), releaseLock); }
      catch (error) { throw hubFailure(error); }
    }
    if (plan.install) {
      (execOptions ? console.error : console.log)(`Installing DSCODE ${release.version} from dshpluginhub.ai…`);
      (execOptions ? console.error : console.log)('This downloads the pinned Harness runtime and plugins with npm; on a slow registry it can take several minutes.');
      try {
        await exec(hub, ['profile','apply',release.slug,'--version',release.version,'--profile','dscode'], process.cwd(), releaseLock, undefined, execOptions ? 'stderr' : 'inherit');
      } catch (error) { throw hubFailure(error); }
    }
    const metadata = JSON.parse(readFileSync(join(profile,'node_modules',release.bundle,'package.json'),'utf8'));
    if (metadata.name !== release.bundle) throw Error('Unexpected DSCODE bundle');
    warnCompatibility(profile, release, metadata);
    const dshPackage = join(profile, 'node_modules/@deepseek-ai/dsh/package.json');
    const dsh = join(dirname(dshPackage),'lib/bin.js');
    const overlays = ['mcp.local.yml','harness.local.yml'].flatMap(file => {
      const path=join(home,'config',file); return existsSync(path) ? ['--patch',path] : [];
    });
    if (execOptions) {
      // One headless turn through the installed bundle's exec runner; the turn's exit code is the launcher's.
      const runner = join(profile, 'node_modules', release.bundle, 'plugins/exec/index.mjs');
      if (!existsSync(runner)) throw Error('This DSCODE installation has no exec runner. Run dscode update first.');
      const workspace = realpathSync(resolve(execOptions.cwd ?? process.cwd()));
      const scratch = mkdtempSync(join(tmpdir(), 'dscode-exec-'));
      try {
        const promptFile = join(scratch, 'prompt.txt'), optionsFile = join(scratch, 'options.json'), overlay = join(scratch, 'exec.patch.yml');
        writeFileSync(promptFile, execPrompt);
        const { model, effort, permission, approveAll, resume, json, quiet, timeoutMs } = execOptions;
        writeFileSync(optionsFile, JSON.stringify({ promptFile, cwd: workspace, model, effort, permission, approveAll, resume, json, quiet, timeoutMs }));
        writeFileSync(overlay, execOptions.overlay(runner));
        lease = await registerRun(home);
        const { code, signal } = await spawnRun(dsh, ['--profile', 'dscode', ...overlays, '--patch', overlay, ...execOptions.patches.flatMap(path => ['--patch', resolve(path)])],
          { cwd: workspace, lease, started: releaseLock, extraEnv: { DSCODE_EXEC_OPTIONS: optionsFile }, nodeArgs: ['--disable-warning=ExperimentalWarning'] });
        process.exitCode = code ?? (signal ? 130 : 0);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
      return;
    }
    if (triggerRequest !== undefined) {
      // One Host process per run, exactly like `exec`, plus the launcher's own
      // launchctl calls. The portable CLI half does the deciding and recording.
      const { cli, triggerOverlay, writeRunSpec, readRunResult } = triggerRequest.modules;
      const runner = join(profile, 'node_modules', release.bundle, 'plugins/triggers/host.mjs');
      const spawnTriggerRun = async ({ spec, cwd, triggerLease }) => {
        if (!existsSync(runner)) throw Error('This DSCODE installation has no trigger host. Run dscode update first.');
        const scratch = mkdtempSync(join(tmpdir(), 'dscode-trigger-'));
        let runLease;
        try {
          const specPath = join(scratch, 'run.json');
          const overlay = join(scratch, 'trigger.patch.yml');
          writeRunSpec(specPath, spec);
          writeFileSync(overlay, triggerOverlay(runner));
          runLease = await registerRun(home);
          const { code, signal } = await spawnRun(dsh, ['--profile', 'dscode', ...overlays, '--patch', overlay],
            { cwd, lease: runLease, triggerLease, started: releaseLock, extraEnv: { DSCODE_TRIGGER_OPTIONS: specPath }, nodeArgs: ['--disable-warning=ExperimentalWarning'] });
          return { code: code ?? (signal ? 130 : 0), result: readRunResult(`${specPath}.result.json`) };
        } finally {
          runLease?.release();
          rmSync(scratch, { recursive: true, force: true });
        }
      };
      lease = await registerRun(home);
      releaseLock();
      process.exitCode = await cli.runTriggerCli(triggerRequest.triggerArgs, {
        home, project: process.cwd(), platform: process.platform, dscodePath,
        stdout: process.stdout, stderr: process.stderr, launchctl, spawnRun: spawnTriggerRun,
      });
      return;
    }
    const launch = [...plan.launch];
    let cwd = process.cwd();
    const index = launch.indexOf('--cwd');
    if(index >= 0) { if(!launch[index+1]) throw Error('--cwd requires a directory'); cwd=resolve(launch[index+1]); launch.splice(index,2); }
    lease = await registerRun(home);
    await exec(dsh, ['--profile','dscode',...overlays,...launch], cwd, lease, releaseLock);
  } finally { lease?.release(); releaseLock(); }
}
