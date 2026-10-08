// Disposable shared Web/Desktop settings UI with a local scripted model service.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { stringify } from 'yaml';
import { buildDesktopPreset, desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

if (!process.argv[2]) throw Error('Usage: node scripts/verify-desktop-model-ui.mjs <independent-runtime-directory> [Harness.app]');
const root = resolve(import.meta.dirname, '..'), runtime = resolve(process.argv[2]);
const app = process.argv[3] && resolve(process.argv[3]);
const installUi = process.argv.includes('--install-ui');
if (installUi && !app) throw Error('--install-ui requires the official Desktop application');
if (app) {
  if (process.platform !== 'darwin') throw Error('Native Desktop UI qualification requires macOS');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
  const version = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
  if (version !== JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version) throw Error('Desktop runtime mismatch');
}
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-model-ui-'));
// Opt in to a changing catalog to qualify rediscovery of saved models.
const refreshDiscovery = process.env.DSCODE_UI_DISCOVERY_REFRESH === '1';
const modelDelayMs = Number(process.env.DSCODE_UI_MODEL_DELAY_MS ?? 0);
if (!Number.isSafeInteger(modelDelayMs) || modelDelayMs < 0 || modelDelayMs > 180000) throw Error('Invalid model delay');
const calls = [], discoveryCatalogs = [];
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer desktop-ui-fixture-key') { response.writeHead(401); response.end('{}'); return; }
  if (request.url === '/v1/models' && request.method === 'GET') {
    calls.push('discover'); response.setHeader('content-type', 'application/json');
    const step = refreshDiscovery ? Math.min(discoveryCatalogs.length + 1, 3) : 1;
    const data = [{ id: 'desktop-ui-vision', context_window: step * 32768,
      ...(refreshDiscovery ? { max_output_tokens: step * 4096 } : {}) }];
    discoveryCatalogs.push(data);
    response.end(JSON.stringify({ data })); return;
  }
  if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end('{}'); return; }
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const tool = body.messages.some(message => message.role === 'tool');
    const call = body.tools?.length && !tool;
    calls.push(call ? 'tool-call' : tool ? 'tool-result' : 'text');
    if (modelDelayMs && !call && !tool) {
      console.log('DESKTOP_MODEL_DELAY_STARTED');
      const completed = await new Promise(resolve => {
        const timer = setTimeout(() => { response.removeListener('close', closed); resolve(true); }, modelDelayMs);
        const closed = () => { clearTimeout(timer); console.log('DESKTOP_MODEL_DELAY_CANCELLED'); resolve(false); };
        response.once('close', closed);
      });
      if (!completed) return;
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'desktop-ui-call', type: 'function', function: { name: 'lookup_probe', arguments: '{"name":"studio"}' } }] }
      : { content: tool ? 'CUSTOM_TOOL_OK' : 'CUSTOM_OK' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } catch { response.writeHead(400); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  seedDesktopProviderCatalogs(home);
  cpSync(join(root, 'scripts/desktop-provider-network-probe.mjs'), join(home, 'network.mjs'));
  const modules = join(runtime, 'node_modules');
  const profileName = app ? 'desktop' : 'test';
  const profile = join(home, 'profiles', profileName);
  mkdirSync(join(profile, 'node_modules/@toddzheng024'), { recursive: true });
  const bundle = installUi ? null : buildDesktopPreset(join(profile, 'node_modules', desktopPresetPackage), runtime);
  if (app && bundle) {
    mkdirSync(join(home, 'node_modules'));
    for (const name of Object.keys(JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')).dependencies)) {
      mkdirSync(dirname(join(home, 'node_modules', name)), { recursive: true });
      symlinkSync(join(modules, name), join(home, 'node_modules', name));
    }
  } else if (!app) {
    symlinkSync(modules, join(home, 'node_modules'));
    symlinkSync(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'));
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: bundle ? { [desktopPresetPackage]: `file:${bundle}` } : {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...(bundle ? [desktopPresetPackage] : [])] } } }));
  mkdirSync(join(profile, 'scripts'));
  writeFileSync(join(profile, 'scripts/ready.mjs'), `export const inject = ['connection', 'webServer'];
export function apply(ctx) { void ctx.get('loader').await().then(() => console.log('DESKTOP_MODELS_UI_READY ' + JSON.stringify({ url: ctx.connection.authenticatedUrl('http://127.0.0.1:' + ctx.webServer.port), modelUrl: process.env.DSCODE_FIXTURE_MODEL_URL }))); }
`);
  writeFileSync(join(profile, 'cordis.patch.yml'), stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } }, { id: 'product-analytics', config: { enabled: false } },
    // macOS resolves Documents through the OS, independently of the fixture's
    // HOME. Keep first-use workspace creation inside the disposable probe home.
    { id: 'workspace-controller', config: { documentsDirectory: join(home, 'documents') } },
    { insert: [{ id: 'desktop-models-ready', name: join(profile, 'scripts/ready.mjs') }] },
  ]));
  mkdirSync(join(home, 'user'));
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: join(home, 'user'), DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', ZDOTDIR: home,
    DSCODE_UI_PUBLIC_HUB: process.env.DSCODE_UI_PUBLIC_HUB === '1' ? '1' : '0',
    DSCODE_FIXTURE_MODEL_URL: `http://127.0.0.1:${server.address().port}/v1` });
  // Native Electron ignores Node's --import flag. Its fixture plugin applies the
  // guard before account interaction; preseeded catalogs require no network.
  if (app) {
    cpSync(join(home, 'network.mjs'), join(profile, 'scripts/network.mjs'));
    const ready = join(profile, 'scripts/ready.mjs');
    writeFileSync(ready, `import './network.mjs';\n` + readFileSync(ready, 'utf8'));
  }
  const child = spawn(app ? join(app, 'Contents/MacOS/DeepSeek Harness') : process.execPath,
    app ? ['--user-data-dir=' + join(home, 'electron-data')]
      : ['--import', join(home, 'network.mjs'), join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', profileName, '--no-open'], { cwd: home, env, stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log('DESKTOP_MODELS_UI_FIXTURE ' + JSON.stringify({ pid: process.pid, home, refreshDiscovery, installUi }));
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  process.exitCode = code ?? 0;
  const output = join(root, 'artifacts/local', modelDelayMs ? 'desktop-model-timeout-ui' : refreshDiscovery ? 'desktop-model-discovery-ui' : 'desktop-model-ui'); mkdirSync(output, { recursive: true });
  const catalog = join(home, 'user/.dscode/providers.yaml');
  try { cpSync(catalog, join(output, 'providers.yaml')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const credentialFile = join(home, 'user/.dscode/credentials.yaml');
  let keySaved = false, accountKeySaved = false;
  try {
    const saved = readFileSync(credentialFile, 'utf8');
    keySaved = saved.includes('desktop-ui-fixture-key');
    accountKeySaved = saved.includes('desktop-account-ui-fixture-key');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  writeFileSync(join(output, app ? 'native-transport.json' : 'transport.json'), JSON.stringify({ calls, discoveryCatalogs, keySaved, accountKeySaved,
    surface: app ? 'official Electron app' : 'shared Web client', liveModelInference: false }, null, 2) + '\n');
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  removeDesktopProbeHome(home);
}
