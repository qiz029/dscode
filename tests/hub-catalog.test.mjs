import test from 'node:test';
import assert from 'node:assert/strict';
import { HubCatalog, desktopCandidate, catalogDetail, hubApi } from '../plugins/hub/catalog.mjs';
import { DesktopHub, registerHubTools } from '../plugins/hub/desktop-host.mjs';

export const environment = { runtime: '0.2.0-rc.2', node: '24.14.1', platform: 'darwin' };
export function record() {
  return { id: 'bcf7f9b6-d4ce-45ba-9c34-7c353d988965', slug: 'fixture-plugin', packageName: '@fixture/plugin', displayName: 'Fixture', summary: 'Search fixture', description: 'Third-party description',
    repository: 'fixture/plugin', categories: ['developer-tools'], keywords: [], claimed: true, verified: false, deprecated: false,
    latestVersion: '1.0.0', distTags: { latest: '1.0.0' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
    weeklyDownloads: 3, versions: [{ version: '1.0.0', manifest: { name: '@fixture/plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } },
      source: { kind: 'npm', packageName: '@fixture/plugin', version: '1.0.0', tarballUrl: 'https://registry.npmjs.org/fixture.tgz', installSpec: 'DO NOT EXECUTE ME' },
      compatibility: { dsh: '0.2.0-rc.2', node: '>=24', platforms: ['darwin'], surfaces: ['web'], hmr: 'restart' },
      publishedAt: '2026-10-01T00:00:00Z', yanked: false }] };
}

test('Hub catalog uses the public API and shared schema, encodes filters, and rejects malformed responses', async () => {
  const calls = []; let body;
  const catalog = new HubCatalog({ fetch: async (url, options) => { calls.push({ url, options }); return Response.json(body); } });
  const { versions: _versions, ...item } = record();
  body = { items: [item], nextCursor: 'next&cursor', total: 2 };
  assert.equal((await catalog.search({ query: '  tools & tests ', category: 'developer-tools', cursor: 'a?b' })).items[0].displayName, 'Fixture');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${hubApi}/packages`); assert.equal(url.searchParams.get('q'), 'tools & tests');
  assert.equal(url.searchParams.get('category'), 'developer-tools'); assert.equal(url.searchParams.get('cursor'), 'a?b');
  assert.equal(calls[0].options.redirect, 'error'); assert.deepEqual(calls[0].options.headers, { accept: 'application/json' });
  body = { items: [item], nextCursor: null, total: 45 };
  assert.equal((await catalog.search()).nextPage, 2);
  assert.equal((await catalog.search({ page: 2 })).nextPage, 3);
  assert.equal(new URL(calls.at(-1).url).searchParams.get('page'), '2');
  assert.equal((await catalog.search({ page: 3 })).nextPage, null);
  await assert.rejects(catalog.search({ page: 0 }));
  body = record(); assert.equal((await catalog.package('@fixture/plugin')).latestVersion, '1.0.0');
  assert.equal(new URL(calls.at(-1).url).searchParams.get('name'), '@fixture/plugin');
  await assert.rejects(catalog.package('https://evil.invalid/pkg'), /Invalid npm package name/);
  await assert.rejects(catalog.search({ query: 'x'.repeat(301) }));
  body = { items: [{ name: 'developer-tools', displayName: 'Developer tools', count: 1 }] };
  assert.equal((await catalog.categories()).items[0].count, 1);
  body = { items: 'bad' }; await assert.rejects(catalog.search(), /unsupported catalog/);
});

test('Hub failures, response size, timeout and caller cancellation stop the request', async () => {
  await assert.rejects(new HubCatalog({ fetch: async () => new Response('private diagnostic', { status: 503 }) }).categories(), /HTTP 503/);
  await assert.rejects(new HubCatalog({ fetch: async () => new Response('bad json') }).categories(), /invalid JSON/);
  await assert.rejects(new HubCatalog({ fetch: async () => new Response(null) }).categories(), /empty response/);
  await assert.rejects(new HubCatalog({ maxBytes: 5, fetch: async () => new Response('123456') }).categories(), /too large/);
  const wait = (_url, { signal }) => new Promise((_resolve, reject) => { signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(new HubCatalog({ fetch: wait, timeoutMs: 5 }).categories(), /timeout/i); } finally { clearTimeout(keepAlive); }
  const controller = new AbortController(); const pending = new HubCatalog({ fetch: wait }).categories(controller.signal); controller.abort();
  await assert.rejects(pending, /abort/i);
});

test('Desktop preflight rejects terminal, incompatible, withdrawn and conflicting identities without trusting installSpec', () => {
  const value = record(); assert.equal(desktopCandidate(value, environment).spec, '@fixture/plugin@1.0.0');
  assert.deepEqual(desktopCandidate(value, environment).reasons, []);
  const change = edit => { const next = record(); edit(next, next.versions[0]); return desktopCandidate(next, environment); };
  assert.deepEqual(change((_p, v) => { v.compatibility.dsh = '*'; }).reasons, [], 'Use the official manager prerelease range semantics');
  assert.match(change((_p, v) => { v.compatibility.surfaces = ['headless']; }).reasons.join(), /Desktop interface/);
  assert.match(change((_p, v) => { v.compatibility.platforms = ['linux']; }).reasons.join(), /darwin/);
  assert.match(change((_p, v) => { v.compatibility.dsh = '0.1.7-alpha.2'; }).reasons.join(), /Requires DSH/);
  assert.match(change((_p, v) => { v.compatibility.node = '>=26'; }).reasons.join(), /Requires Node/);
  assert.match(change((_p, v) => { v.compatibility.dsh = 'anything'; }).reasons.join(), /Requires DSH/);
  assert.match(change((_p, v) => { v.yanked = true; }).reasons.join(), /withdrawn/);
  assert.match(change(p => { p.deprecated = true; }).reasons.join(), /deprecated/);
  assert.equal(change((_p, v) => { v.source.packageName = '@other/plugin'; }).spec, null);
  assert.equal(change((_p, v) => { v.source.kind = 'github'; }).spec, null);
  assert.match(desktopCandidate(value, environment, '2.0.0').reasons.join(), /absent/);
  const detail = catalogDetail(value, environment); assert.equal(detail.security, null); assert.equal(detail.verified, false);
  assert.equal(detail.url, 'https://dshpluginhub.ai/plugins/fixture-plugin');
});

function fixture() {
  const value = record(), calls = [], tools = []; let installed = [], inspected, result, finish;
  const manager = {
    listBundles: async () => installed,
    inspect: async spec => { calls.push(['inspect', spec]); return inspected ?? { status: 'accepted', kind: 'registry', name: value.packageName, version: '1.0.0', bundle: true, registry: 'https://registry.npmjs.org/' }; },
    installBundle: async (spec, options) => { calls.push(['install', spec, options]); if (result) return result; return new Promise(resolve => { finish = resolve; }); },
    cancelInstall: async id => { calls.push(['cancel', id]); finish?.({ application: 'cancelled', stage: 'install', target: value.packageName, changed: false }); return { status: 'cancelled' }; },
  };
  const catalog = { package: async name => { assert.equal(name, value.packageName); return structuredClone(value); }, categories: async () => ({ items: [] }), search: async () => ({ items: [value], nextCursor: null }) };
  let time = 1;
  const hub = new DesktopHub({ catalog, manager, environment, now: () => time });
  return { hub, value, calls, tools, setInstalled: items => { installed = items; }, setInspection: value => { inspected = value; }, setResult: value => { result = value; }, finish: value => finish(value), advance: () => { time += 300001; } };
}

test('official manager receives an exact reviewed spec once; results survive page remount and cancellation is retained', async t => {
  const f = fixture(); t.after(() => f.hub.dispose());
  assert.equal((await f.hub.request({ action: 'status' })).operation, null);
  const preview = await f.hub.request({ action: 'prepare', packageName: f.value.packageName });
  await assert.rejects(f.hub.request({ action: 'install', token: preview.token }), /Confirm/);
  const running = await f.hub.request({ action: 'install', token: preview.token, confirm: true });
  await new Promise(setImmediate);
  assert.equal(running.status, 'running'); assert.equal(running.promise, undefined);
  assert.deepEqual(f.calls[1], ['install', '@fixture/plugin@1.0.0', { enabled: false, requestId: running.requestId, registry: 'https://registry.npmjs.org/' }]);
  await assert.rejects(f.hub.request({ action: 'install', token: preview.token, confirm: true }), /expired/);
  const another = await f.hub.request({ action: 'prepare', packageName: f.value.packageName });
  await assert.rejects(f.hub.request({ action: 'install', token: another.token, confirm: true }), /already running/);
  assert.equal((await f.hub.request({ action: 'status' })).operation.requestId, running.requestId);
  await f.hub.request({ action: 'cancel', requestId: running.requestId });
  await f.hub.operations.get(running.requestId).promise;
  assert.equal((await f.hub.request({ action: 'operation', requestId: running.requestId })).result.application, 'cancelled');
  assert.equal((await f.hub.request({ action: 'cancel', requestId: running.requestId })).status, 'finished');
  f.advance(); await assert.rejects(f.hub.request({ action: 'install', token: another.token, confirm: true }), /expired/);
  await assert.rejects(f.hub.request({ action: 'operation', requestId: 'missing' }), /no longer tracked/);
});

test('installed packages, rejected inspection and stale catalog identity cannot proceed to installation', async t => {
  const f = fixture(); t.after(() => f.hub.dispose()); const payload = { action: 'prepare', packageName: f.value.packageName };
  f.setInstalled([{ name: f.value.packageName, enabled: true, version: '0.9.0' }]);
  assert.equal((await f.hub.request({ ...payload, action: 'detail' })).installed.version, '0.9.0');
  await assert.rejects(f.hub.request(payload), /already available/); f.setInstalled([]);
  f.value.versions[0].compatibility.surfaces = ['headless']; await assert.rejects(f.hub.request(payload), /Desktop interface/);
  f.value.versions[0].compatibility.surfaces = ['desktop'];
  f.setInspection({ status: 'refused', reason: 'Registry unavailable' }); await assert.rejects(f.hub.request(payload), /Registry unavailable/);
  f.setInspection({ status: 'accepted', kind: 'registry', name: f.value.packageName, version: '2.0.0', bundle: true });
  await assert.rejects(f.hub.request(payload), /does not match/); assert(!f.calls.some(call => call[0] === 'install'));
});

test('failed/restart-required outcomes are not rewritten to success; dispose cancels running work', async () => {
  for (const application of ['failed', 'restart-required', 'overridden', 'applied']) {
    const f = fixture(); const result = { application, stage: 'install', target: f.value.packageName, changed: false, warnings: ['test warning'] };
    f.setResult(result); const preview = await f.hub.request({ action: 'prepare', packageName: f.value.packageName });
    const started = await f.hub.request({ action: 'install', token: preview.token, confirm: true });
    await f.hub.operations.get(started.requestId).promise;
    assert.deepEqual(f.hub.operation(started.requestId).result, result); await f.hub.dispose();
  }
  const f = fixture(); const preview = await f.hub.request({ action: 'prepare', packageName: f.value.packageName });
  const started = await f.hub.request({ action: 'install', token: preview.token, confirm: true }); await f.hub.dispose();
  assert.equal(f.hub.operation(started.requestId).result.application, 'cancelled');
  await assert.rejects(f.hub.request({ action: 'status' }), /abort/i);
});

test('an installation elsewhere after preview is not silently replaced, and early cancellation never starts pnpm', async t => {
  const f = fixture(); t.after(() => f.hub.dispose());
  const preview = await f.hub.request({ action: 'prepare', packageName: f.value.packageName });
  f.setInstalled([{ name: f.value.packageName, enabled: false, version: '0.9.0' }]);
  const operation = await f.hub.request({ action: 'install', token: preview.token, confirm: true });
  await f.hub.operations.get(operation.requestId).promise;
  assert.match(f.hub.operation(operation.requestId).error, /became available/);
  assert(!f.calls.some(call => call[0] === 'install'));
  f.setInstalled([]);
  const next = await f.hub.request({ action: 'prepare', packageName: f.value.packageName });
  const running = await f.hub.request({ action: 'install', token: next.token, confirm: true });
  await f.hub.request({ action: 'cancel', requestId: running.requestId });
  await f.hub.operations.get(running.requestId).promise;
  assert.equal(f.hub.operation(running.requestId).result.application, 'cancelled');
  assert(!f.calls.some(call => call[0] === 'install'));
});

test('conversation tools share catalog data and provide no mutation tool', async t => {
  const f = fixture(); t.after(() => f.hub.dispose());
  registerHubTools({ tools: { register: tool => f.tools.push(tool) } }, f.hub);
  assert.deepEqual(f.tools.map(tool => tool.name), ['plugin_hub_search', 'plugin_hub_info']);
  const search = await f.tools[0].execute({ query: 'test' }, {});
  assert.equal(search.items[0].packageName, f.value.packageName); assert.equal(search.items[0].versions, undefined);
  const detail = await f.tools[1].execute({ packageName: f.value.packageName }, {});
  assert.equal(detail.candidate.spec, '@fixture/plugin@1.0.0'); assert.equal(f.calls.length, 0);
});
