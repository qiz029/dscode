import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

async function render(t, handler, status = null) {
  let definition, Component, props, tick;
  const requests = [], managed = [];
  runInNewContext(readFileSync(new URL('../plugins/hub/desktop-client.mjs', import.meta.url), 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } },
    setInterval: callback => { tick = callback; return 1; }, clearInterval() {},
  });
  definition.factory(() => React).apply({ get: () => ({ openBundle: name => managed.push(name) }),
    slots: { inject: (_name, fn) => fn(), register: (spec, component) => { props = spec.inject(); Component = component; return () => {}; } },
    connection: { rpc: { call: async (path, method, payload) => {
      assert.equal(path, '/api'); assert.equal(method, 'dscode-hub'); requests.push(payload);
      if (payload.action === 'categories') return { ok: true, value: { items: [{ name: 'developer-tools', displayName: 'Developer tools', count: 3 }] } };
      if (payload.action === 'status') return { ok: true, value: { operation: status } };
      return handler(payload);
    } } },
  });
  let renderer; await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const buttons = label => renderer.root.findAllByType('button').filter(button => button.children.join('') === label);
  return { renderer, requests, managed, tick: () => tick(), text: () => JSON.stringify(renderer.toJSON()),
    click: async (label, index = 0) => { const button = buttons(label)[index]; assert(button, `Missing button: ${label}`); assert(!button.props.disabled, `Disabled: ${label}`); await act(async () => button.props.onClick()); },
    button: label => buttons(label)[0] };
}
const item = { packageName: '@fixture/plugin', displayName: 'Fixture plugin', summary: 'Test plugin', latestVersion: '1.0.0', deprecated: false, security: { status: 'failed', dependencyInventoryComplete: false, advisoryScanned: true, behaviorAnalyzed: false } };
const detail = { ...item, description: 'Detailed description', categories: ['developer-tools'], weeklyDownloads: 3, repository: 'fixture/plugin', license: 'MIT', claimed: true, verified: false,
  url: 'https://dshpluginhub.ai/plugins/fixture-plugin', environment: { runtime: '0.2.0-rc.2', platform: 'darwin' }, installed: null,
  candidate: { spec: '@fixture/plugin@1.0.0', reasons: [], compatibility: { dsh: '0.2.0-rc.2', surfaces: ['web'], platforms: ['darwin'] } } };
const ok = value => ({ ok: true, value });

test('Hub UI filters and paginates, shows reported scan status, reviews exact version and hands management back', async t => {
  let finish = false;
  const ui = await render(t, async payload => {
    if (payload.action === 'search') return ok({ items: [item], nextCursor: payload.cursor ? null : 'page2' });
    if (payload.action === 'detail') return ok(detail);
    if (payload.action === 'prepare') return ok({ token: 'token', detail, inspection: { registry: 'https://registry.npmjs.org/' } });
    if (payload.action === 'install') return ok({ requestId: 'one', status: 'running', spec: detail.candidate.spec, packageName: item.packageName });
    if (payload.action === 'operation') return ok({ requestId: 'one', status: finish ? 'finished' : 'running', spec: detail.candidate.spec, packageName: item.packageName,
      ...(finish ? { result: { application: 'applied', bundle: item.packageName } } : {}) });
    throw Error(payload.action);
  });
  assert(ui.text().includes('Hub scan: failed'));
  await act(async () => {
    ui.renderer.root.findByProps({ 'aria-label': 'Search plugins' }).props.onChange({ target: { value: 'coding' } });
    ui.renderer.root.findByProps({ 'aria-label': 'Plugin category' }).props.onChange({ target: { value: 'developer-tools' } });
  });
  await act(async () => ui.renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }));
  await ui.click('Load more plugins');
  assert.deepEqual(structuredClone(ui.requests.at(-1)), { action: 'search', query: 'coding', category: 'developer-tools', cursor: 'page2' });
  assert.equal(ui.renderer.root.findAllByType('article').length, 1, 'Pagination deduplicates the same package');
  await ui.click('View details'); assert(ui.text().includes('Publisher unverified')); assert(ui.text().includes('Complete dependency inventory: no'));
  await ui.click('Review installation'); assert(ui.text().includes('Confirm plugin installation'));
  assert(!ui.requests.some(request => request.action === 'install'));
  await ui.click('Confirm installation'); assert.equal(ui.requests.at(-1).confirm, true); assert(ui.text().includes('Installing with the official'));
  finish = true; await act(async () => ui.tick());
  assert(ui.text().includes('Installation completed')); await ui.click('Manage installed plugin');
  assert.deepEqual(ui.managed, ['@fixture/plugin']); assert.equal(ui.button('Review installation'), undefined);
});

test('incompatible and installed packages cannot trigger another install; RPC failures are visible', async t => {
  let installed = false, fail = false;
  const ui = await render(t, async payload => {
    if (fail) return { ok: false, error: { message: 'Hub is unavailable' } };
    if (payload.action === 'search') return ok({ items: [item], nextCursor: null });
    if (payload.action === 'detail') return ok({ ...detail, installed: installed ? { version: '0.9.0', enabled: false } : null, candidate: { ...detail.candidate, reasons: ['Requires a newer Desktop.'] } });
    throw Error(payload.action);
  });
  await ui.click('View details'); assert(ui.text().includes('Requires a newer Desktop')); assert.equal(ui.button('Review installation').props.disabled, true);
  installed = true; await ui.click('View details'); await ui.click('Manage in Plugins');
  assert.deepEqual(ui.managed, ['@fixture/plugin']); assert.equal(ui.button('Review installation'), undefined);
  fail = true; await ui.click('View details'); assert(ui.text().includes('Hub is unavailable')); assert(!ui.text().includes('Detailed description'));
});

test('remount resumes a running installation and distinguishes failure and cancellation from success', async t => {
  let cancelled = false;
  const operation = { requestId: 'recover', status: 'running', spec: detail.candidate.spec, packageName: item.packageName };
  const ui = await render(t, async payload => {
    if (payload.action === 'search') return ok({ items: [], nextCursor: null });
    if (payload.action === 'cancel') { cancelled = true; return ok({ ...operation, status: 'finished', result: { application: 'cancelled' } }); }
    throw Error(payload.action);
  }, operation);
  assert(ui.text().includes('Installing with the official')); await ui.click('Cancel installation');
  assert(cancelled); assert(ui.text().includes('Installation cancelled.')); assert(!ui.text().includes('Installation completed.'));
  const failed = await render(t, async () => ok({ items: [], nextCursor: null }), { ...operation, status: 'finished', result: { application: 'failed', error: { message: 'Dependency build blocked' }, pendingBuilds: ['fixture'] } });
  assert(failed.text().includes('Dependency build blocked')); assert(!failed.text().includes('Installation completed.'));
});

test('responses after unmount do not repopulate a disposed Hub page', async t => {
  let resolve;
  const ui = await render(t, async payload => payload.action === 'search' ? ok({ items: [item], nextCursor: null }) : new Promise(done => { resolve = done; }));
  let request; await act(async () => { request = ui.renderer.root.findAllByType('button').find(button => button.children.join('') === 'View details').props.onClick(); });
  await act(async () => ui.renderer.unmount());
  await act(async () => { resolve(ok(detail)); await request; });
  assert.equal(ui.renderer.toJSON(), null);
});

test('numbered pagination preserves the executed query when the draft query changes', async t => {
  const ui = await render(t, async payload => ok({ items: [item], nextCursor: null, nextPage: payload.page ? null : 2, total: 25 }));
  await act(async () => ui.renderer.root.findByProps({ 'aria-label': 'Search plugins' }).props.onChange({ target: { value: 'not submitted' } }));
  await ui.click('Load more plugins');
  assert.deepEqual(structuredClone(ui.requests.at(-1)), { action: 'search', query: '', category: '', page: 2 });
  assert.equal(ui.button('Load more plugins'), undefined);
});
