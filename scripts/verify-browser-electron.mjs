// Qualify an official macOS Desktop build with an isolated local browser fixture.
// The application owns its bundled core runtime; only MCP dependencies come from
// the supplied npm directory. Close with Ctrl+C after inspecting the native UI.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { buildBrowserDesktop, desktopBrowserPackage, desktopRuntimes, browserDependencies } from './build-browser-desktop.mjs';
import { startExtensionProbe } from './browser-extension-probe.mjs';
import { buildDesktopPreset, desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';
const root = resolve(import.meta.dirname, '..');
if (process.platform !== 'darwin' || !process.argv[2] || !process.argv[3]) throw Error('Usage on macOS: node scripts/verify-browser-electron.mjs <Harness.app> <runtime-directory> [--extension|--preset]');
if (process.argv.length > 5 || (process.argv[4] && !['--extension', '--preset'].includes(process.argv[4]))) throw Error('Choose either --extension or --preset');
const app = resolve(process.argv[2]), modules = join(resolve(process.argv[3]), 'node_modules');
const extension = process.argv[4] === '--extension';
const preset = process.argv[4] === '--preset';
if (extension && !process.env.DSCODE_TEST_CHROME) throw Error('Extension qualification requires DSCODE_TEST_CHROME pointing to Chrome for Testing.');
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const runtime = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (!desktopRuntimes.includes(runtime)) throw Error(`Unsupported Desktop version: ${runtime}`);
if (preset && JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version !== runtime) throw Error('The staged preset runtime must match the official application version');
for (const [name, version] of Object.entries(browserDependencies)) {
  if (JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version !== version) throw Error(`Expected ${name}@${version}`);
}
const home = mkdtempSync(join(tmpdir(), 'dscode-electron-'));
let extensionProbe, extensionStartup, failure, revoked = false;
try {
  seedDesktopProviderCatalogs(home);
  const profile = join(home, 'profiles/desktop');
  mkdirSync(join(home, 'node_modules'));
  // Keep plugins inside the profile: the Desktop resolver cannot intercept core
  // imports from arbitrary external fixture directories or ASAR symlink aliases.
  const packageName = preset ? desktopPresetPackage : desktopBrowserPackage;
  const bundle = preset ? buildDesktopPreset(join(profile, 'node_modules', packageName), resolve(process.argv[3]))
    : buildBrowserDesktop(join(profile, 'node_modules', packageName), runtime);
  for (const name of Object.keys(JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')).dependencies)) {
    mkdirSync(dirname(join(home, 'node_modules', name)), { recursive: true });
    symlinkSync(join(modules, name), join(home, 'node_modules', name));
  }
  mkdirSync(join(profile, 'scripts'));
  cpSync(join(root, preset ? 'scripts/desktop-electron-probe.mjs' : 'scripts/browser-ui-probe.mjs'), join(profile, 'scripts/probe.mjs'));
  if (preset) cpSync(join(root, 'scripts/desktop-browser-probe.mjs'), join(profile, 'scripts/desktop-browser-probe.mjs'));
  symlinkSync(join(bundle, 'plugins'), join(profile, 'plugins'));
  mkdirSync(join(home, 'browser'));
  writeFileSync(join(home, 'browser/config.json'), JSON.stringify(extension ? { mode: 'extension' } : { mode: 'isolated', headless: true,
    ...(process.env.DSCODE_TEST_CHROME ? { executablePath: process.env.DSCODE_TEST_CHROME } : {}) }));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'desktop-browser-fixture', private: true, type: 'module', dependencies: { [packageName]: `file:${bundle}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', packageName] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), (preset ? '' : readFileSync(join(root, 'config/auto-review.patch.yml'), 'utf8') + '\n') + stringify([
    { insert: [{ id: 'browser-ui-probe', name: join(profile, 'scripts/probe.mjs') }] },
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'product-analytics', config: { enabled: false } },
  ]));
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  if (preset) { mkdirSync(join(home, 'user')); env.HOME = join(home, 'user'); }
  Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', ZDOTDIR: home });
  if (extension) env.DSCODE_BROWSER_UI_EXTENSION = '1';
  for (const flag of ['DSCODE_BROWSER_UI_HOLD_CAPTURE', 'DSCODE_BROWSER_UI_HOLD_ANNOTATION', 'DSCODE_BROWSER_UI_LARGE_IMAGE', 'DSCODE_BROWSER_UI_START_STOPPED', 'DSCODE_BROWSER_UI_HANDOFF']) {
    if (process.env[flag] === '1') env[flag] = '1';
  }
  const child = spawn(join(app, 'Contents/MacOS/DeepSeek Harness'), ['--user-data-dir=' + join(home, 'electron-data')], { cwd: home, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let ready = false;
  const stop = () => {
    child.kill('SIGTERM');
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000);
    timer.unref(); child.once('exit', () => clearTimeout(timer));
  };
  const startupTimer = setTimeout(() => {
    failure = Error('The Desktop fixture did not become ready within 120 seconds.');
    stop();
  }, 120000);
  startupTimer.unref();
  child.once('exit', () => clearTimeout(startupTimer));
  child.once('error', () => clearTimeout(startupTimer));
  let output = '';
  child.stdout.on('data', data => {
    output += data.toString();
    for (let newline; (newline = output.indexOf('\n')) >= 0;) {
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      if (line.startsWith(preset ? 'DESKTOP_ELECTRON_READY ' : 'BROWSER_UI_READY ')) {
        ready = true;
        clearTimeout(startupTimer);
      }
      const prefix = 'BROWSER_EXTENSION_PAIRING ', marker = line.indexOf(prefix);
      if (extension && marker >= 0 && !extensionStartup) {
        extensionStartup = (async () => {
          const pairing = JSON.parse(line.slice(marker + prefix.length));
          extensionProbe = await startExtensionProbe({ executablePath: process.env.DSCODE_TEST_CHROME, extensionPath: join(bundle, 'extensions/browser'), home, ...pairing });
          console.log('ELECTRON_EXTENSION_PAIRED');
        })().catch(error => { failure = error; console.error(error); stop(); });
      } else console.log(line);
    }
  });
  process.on('SIGUSR2', () => {
    if (!extensionProbe) return;
    void extensionProbe.stopSharing().then(() => { revoked = true; console.log('ELECTRON_EXTENSION_REVOKED'); }, error => console.error(error));
  });
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  // Publish the handle only after its stop handlers are installed. Callers may
  // interrupt immediately on this line and still require fixture cleanup.
  console.log('ELECTRON_FIXTURE ' + JSON.stringify({ home, runtime, launcherPid: process.pid }));
  process.exitCode = await new Promise((resolve, reject) => { child.once('exit', code => resolve(code ?? 0)); child.once('error', reject); });
  await extensionStartup;
  if (failure) throw failure;
  if (existsSync(join(home, 'browser-ui-failure.log'))) throw Error(readFileSync(join(home, 'browser-ui-failure.log'), 'utf8'));
  if (!ready) throw Error('The Desktop process exited before the fixture became ready. This run did not qualify the browser UI.');
  const receipt = join(home, 'annotation-receipt.json');
  try {
    const data = JSON.parse(readFileSync(receipt, 'utf8'));
    if (data.count > 0 && data.hasImage) {
      mkdirSync(join(root, 'artifacts/local'), { recursive: true });
      writeFileSync(join(root, `artifacts/local/browser-electron${preset ? '-preset' : extension ? '-extension' : ''}-receipt.json`), JSON.stringify({ runtime, surface: 'official Electron app', mode: extension ? 'extension' : 'isolated', extensionRevoked: revoked, liveModelInference: false, annotation: data }, null, 2) + '\n');
      console.log('ELECTRON_ANNOTATION_RECEIPT_SAVED');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
} finally {
  await extensionStartup;
  await extensionProbe?.close();
  removeDesktopProbeHome(home);
}
