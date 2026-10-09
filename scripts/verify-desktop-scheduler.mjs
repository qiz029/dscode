// Qualify owned unattended sessions in the packed Desktop composition.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { packDesktopPreset } from './pack-desktop-preset.mjs';
import { desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { acquireTriggerLease } from '../plugins/triggers/lease.mjs';

const management = process.argv.includes('--management'), args = process.argv.slice(2).filter(value => value !== '--management');
if (!args[0]) throw Error('Usage: node scripts/verify-desktop-scheduler.mjs <independent-runtime-directory> [Harness.app] [--management]');
const root = resolve(import.meta.dirname, '..'), runtimeDirectory = resolve(args[0]);
const modules = join(runtimeDirectory, 'node_modules');
const app = args[1] && resolve(args[1]);
const probe = management ? 'desktop-trigger-management-probe.mjs' : 'desktop-scheduler-probe.mjs';
if (app) execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-scheduler-'));
try {
  seedDesktopProviderCatalogs(home);
  const packed = packDesktopPreset(runtimeDirectory, join(home, 'packages'));
  if (app) assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(), packed.runtime);
  const installed = join(home, 'installed'); mkdirSync(installed);
  execFileSync('tar', ['-xzf', packed.path, '-C', installed]);
  const profile = join(home, app ? 'profiles/desktop' : 'profiles/test');
  const bundle = app ? join(profile, 'node_modules', desktopPresetPackage) : join(installed, 'package');
  mkdirSync(join(profile, 'node_modules/@toddzheng024'), { recursive: true });
  if (app) {
    renameSync(join(installed, 'package'), bundle);
    mkdirSync(join(home, 'node_modules'));
    for (const name of Object.keys(JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')).dependencies)) {
      mkdirSync(dirname(join(home, 'node_modules', name)), { recursive: true });
      symlinkSync(join(modules, name), join(home, 'node_modules', name));
    }
  } else {
    symlinkSync(modules, join(home, 'node_modules'));
    symlinkSync(bundle, join(profile, 'node_modules', desktopPresetPackage));
    symlinkSync(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'));
  }
  const probeRoot = app ? profile : home;
  symlinkSync(join(bundle, 'plugins'), join(probeRoot, 'plugins'));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [desktopPresetPackage]: `file:${bundle}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', desktopPresetPackage] } } }));
  mkdirSync(join(probeRoot, 'scripts')); mkdirSync(join(home, 'user')); mkdirSync(join(home, 'workspace'));
  cpSync(join(root, 'scripts', probe), join(probeRoot, 'scripts', probe));
  if (!app) execFileSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', join(probeRoot, 'scripts', probe)], { cwd: home, stdio: 'inherit' });
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: join(home, 'user'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ZDOTDIR: home,
    DSH_AGENTS_HOME: join(home, 'agents') });
  execFileSync('git', ['init', '--quiet', join(home, 'workspace')], { env });
  const checks = [];
  for (const phase of management ? ['configure', 'resume', 'disabled'] : ['initial', 'crash', 'recover', 'shutdown']) {
    const patch = join(profile, 'cordis.patch.yml');
    writeFileSync(patch, stringify([
      { id: 'frontend', disabled: true }, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'web-runtime', config: { openBrowser: false } }, { id: 'product-analytics', disabled: true }, { id: 'desktop-product-telemetry', disabled: true },
      { id: 'dscode-session-cards', config: { enabled: false, minMessages: 1, debounceMs: 0, cooldownMs: 0 } },
      { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'desktop-scheduler-probe', name: join(probeRoot, 'scripts', probe) }] },
    ]));
    const nativeRuntime = app && join(app, 'Contents/Resources/app.asar/dsh');
    const child = spawn(app ? join(app, 'Contents/MacOS/DeepSeek Harness') : process.execPath,
      app ? ['--expose-internals', join(nativeRuntime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), nativeRuntime, profile,
        join(app, 'Contents/Resources/runtime/primary-runtime')]
        : [join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'test', '--no-open'], {
      cwd: join(home, 'workspace'), env: { ...env, DSCODE_SCHEDULER_PHASE: phase,
        ...(app ? { ELECTRON_RUN_AS_NODE: '1', DSCODE_SCHEDULER_ELECTRON: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe', ...(app ? ['ipc'] : [])],
    });
    let checkpointFailure, requestId = 0;
    const ready = Promise.withResolvers(), requests = new Map();
    const control = (type, action) => new Promise((resolveRequest, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { requests.delete(id); reject(Error('Native control timed out')); }, 10000);
      requests.set(id, message => { clearTimeout(timer); resolveRequest(message); });
      child.send({ type, requestId: id, ...(action ? { action } : {}) });
    });
    if (app) child.on('message', message => {
      if (message.type === 'ready') ready.resolve(message);
      if (message.type === 'dscode-scheduler-failed') { checkpointFailure = Error('Electron scheduler probe failed'); child.send({ type: 'shutdown' }); }
      if (requests.has(message.requestId)) { requests.get(message.requestId)(message); requests.delete(message.requestId); }
      if (message.type === 'dscode-scheduler-shutdown') child.send({ type: 'shutdown' });
      if (message.type !== 'dscode-scheduler-check') return;
      void (async () => {
        await ready.promise;
        const expected = ['idle', 'shutdown'].includes(message.state);
        const quit = await control('quit-inspection');
        assert.equal(quit.error, undefined); assert.equal(quit.activeTasks, expected);
        for (const action of ['inspect', 'lock', 'unlock']) {
          const result = await control('update-tasks', action);
          assert.equal(result.error, undefined); assert.equal(result.active, expected);
        }
        child.send({ type: 'dscode-scheduler-continue', state: message.state });
      })().catch(error => { checkpointFailure = error; child.kill('SIGTERM'); });
    });
    let output = '', killed = false; child.stdout.on('data', data => { output += data;
      if (phase === 'crash' && !killed && output.includes('DESKTOP_SCHEDULER_CRASH_READY')) { killed = true; child.kill('SIGKILL'); }
    }); child.stderr.on('data', data => { output += data; });
    let escalation;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, 90000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); })
      .finally(() => { clearTimeout(timer); clearTimeout(escalation); });
    if (checkpointFailure) throw Error(output.replace(/token=[^\s"&]+/g, 'token=<redacted>'), { cause: checkpointFailure });
    if (phase === 'crash') { assert(killed, output); assert.equal(code, null); checks.push({ phase, killedAfterDurableClaim: true }); continue; }
    const marker = 'DESKTOP_SCHEDULER_PASSED';
    assert.equal(code, 0, output.replace(/token=[^\s"&]+/g, 'token=<redacted>'));
    assert(output.includes(marker), output);
    checks.push(JSON.parse(output.split('\n').find(line => line.startsWith(marker)).slice(marker.length + 1)));
    console.log(output.split('\n').find(line => line.startsWith(marker)));
    if (phase === 'shutdown') {
      const saved = JSON.parse(readFileSync(join(home, 'scheduler-probe.json'), 'utf8')).shutdown;
      const store = new JobStore(home);
      try {
        assert.equal(store.get(saved.running).state, 'failed');
        assert.equal(store.get(saved.running).reason, 'interrupted');
        assert.equal(store.get(saved.pending).state, 'pending');
        assert.equal(store.one('SELECT status FROM sources WHERE id=?', saved.sourceId).status, 'stopped');
        assert.throws(() => process.kill(saved.producerPid, 0), error => error.code === 'ESRCH');
        const lease = await acquireTriggerLease(home, '_scheduler'); assert(lease); lease.release();
        checks.at(-1).hostShutdownDrained = true;
      } finally { store.close(); }
    }
  }
  const receipt = { runtime: packed.runtime, surface: app ? 'signed Electron Desktop Host in Node mode' : 'independent native Host', packageSha256: packed.sha256,
    ...(app ? { nativeQuitAndUpdateInspection: !management, nativeShutdownIpc: true, rendererInteraction: false } : {}),
    packedComposition: true, checks, queueRecoveryAfterKilledHost: !management, schedulerManagementInstalled: true,
    desktopSchedulerEnabledByDefault: false, persistedExplicitActivation: management, liveModelInference: false };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, `artifacts/local/desktop-scheduler-${management ? 'management-' : ''}${packed.runtime}${app ? '-electron' : ''}.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log('DESKTOP_SCHEDULER_QUEUE_PASSED ' + JSON.stringify(receipt));
} finally {
  removeDesktopProbeHome(home);
}
