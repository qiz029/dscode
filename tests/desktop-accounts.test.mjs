import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { providerAccountRequest, apply } from '../plugins/providers/desktop-host.mjs';
import { providerSpec, pickModel } from '../plugins/providers/catalog.mjs';
import { cacheReadRatio, estimateCost, priceVersionFor } from '../plugins/session-metrics/pricing.mjs';
import { RoutedSearchProvider } from '../plugins/openrouter/search.mjs';
import { requestBody as openRouterBody } from '../plugins/openrouter/wire.mjs';
import { requestBody as goBody } from '../plugins/opencode-go/wire.mjs';

test('desktop provider names retain their own reasoning history without replaying another route', () => {
  for (const [provider, model, body, field] of [
    ['dscode-openrouter', 'deepseek/deepseek-v4-flash', openRouterBody, 'reasoning'],
    ['dscode-opencode-go', 'kimi-k3', goBody, 'reasoning_content'],
  ]) {
    const messages = [{ role: 'assistant', source: { provider, model }, content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'text', text: 'Answer' }] }];
    assert.equal(body({ provider, model, messages }).messages[0][field], 'private reasoning');
    messages[0].source.provider = 'another-route';
    assert.equal(body({ provider, model, messages }).messages[0][field], undefined);
  }
});

function fixture() {
  const keys = new Map(), calls = [];
  let writable = true;
  const credentials = {
    describe: async ref => ({ configured: keys.has(ref), writable: ref === 'OPENROUTER_API_KEY' && writable, source: writable ? 'file' : 'env', secret: 'must-not-project' }),
    set: async (ref, key) => { keys.set(ref, key); }, unset: async ref => keys.delete(ref),
  };
  const login = { status: async () => ['OpenCode fixture'], login: async () => { calls.push('login'); return { ok: true, lines: ['Open the consent page'] }; },
    cancel: () => { calls.push('cancel'); return 'Cancelled'; }, logout: async () => { calls.push('logout'); return 'Signed out'; } };
  const ctx = { get: name => ({ credentials, dscodeOpenCodeLogin: login })[name] };
  return { ctx, keys, calls, login, setWritable: value => { writable = value; } };
}

test('account status is read-only and fixed credential writes reject arbitrary references and environment-owned keys', async () => {
  const f = fixture();
  const initial = await providerAccountRequest(f.ctx, { action: 'status' });
  assert(!JSON.stringify(initial).includes('must-not-project'));
  assert.deepEqual(f.calls, []);
  await assert.rejects(providerAccountRequest(f.ctx, { action: 'set', ref: 'OTHER_KEY', key: 'secret' }), /Unknown/);
  await assert.rejects(providerAccountRequest(f.ctx, { action: 'save-openrouter', key: ' ' }), /empty|blank|missing/i);
  const saved = await providerAccountRequest(f.ctx, { action: 'save-openrouter', key: 'synthetic-key', ref: 'OTHER_KEY' });
  assert.deepEqual([...f.keys], [['OPENROUTER_API_KEY', 'synthetic-key']]);
  assert(saved.openrouter.configured);
  assert(!JSON.stringify(saved).includes('synthetic-key'));
  f.setWritable(false);
  await assert.rejects(providerAccountRequest(f.ctx, { action: 'save-openrouter', key: 'replacement' }), /environment/);
  await assert.rejects(providerAccountRequest(f.ctx, { action: 'remove-openrouter' }), /environment/);
  assert.equal(f.keys.get('OPENROUTER_API_KEY'), 'synthetic-key');
});

test('desktop account actions share the command login state and report a refused login', async () => {
  const f = fixture();
  await providerAccountRequest(f.ctx, { action: 'login-opencode' });
  f.login.attempt = {};
  assert.equal((await providerAccountRequest(f.ctx, { action: 'status' })).opencode.pending, true);
  await providerAccountRequest(f.ctx, { action: 'cancel-opencode' });
  await providerAccountRequest(f.ctx, { action: 'logout-opencode' });
  assert.deepEqual(f.calls, ['login', 'cancel', 'logout']);
  f.login.login = async () => ({ ok: false, lines: ['Fixture refused login'] });
  await assert.rejects(providerAccountRequest(f.ctx, { action: 'login-opencode' }), /refused login/);
});

test('account RPC uses the native connection and removes draft keys from failure messages', async () => {
  const f = fixture();
  f.ctx.get('credentials').set = async () => { throw Error('Failed with synthetic-key'); };
  let route;
  apply({ ...f.ctx, logger: { error: assert.fail }, inject: async (_names, callback) => callback({ effect: fn => fn(), connection: { fetch: { register: value => { route = value; return () => {}; } } } }) });
  const response = await route.fetch(new Request('http://localhost/api/dscode-accounts', { method: 'POST', body: JSON.stringify({
    type: 'client-request', rpcId: 'fixture', method: 'dscode-accounts', payload: { action: 'save-openrouter', key: 'synthetic-key' },
  }) }));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.result.ok, false);
  assert(!JSON.stringify(body).includes('synthetic-key'));
  assert.match(body.result.error.message, /redacted/);
});

test('Desktop OpenRouter keeps pricing, counterpart selection and routed search on the enhanced adapter', async () => {
  assert.equal(providerSpec('dscode-openrouter').credentialRef, 'OPENROUTER_API_KEY');
  const model = 'deepseek/deepseek-v4-flash', time = Date.UTC(2026, 9, 6), usage = { inputTokens: 100, outputTokens: 20 };
  assert.equal(estimateCost('dscode-openrouter', model, usage, time), estimateCost('openrouter', model, usage, time));
  assert.equal(priceVersionFor('dscode-openrouter', model), priceVersionFor('openrouter', model));
  assert.equal(cacheReadRatio('dscode-openrouter', model), cacheReadRatio('openrouter', model));
  const row = { provider: 'dscode-openrouter', model };
  assert.equal(pickModel([row], 'dscode-openrouter', 'deepseek-official/deepseek-flash').row, row);
  const openrouter = {}, deepseek = {};
  const routed = new RoutedSearchProvider({ openrouter, deepseek: () => deepseek, currentProvider: () => 'dscode-openrouter', hasKey: async () => true });
  assert.equal(await routed.pick(), openrouter);
});

test('account settings never sign in on mount, clear saved key drafts, and confirm removal', async t => {
  let definition, Component, props;
  const calls = [], f = fixture();
  runInNewContext(readFileSync(new URL('../plugins/providers/desktop-client.mjs', import.meta.url), 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } }, setInterval, clearInterval,
  });
  definition.factory(() => React).apply({ slots: { inject: (_name, fn) => fn(), register: (spec, component) => { Component = component; props = spec.inject(); } },
    connection: { rpc: { call: async (_path, _method, payload) => { calls.push(payload); return { ok: true, value: await providerAccountRequest(f.ctx, payload) }; } } },
  });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const button = text => renderer.root.findAllByType('button').find(node => node.children.includes(text));
  const click = async text => { await act(async () => { void button(text).props.onClick(); }); };
  assert.deepEqual(calls.map(call => call.action), ['status']);
  const key = () => renderer.root.findByProps({ 'aria-label': 'OpenRouter API key' });
  await act(async () => key().props.onChange({ target: { value: 'synthetic-key' } }));
  await click('Save OpenRouter key');
  assert.equal(key().props.value, '');
  await click('Remove OpenRouter key'); assert(f.keys.has('OPENROUTER_API_KEY'));
  await click('Confirm remove openrouter key'); assert.equal(f.keys.size, 0);
  assert(!renderer.root.findAllByType('input').some(node => /grok|opencode/i.test(node.props['aria-label'] ?? '')));
  f.login.login = async () => { f.login.attempt = {}; return { ok: true, lines: ['Temporary consent code'] }; };
  await click('Sign in to OpenCode Go');
  assert.equal(renderer.root.findByProps({ role: 'status' }).children.join(''), 'Temporary consent code');
  f.login.attempt = undefined;
  f.login.status = async () => ['Signed in'];
  await click('Refresh account status');
  assert.equal(renderer.root.findAllByProps({ role: 'status' }).length, 0, 'Finished login must clear the obsolete consent code');
});

test('login polling preserves failed key edits and clears only recovered refresh errors', async t => {
  const f = fixture(); f.login.attempt = {};
  const save = f.ctx.get('credentials').set;
  f.ctx.get('credentials').set = async () => { throw Error('Key save failed'); };
  let definition, Component, props, poll, offline = false, hold = false, release;
  runInNewContext(readFileSync(new URL('../plugins/providers/desktop-client.mjs', import.meta.url), 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } },
    setInterval: callback => { poll = callback; return 1; }, clearInterval() {},
  });
  definition.factory(() => React).apply({ slots: { inject: (_name, fn) => fn(), register: (spec, component) => { Component = component; props = spec.inject(); } },
    connection: { rpc: { call: async (_path, _method, payload) => {
      if (offline && payload.action === 'status') throw Error('Account connection interrupted');
      if (hold && payload.action === 'status') { hold = false; await new Promise(resolve => { release = resolve; }); }
      return { ok: true, value: await providerAccountRequest(f.ctx, payload) };
    } } },
  });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const key = () => renderer.root.findByProps({ 'aria-label': 'OpenRouter API key' });
  const errors = () => renderer.root.findAllByProps({ role: 'alert' }).map(node => node.children.join(''));
  const saveKey = async () => { await act(async () => { await renderer.root.findAllByType('button').find(node => node.children.includes('Save OpenRouter key')).props.onClick(); }); };
  await act(async () => key().props.onChange({ target: { value: 'synthetic-key' } }));
  await saveKey(); assert.deepEqual(errors(), ['Key save failed']);
  await act(async () => poll()); assert.deepEqual(errors(), ['Key save failed']);
  offline = true; await act(async () => poll());
  assert.deepEqual(errors(), ['Key save failed', 'Unable to refresh accounts: Account connection interrupted']);
  offline = false; await act(async () => poll());
  assert.deepEqual(errors(), ['Key save failed']); assert.equal(key().props.value, 'synthetic-key');
  f.ctx.get('credentials').set = save; await saveKey();
  assert.deepEqual(errors(), []); assert.equal(key().props.value, ''); assert.equal(f.keys.get('OPENROUTER_API_KEY'), 'synthetic-key');
  hold = true; await act(async () => poll());
  assert(renderer.root.findAllByType('fieldset').every(node => !node.props.disabled), 'Login polling must not disable editing');
  await act(async () => key().props.onChange({ target: { value: 'edited-during-polling' } }));
  let submitted;
  await act(async () => { submitted = renderer.root.findAllByType('button').find(node => node.children.includes('Save OpenRouter key')).props.onClick(); });
  assert.equal(f.keys.get('OPENROUTER_API_KEY'), 'synthetic-key', 'Saving waits for the background status request');
  release(); await act(async () => submitted);
  assert.equal(f.keys.get('OPENROUTER_API_KEY'), 'edited-during-polling');
  assert.equal(key().props.value, '');
});
