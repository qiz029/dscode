import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { stringify } from 'yaml';
import { packDesktopPreset } from './pack-desktop-preset.mjs';
import { desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

if (!process.argv[2]) throw Error('Usage: node scripts/verify-desktop-providers.mjs <independent-runtime-directory>');
const root = resolve(import.meta.dirname, '..'), modules = join(resolve(process.argv[2]), 'node_modules');
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-providers-')), calls = [];
const server = createServer(async (req, res) => {
  if (!req.url.endsWith('/chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); calls.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ id: 'fixture', model: body.model, choices: [{ index: 0, delta: { content: 'PROVIDER_ROUTE_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n');
  } catch { res.writeHead(400); res.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  seedDesktopProviderCatalogs(home);
  const packed = packDesktopPreset(resolve(process.argv[2]), join(home, 'packages'));
  const installed = join(home, 'installed'); mkdirSync(installed); execFileSync('tar', ['-xzf', packed.path, '-C', installed]);
  const bundle = join(installed, 'package'), profile = join(home, 'profiles/test');
  symlinkSync(modules, join(home, 'node_modules'));
  mkdirSync(join(profile, 'node_modules/@toddzheng024'), { recursive: true });
  symlinkSync(bundle, join(profile, 'node_modules', desktopPresetPackage));
  symlinkSync(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [desktopPresetPackage]: `file:${bundle}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', desktopPresetPackage] } } }));
  for (const name of ['desktop-provider-probe.mjs', 'desktop-provider-network-probe.mjs']) cpSync(join(root, 'scripts', name), join(home, name));
  const base = `http://127.0.0.1:${server.address().port}`;
  const native = prefix => ({ api: 'openai-completions', baseURL: base + prefix + '/v1', apiKeyEnv: 'NATIVE_FIXTURE_KEY', models: [{ id: 'native-fixture', contextWindow: 32768, maxTokens: 4096 }] });
  writeFileSync(join(profile, 'cordis.patch.yml'), stringify([
    { id: 'frontend', disabled: true }, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'product-analytics', config: { enabled: false } }, { id: 'dscode-session-cards', config: { enabled: false } },
    { id: 'session-title-llm', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { openrouter: native('/native-openrouter'), 'native-fixture': native('/native') } } },
    { id: 'dscode-openrouter', config: { providerName: 'dscode-openrouter', baseURL: base + '/openrouter/v1' } },
    { id: 'dscode-grok', config: { baseURL: base + '/grok/v1' } },
    { insert: [{ id: 'desktop-provider-probe', name: join(home, 'desktop-provider-probe.mjs') }] },
  ]));
  mkdirSync(join(home, 'user'));
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: join(home, 'user'), DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', ZDOTDIR: home, DSCODE_PROVIDER_URL: base });
  for (const reload of [false, true]) {
    const child = spawn(process.execPath, ['--import', join(home, 'desktop-provider-network-probe.mjs'), join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'test', '--no-open'], {
      cwd: home, env: { ...env, DSCODE_PROVIDER_RELOAD: reload ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
    assert.equal(code, 0, output.replace(/token=[^\s"&]+/g, 'token=<redacted>'));
    assert(output.includes('DESKTOP_PROVIDERS_PASSED'), output);
    console.log(output.split('\n').find(line => line.startsWith('DESKTOP_PROVIDERS_PASSED')));
  }
  for (const [path, key] of [['/native-openrouter', 'native-fixture-key'], ['/native', 'native-fixture-key'], ['/openrouter', 'desktop-provider-fixture-key'], ['/grok', 'grok-fixture-token'], ['/go', 'go-fixture-token']]) {
    const matching = calls.filter(call => call.path === path + '/v1/chat/completions');
    assert.equal(matching.length, 2, `Expected one call per Host boot for ${path}`);
    for (const call of matching) assert.equal(call.headers.authorization, 'Bearer ' + key);
  }
  const routed = calls.find(call => call.path === '/openrouter/v1/chat/completions');
  assert.equal(routed.body.reasoning.effort, 'xhigh'); assert(JSON.stringify(routed.body).includes('DSCODE ULTRA'));
  assert.equal(calls.find(call => call.path === '/go/v1/chat/completions').headers['x-opencode-org-id'], 'fixture-org');
  const receipt = { runtime: packed.runtime, surface: 'independent native Host', packedComposition: true, packageSha256: packed.sha256,
    nativeProvidersPreserved: true, fiveNativeAgentRoutes: true, restartCredentials: true, openrouterUltra: true,
    grokLoginReadOnly: true, goGrantAndLogout: true, accountRpcAuth: true, liveModelInference: false };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, `artifacts/local/desktop-providers-${packed.runtime}.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log('DESKTOP_PROVIDER_ROUTES_PASSED ' + JSON.stringify(receipt));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  removeDesktopProbeHome(home);
}
