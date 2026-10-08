// Exercise memory through real JSONL sessions and packed Desktop services.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { packDesktopPreset } from './pack-desktop-preset.mjs';
import { desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

const attribution = process.argv.includes('--attribution'), args = process.argv.slice(2).filter(arg => arg !== '--attribution');
if (!args[0]) throw Error('Usage: node scripts/verify-desktop-memory.mjs <independent-runtime-directory> [Harness.app] [--attribution]');
const root = resolve(import.meta.dirname, '..'), runtimeDirectory = resolve(args[0]);
const modules = join(runtimeDirectory, 'node_modules');
const app = args[1] && resolve(args[1]);
const probe = attribution ? 'desktop-memory-attribution-probe.mjs' : 'desktop-memory-probe.mjs';
if (app) execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-memory-'));
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
    DSH_AGENTS_HOME: join(home, 'agents'), DSCODE_MEMORY_HOME: join(home, 'memories') });
  execFileSync('git', ['init', '--quiet', join(home, 'workspace')], { env });
  const checks = [];
  for (const phase of attribution ? ['attribution'] : ['generate', 'resume', 'unload']) {
    writeFileSync(join(profile, 'cordis.patch.yml'), stringify([
      { id: 'frontend', disabled: true }, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'web-runtime', config: { openBrowser: false } }, { id: 'product-analytics', disabled: true }, { id: 'desktop-product-telemetry', disabled: true },
      { id: 'dscode-session-cards', config: { enabled: false } }, { id: 'session-title-llm', disabled: true },
      { insert: [{ id: 'desktop-memory-probe', name: join(probeRoot, 'scripts', probe) }] },
    ]));
    const nativeRuntime = app && join(app, 'Contents/Resources/app.asar/dsh');
    const child = spawn(app ? join(app, 'Contents/MacOS/DeepSeek Harness') : process.execPath,
      app ? ['--expose-internals', join(nativeRuntime, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'), nativeRuntime, profile,
        join(app, 'Contents/Resources/runtime/primary-runtime')]
        : [join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'test', '--no-open'], {
      cwd: join(home, 'workspace'), env: { ...env, DSCODE_MEMORY_PHASE: phase,
        ...(app ? { ELECTRON_RUN_AS_NODE: '1', DSCODE_MEMORY_ELECTRON: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe', ...(app ? ['ipc'] : [])],
    });
    let failed = false;
    if (app) child.on('message', message => {
      if (message.type === 'dscode-memory-failed') failed = true;
      if (['dscode-memory-failed', 'dscode-memory-shutdown'].includes(message.type)) child.send({ type: 'shutdown' });
    });
    let output = '', escalation;
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000); }, 90000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); })
      .finally(() => { clearTimeout(timer); clearTimeout(escalation); });
    const marker = 'DESKTOP_MEMORY_PASSED';
    const safeOutput = output.replace(/token=[^\s"&]+/g, 'token=<redacted>');
    assert(!failed, safeOutput);
    assert.equal(code, 0, safeOutput);
    assert(output.includes(marker), safeOutput);
    const line = output.split('\n').find(line => line.startsWith(marker));
    checks.push(JSON.parse(line.slice(marker.length + 1))); console.log(line);
  }
  const receipt = { runtime: packed.runtime, surface: app ? 'signed Electron Desktop Host in Node mode' : 'independent native Host',
    packageSha256: packed.sha256, packedComposition: true, rendererInteraction: false, liveModelInference: false, checks };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, 'artifacts/local', `desktop-memory-${attribution ? 'attribution-' : ''}${app ? 'electron' : packed.runtime}.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally { removeDesktopProbeHome(home); }
