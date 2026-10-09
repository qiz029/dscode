import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { customRequest, apply } from '../plugins/custom/desktop-host.mjs';
import { CustomProviders } from '../plugins/custom/index.mjs';
import { CustomStore } from '../plugins/custom/config.mjs';

const profile = () => ({ id: 'custom-desktop', name: 'Desktop fixture', baseURL: 'http://localhost/v1', api: 'chat-completions', auth: 'bearer',
  models: [{ id: 'vision', contextWindow: 32000, contextSource: 'server', maxTokens: 1000, outputSource: 'server', inputModalities: ['text', 'image'] }] });

test('Desktop mutations require a revision and a stale editor cannot change a saved key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dscode-custom-settings-'));
  const keys = new Map();
  const service = new CustomProviders({ store: new CustomStore(join(directory, 'providers.yaml')), credentials: {
    describe: async () => ({ configured: keys.size > 0, source: 'file' }), set: async (ref, value) => keys.set(ref, value), unset: async ref => keys.delete(ref),
  } });
  try {
    const initial = await customRequest(service, { action: 'list' });
    await assert.rejects(customRequest(service, { action: 'save', profile: profile(), key: 'initial' }), /Reload/);
    assert.equal(keys.size, 0);
    const saved = await customRequest(service, { action: 'save', profile: profile(), key: 'initial', revision: initial.revision });
    assert.equal(saved.providers.length, 1);
    await assert.rejects(customRequest(service, { action: 'save', profile: { ...profile(), name: 'Stale' }, key: 'replacement', revision: initial.revision }), /changed|reload/i);
    assert.deepEqual([...keys.values()], ['initial']);
    await assert.rejects(customRequest(service, { action: 'remove', id: profile().id, revision: initial.revision }), /changed|reload/i);
    assert.equal(keys.size, 1);
    const removed = await customRequest(service, { action: 'remove', id: profile().id, revision: saved.revision });
    assert.deepEqual(removed.providers, []); assert.equal(keys.size, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Desktop configuration uses a scoped Connection endpoint and redacts draft keys from failures', async () => {
  let route;
  apply({ get: () => ({ save: async () => { throw Error('Cannot use synthetic-private-key'); } }), logger: { error: assert.fail },
    inject: async (_names, callback) => callback({ effect: fn => fn(), connection: { fetch: { register: options => { route = options; return () => {}; } } } }),
  });
  assert.equal(route.path, '/api/dscode-custom');
  const send = body => route.fetch(new Request('http://localhost/api/dscode-custom', { method: 'POST', body: JSON.stringify(body) }));
  assert.equal((await send({ method: 'other' })).status, 400);
  const response = await send({ type: 'client-request', rpcId: 'fixture', method: 'dscode-custom', payload: { action: 'save', revision: 'revision', key: 'synthetic-private-key' } });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.result.ok, false); assert.match(body.result.error.message, /\[redacted\]/);
  assert(!JSON.stringify(body).includes('synthetic-private-key'));
});

async function ui(t, dispatch) {
  let module, Component, props, renderer, requestDone;
  runInNewContext(readFileSync(new URL('../plugins/custom/desktop-client.mjs', import.meta.url), 'utf8'), {
    AbortController, AbortSignal, crypto,
    globalThis: { __ModuleLoader__: { load: value => { module = value; } } },
  });
  module.factory(name => { assert.equal(name, 'react'); return React; }).apply({
    slots: { inject: (_name, callback) => callback(), register: (spec, component) => { assert.equal(spec.name, 'settings.section'); props = spec.inject(); Component = component; } },
    connection: { rpc: { call: async (_path, method, request, signal) => {
      assert.equal(method, 'dscode-custom');
      try { requestDone = Promise.resolve(dispatch(request, signal)); return { ok: true, value: await requestDone }; } catch (error) { return { ok: false, error: { message: error.message } }; }
    } } },
  });
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  await act(async () => { await requestDone; });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const field = label => renderer.root.findByProps({ 'aria-label': label });
  const button = label => renderer.root.findAllByType('button').find(node => node.children.includes(label));
  const click = async label => { await act(async () => { await button(label).props.onClick(); }); };
  const change = async (label, value) => { await act(async () => { field(label).props.onChange({ target: { value, checked: value } }); }); };
  return { field, button, click, change, unmount: async () => { await act(async () => renderer.unmount()); }, get root() { return renderer.root; } };
}

for (const field of ['API base URL', 'API format', 'Model 1 ID']) test(`changing ${field} clears image capability and server-reported limits`, async t => {
  const f = await ui(t, async () => ({ revision: 'first', providers: [profile()] }));
  assert.equal(f.field('Model 1 accepts images').props.checked, true);
  await f.change(field, field === 'API format' ? 'responses' : field === 'Model 1 ID' ? 'other' : 'http://elsewhere/v1');
  assert.equal(f.field('Model 1 accepts images').props.checked, false);
  assert.equal(f.field('Model 1 context').props.value, '');
  assert.equal(f.field('Model 1 output limit').props.value, '');
  assert.equal(f.button('Save provider').props.disabled, true);
});

test('a save conflict preserves the draft and key; a successful save clears the key and updates the revision', async t => {
  let conflict = true;
  const requests = [];
  const f = await ui(t, async request => {
    requests.push(request);
    if (request.action === 'save') {
      if (conflict) throw Error('Providers changed; reload before saving.');
      return { revision: 'second', providers: [request.profile] };
    }
    return { revision: 'first', providers: [profile()] };
  });
  await f.change('Provider name', 'Edited'); await f.change('API key', 'draft-key');
  await f.click('Save provider');
  assert.equal(f.field('Provider name').props.value, 'Edited'); assert.equal(f.field('API key').props.value, 'draft-key');
  assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 1);
  conflict = false;
  await f.click('Save provider');
  assert.equal(f.field('API key').props.value, '');
  await f.click('Save provider');
  assert.equal(requests.at(-1).revision, 'second'); assert.equal(requests.at(-1).key, '');
});

test('removing a provider requires the explicit second click and includes the current revision', async t => {
  const requests = [];
  const f = await ui(t, async request => { requests.push(request); return { revision: 'first', providers: request.action === 'remove' ? [] : [profile()] }; });
  await f.click('Remove provider'); assert.equal(requests.length, 1);
  await f.click('Confirm remove provider and key');
  assert.deepEqual(structuredClone(requests.at(-1)), { action: 'remove', id: 'custom-desktop', revision: 'first' });
  assert.equal(f.root.findAllByProps({ 'aria-label': 'API key' }).length, 0);
});

test('changing a draft key clears the earlier model test result', async t => {
  const f = await ui(t, async request => request.action === 'test' ? [{ name: 'Text and streaming', status: 'passed' }] : { revision: 'first', providers: [profile()] });
  await f.click('Test model 1');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Model test results' }).length, 1);
  await f.change('API key', 'different-key');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Model test results' }).length, 0);
  assert.equal(f.root.findByProps({ role: 'status' }).children[0], 'Unsaved changes');
});

test('Desktop test results name the tested model in a multi-model provider', async t => {
  const saved = profile(); saved.models.push({ id: 'second', contextWindow: 16000 });
  const requests = [];
  const f = await ui(t, async request => {
    if (request.action === 'test') { requests.push(request.model); return [{ name: 'Text and streaming', status: 'passed' }]; }
    return { revision: 'first', providers: [saved] };
  });
  await f.click('Test model 1');
  assert.equal(f.root.findAllByType('h3').find(node => String(node.children[0]).startsWith('Test results:')).children[0], 'Test results: vision');
  await f.click('Test model 2');
  assert.equal(f.root.findAllByType('h3').find(node => String(node.children[0]).startsWith('Test results:')).children[0], 'Test results: second');
  assert.deepEqual(requests, ['vision', 'second']);
});

test('Desktop clears an earlier success while a new test waits and after its transport fails', async t => {
  const saved = profile(); saved.models.push({ id: 'second', contextWindow: 16000 });
  const held = Promise.withResolvers();
  const f = await ui(t, async request => {
    if (request.action === 'test') return request.model === 'vision' ? [{ name: 'Text and streaming', status: 'passed' }] : held.promise;
    return { revision: 'first', providers: [saved] };
  });
  await f.click('Test model 1');
  let running;
  await act(async () => { running = f.button('Test model 2').props.onClick(); });
  try {
    assert.equal(f.button('Test model 1').props.disabled, true);
    assert.equal(f.root.findAllByProps({ 'aria-label': 'Model test results' }).length, 0);
  } finally {
    await act(async () => { held.reject(Error('Test connection failed')); await running; });
  }
  assert.equal(f.root.findByProps({ role: 'alert' }).children[0], 'Test connection failed');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Model test results' }).length, 0);
  assert.equal(f.button('Test model 2').props.disabled, false);
});

test('Desktop discovery refreshes existing limits without losing model choices or saving the draft', async t => {
  const saved = profile();
  saved.models[0].thinking = 'on';
  saved.models.push({ id: 'manual', contextWindow: 16000, contextSource: 'user' });
  const requests = [];
  const f = await ui(t, async request => {
    requests.push(structuredClone(request));
    if (request.action === 'discover') return { backend: 'omlx', models: [
      { id: 'new', contextWindow: 24000, contextSource: 'server', thinking: 'default' },
      { id: 'vision', contextWindow: 64000, contextSource: 'server', maxTokens: 8000, outputSource: 'server', thinking: 'default' },
    ] };
    return { revision: 'first', providers: [request.profile ?? saved] };
  });
  await f.change('API key', 'draft-key');
  await f.click('Discover models');
  assert.equal(f.field('Model 1 context').props.value, 64000);
  assert.equal(f.field('Model 1 output limit').props.value, 8000);
  assert.equal(f.field('Model 1 thinking').props.value, 'on');
  assert.equal(f.field('Model 1 accepts images').props.checked, true);
  assert.equal(f.field('Model 2 ID').props.value, 'manual');
  assert.equal(f.field('Model 3 ID').props.value, 'new');
  assert.equal(f.field('Model 3 accepts images').props.checked, false);
  assert.equal(f.field('API key').props.value, 'draft-key');
  assert.deepEqual(requests.map(request => request.action), ['list', 'discover']);
  await f.click('Save provider');
  const request = requests.at(-1);
  assert.equal(request.action, 'save');
  assert.equal(request.profile.backend, 'omlx');
  assert.equal(request.profile.models[0].contextSource, 'server');
  assert.equal(request.profile.models[0].contextWindow, 64000);
  assert.equal(request.profile.models[0].maxTokens, 8000);
  assert.equal(request.key, 'draft-key');
  assert.equal(request.revision, 'first');
});

for (const override of ['context', 'output', 'blank output']) test(`Desktop discovery preserves a user ${override} override while refreshing the other limit`, async t => {
  let saved;
  const f = await ui(t, async request => {
    if (request.action === 'discover') return { backend: 'generic', models: [
      { id: 'vision', contextWindow: 64000, contextSource: 'server', maxTokens: 8000, outputSource: 'server', thinking: 'default' },
    ] };
    if (request.action === 'save') saved = structuredClone(request.profile);
    return { revision: 'first', providers: [request.profile ?? profile()] };
  });
  if (override === 'context') await f.change('Model 1 context', '48000');
  else await f.change('Model 1 output limit', override === 'output' ? '2000' : '');
  await f.click('Discover models');
  assert.equal(f.field('Model 1 context').props.value, override === 'context' ? 48000 : 64000);
  assert.equal(f.field('Model 1 output limit').props.value, override === 'context' ? 8000 : override === 'output' ? 2000 : '');
  await f.click('Save provider');
  assert.equal(saved.models[0].contextSource, override === 'context' ? 'user' : 'server');
  assert.equal(saved.models[0].outputSource, override === 'context' ? 'server' : 'user');
  if (override === 'blank output') assert.equal(saved.models[0].maxTokens, undefined);
});

for (const override of ['numeric context', 'blank output']) test(`Desktop discovery persists refreshed HTTP metadata and preserves a ${override} override on reload`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dscode-discovery-ui-'));
  let contextWindow = 64000, outputLimit = 8000, discoveries = 0;
  const server = createServer((request, response) => {
    if (request.url !== '/v1/models' || request.headers.authorization !== 'Bearer fixture-key') {
      response.writeHead(403); response.end(); return;
    }
    discoveries++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'vision', context_window: contextWindow, max_output_tokens: outputLimit }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const store = new CustomStore(join(directory, 'providers.yaml'));
  const service = new CustomProviders({ store, credentials: {
    describe: async () => ({ configured: true, source: 'file' }), resolve: async () => ({ value: 'fixture-key' }),
  } });
  const initial = profile(); initial.baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  initial.models[0].thinking = 'on';
  await service.save(initial, '', (await store.read()).revision);
  const f = await ui(t, request => customRequest(service, request));
  await f.click('Discover models');
  assert.equal(f.field('Model 1 context').props.value, 64000);
  assert.equal((await store.read()).providers[0].models[0].contextWindow, 32000);
  await f.click('Save provider');
  assert.equal((await store.read()).providers[0].models[0].contextWindow, 64000);
  await f.change(override === 'numeric context' ? 'Model 1 context' : 'Model 1 output limit', override === 'numeric context' ? '48000' : '');
  await f.click('Save provider');
  await f.click('Reload (discard draft)');
  contextWindow = 96000; outputLimit = 12000;
  await f.click('Discover models');
  assert.equal(f.field('Model 1 context').props.value, override === 'numeric context' ? 48000 : 96000);
  assert.equal(f.field('Model 1 output limit').props.value, override === 'numeric context' ? 12000 : '');
  await f.click('Save provider');
  const persisted = (await store.read()).providers[0].models[0];
  assert.equal(persisted.contextWindow, override === 'numeric context' ? 48000 : 96000);
  assert.equal(persisted.contextSource, override === 'numeric context' ? 'user' : 'server');
  assert.equal(persisted.maxTokens, override === 'numeric context' ? 12000 : undefined);
  assert.equal(persisted.outputSource, override === 'numeric context' ? 'server' : 'user');
  assert.equal(persisted.thinking, 'on');
  assert.deepEqual(persisted.inputModalities, ['text', 'image']);
  assert.equal(discoveries, 2);
  assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0);
});

for (const action of ['discover', 'test']) for (const outcome of ['reject', 'late success']) {
  test(`Desktop cancels ${action} with ${outcome}, preserves the draft and allows retry`, async t => {
    const held = Promise.withResolvers();
    let signal, attempts = 0;
    const result = action === 'discover'
      ? { backend: 'generic', models: [{ id: 'vision', contextWindow: 64000, contextSource: 'server' }] }
      : [{ name: 'Text and streaming', status: 'passed' }];
    const f = await ui(t, (request, requestSignal) => {
      if (request.action !== action) return { revision: 'first', providers: [profile()] };
      signal = requestSignal;
      return ++attempts === 1 ? held.promise : result;
    });
    await f.change('Provider name', 'Unsaved provider');
    await f.change('API key', 'unsaved-key');
    const label = action === 'discover' ? 'Discover models' : 'Test model 1';
    let running;
    await act(async () => { running = f.button(label).props.onClick(); });
    try {
      assert(signal instanceof AbortSignal);
      assert.equal(signal.aborted, false);
      assert.equal(f.button('Cancel request').props.disabled, false);
      await f.click('Cancel request');
      assert.equal(signal.aborted, true);
      assert.equal(f.button('Cancel request').props.disabled, true);
    } finally {
      await act(async () => {
        if (outcome === 'reject') held.reject(Error('Aborted upstream request'));
        else held.resolve(result);
        await running;
      });
    }
    assert.equal(f.field('Provider name').props.value, 'Unsaved provider');
    assert.equal(f.field('API key').props.value, 'unsaved-key');
    assert.equal(f.field('Model 1 context').props.value, 32000);
    assert.equal(f.root.findAllByProps({ 'aria-label': 'Model test results' }).length, 0);
    assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0);
    assert.equal(f.root.findByProps({ role: 'status' }).children[0], 'Request cancelled.');
    assert.equal(f.button('Cancel request'), undefined);
    await f.click(label);
    assert.equal(signal.aborted, false);
    assert.equal(attempts, 2);
    if (action === 'discover') assert.equal(f.field('Model 1 context').props.value, 64000);
    else assert.equal(f.root.findAllByProps({ 'aria-label': 'Model test results' }).length, 1);
  });
}

for (const action of ['discover', 'test', 'save']) {
  test(`closing Desktop settings ${action === 'save' ? 'does not cancel a save' : `cancels ${action}`}`, async t => {
    const held = Promise.withResolvers();
    let signal;
    const f = await ui(t, (request, requestSignal) => {
      if (request.action !== action) return { revision: 'first', providers: [profile()] };
      signal = requestSignal;
      return held.promise;
    });
    let running;
    await act(async () => { running = f.button(action === 'discover' ? 'Discover models' : action === 'test' ? 'Test model 1' : 'Save provider').props.onClick(); });
    try {
      if (action === 'save') { assert.equal(signal, undefined); assert.equal(f.button('Cancel request'), undefined); }
      else assert.equal(signal?.aborted, false);
      await f.unmount();
      if (action !== 'save') assert.equal(signal.aborted, true);
    } finally {
      await act(async () => { held.reject(Error('Request ended after closing')); await running; });
    }
  });
}


test('Desktop explicit cancellation covers a proxy that keeps its HTTP request alive', async () => {
  let route, cleanup, signal;
  const service = { test: async (_profile, _model, _key, incoming) => {
    signal = incoming;
    await new Promise(resolve => incoming.addEventListener('abort', resolve, { once: true }));
    return [{ name: 'Probe', status: 'failed', message: 'Cancelled' }];
  } };
  apply({ get: () => service, logger: { error: assert.fail }, inject: async (_names, callback) => callback({
    effect: fn => { cleanup = fn(); }, connection: { fetch: { register: options => { route = options; return () => {}; } } },
  }) });
  const send = async payload => (await (await route.fetch(new Request('http://localhost/api/dscode-custom', {
    method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'dscode-custom', payload }),
  }))).json()).result;
  const requestId = crypto.randomUUID();
  const running = send({ action: 'test', requestId, profile: profile(), model: 'vision' });
  // Wait for the buffered request body to reach the service.
  for (let i = 0; !signal && i < 100; i++) await new Promise(resolve => setImmediate(resolve));
  try {
    assert.equal(signal.aborted, false);
    assert.equal((await send({ action: 'cancel', requestId })).ok, true);
    assert.equal(signal.aborted, true);
    assert.equal((await running).ok, true);
    assert.equal((await send({ action: 'test', requestId })).ok, false);
    const early = crypto.randomUUID();
    assert.equal((await send({ action: 'cancel', requestId: early })).ok, true);
    assert.equal((await send({ action: 'test', requestId: early })).ok, false);
    assert.equal((await send({ action: 'cancel', requestId: 'invalid' })).ok, false);
    assert.equal((await send({ action: 'save', requestId: crypto.randomUUID() })).ok, false);
  } finally { cleanup(); }
});


test('Desktop reports a failed cancellation acknowledgement without claiming success', async t => {
  const held = Promise.withResolvers();
  const f = await ui(t, (request, signal) => {
    if (request.action === 'cancel') throw Error('Host disconnected');
    if (request.action === 'test') {
      signal.addEventListener('abort', () => held.reject(Error('Fetch aborted')), { once: true });
      return held.promise;
    }
    return { revision: 'first', providers: [profile()] };
  });
  let running;
  await act(async () => { running = f.button('Test model 1').props.onClick(); });
  try { await f.click('Cancel request'); }
  finally { await act(async () => { held.resolve([]); await running; }); }
  assert.match(f.root.findByProps({ role: 'alert' }).children[0], /Could not confirm server cancellation/);
  assert.equal(f.root.findByProps({ role: 'status' }).children[0], 'Cancellation could not be confirmed.');
});
