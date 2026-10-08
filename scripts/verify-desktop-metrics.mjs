// Exercise session usage projections in packed Desktop services.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { packDesktopPreset } from './pack-desktop-preset.mjs';
import { desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

const ui = process.argv.includes('--ui'), args = process.argv.slice(2).filter(value => value !== '--ui');
if (!args[0]) throw Error('Usage: node scripts/verify-desktop-metrics.mjs <independent-runtime-directory> [Harness.app] [--ui]');
const root = resolve(import.meta.dirname, '..'), runtimeDirectory = resolve(args[0]);
const modules = join(runtimeDirectory, 'node_modules');
const app = args[1] && resolve(args[1]);
const probe = 'desktop-metrics-probe.mjs';
if (app) execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-metrics-'));
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
  cpSync(join(root, 'scripts/desktop-provider-network-probe.mjs'), join(probeRoot, 'scripts/network.mjs'));
  const probePath = join(probeRoot, 'scripts', probe);
  writeFileSync(probePath, "import './network.mjs';\n" + readFileSync(probePath, 'utf8'));
  if (!app) execFileSync(process.execPath, ['--input-type=module', '-e', 'await import(process.argv[1])', join(probeRoot, 'scripts', probe)], { cwd: home, stdio: 'inherit' });
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: join(home, 'user'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ZDOTDIR: home,
    DSH_AGENTS_HOME: join(home, 'agents') });
  execFileSync('git', ['init', '--quiet', join(home, 'workspace')], { env });
  const checks = [];
  for (const phase of ui ? ['generate'] : ['generate', 'resume', 'unload']) {
    writeFileSync(join(profile, 'cordis.patch.yml'), stringify([
      { id: 'frontend', disabled: !ui }, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'web-runtime', config: { openBrowser: false } }, { id: 'product-analytics', disabled: true }, { id: 'desktop-product-telemetry', disabled: true },
      { id: 'dscode-session-cards', config: { enabled: false } }, { id: 'dscode-memory', config: { generate: false } },
      { id: 'workspace-controller', config: { documentsDirectory: join(home, 'documents') } }, { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'desktop-metrics-probe', name: join(probeRoot, 'scripts', probe) }] },
    ]));
    const nativeRuntime = app && join(app, 'Contents/Resources/app.asar/dsh');
    const child = spawn(app ? join(app, 'Contents/MacOS/DeepSeek Harness') : process.execPath,
      app && ui ? ['--user-data-dir=' + join(home, 'electron-data')] : app ? ['--expose-internals', join(nativeRuntime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), nativeRuntime, profile,
        join(app, 'Contents/Resources/runtime/primary-runtime')]
        : [join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'test', '--no-open'], {
      cwd: join(home, 'workspace'), env: { ...env, DSCODE_METRICS_PHASE: phase,
        ...(ui ? { DSCODE_METRICS_UI: '1' } : {}),
        ...(app && !ui ? { ELECTRON_RUN_AS_NODE: '1', DSCODE_METRICS_ELECTRON: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe', ...(app && !ui ? ['ipc'] : [])],
    });
    let failed = false;
    if (app && !ui) child.on('message', message => {
      if (message.type === 'dscode-metrics-failed') failed = true;
      if (['dscode-metrics-failed', 'dscode-metrics-shutdown'].includes(message.type)) child.send({ type: 'shutdown' });
    });
    let output = '', escalation, stopped = false;
    const stop = () => { stopped = true; child.kill('SIGTERM'); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    child.stdout.on('data', data => { output += data; if (ui) process.stdout.write(data); }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000); }, ui ? 15 * 60000 : 90000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); })
      .finally(() => { clearTimeout(timer); clearTimeout(escalation); process.off('SIGTERM', stop); process.off('SIGINT', stop); });
    const marker = 'DESKTOP_METRICS_PASSED';
    const safeOutput = output.replace(/token=[^\s"&]+/g, 'token=<redacted>');
    assert(!failed, safeOutput);
    if (!stopped) assert.equal(code, 0, safeOutput);
    assert(output.includes(marker), safeOutput);
    const line = output.split('\n').find(line => line.startsWith(marker));
    checks.push(JSON.parse(line.slice(marker.length + 1))); console.log(line);
  }
  const receipt = { runtime: packed.runtime, surface: app ? (ui ? 'signed Electron Desktop application' : 'signed Electron Desktop Host in Node mode') : 'independent native Host',
    packageSha256: packed.sha256, packedComposition: true, rendererInteraction: false, liveModelInference: false, checks };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, 'artifacts/local', `desktop-metrics-${app ? 'electron' : packed.runtime}${ui ? '-ui-host' : ''}.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { removeDesktopProbeHome(home); }
