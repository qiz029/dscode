import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { desktopMetricsRequest } from '../plugins/session-metrics/desktop-host.mjs';
import { appendMetric } from '../plugins/session-metrics/store.mjs';
import { setMetricSource } from '../plugins/session-metrics/view.mjs';

test('Desktop usage projects only selected DSCODE metadata and retains partial costs and bounded turn history', t => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-metrics-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const events = Array.from({ length: 60 }, (_, index) => [
    { type: 'turn/start', time: index * 10 + 10, data: { turn: index + 1 } },
    { type: 'turn/end', time: index * 10 + 15, data: { turn: index + 1 } },
  ]).flat();
  events.push({ type: 'user/message', time: 700, data: { content: [{ text: 'PRIVATE_PROMPT' }] } });
  const dispose = setMetricSource(() => ({ events, used: 250, capacity: 1000, currentTps: 12, requestActive: true })); t.after(dispose);
  appendMetric(home, 'selected', { kind: 'start', id: 'known', time: 11, provider: 'fixture', model: 'fixture', purpose: 'agent' });
  appendMetric(home, 'selected', { kind: 'end', id: 'known', time: 11, cost: 0.25, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30 } });
  appendMetric(home, 'selected', { kind: 'end', id: 'unknown', time: 800, cost: null });
  appendMetric(home, 'foreign', { kind: 'end', id: 'other', time: 11, cost: 900 });
  const agent = { id: 'selected', ctx: {}, options: { provider: 'fixture', model: 'chosen' }, session: { requestHeader: () => undefined } };
  let preset = 'dscode'; const ctx = { agents: { get: id => id === agent.id ? agent : undefined }, agentPresets: { composedPreset: () => preset } };
  const status = desktopMetricsRequest(ctx, { action: 'status', sessionId: agent.id });
  assert.equal(status.cost, 0.25); assert.equal(status.partial, true); assert.equal(status.unattributedPartial, true);
  assert.equal(status.contextPercent, 25); assert.equal(status.cachePercent, 75); assert.equal(status.currentTps, 12);
  assert.equal(status.turns.length, 50); assert.equal(status.totalTurns, 60); assert.equal(status.turns[0].turn, 60);
  assert(!JSON.stringify(status).includes('PRIVATE_PROMPT')); assert(!status.turns.some(turn => turn.cost === 900));
  assert.throws(() => desktopMetricsRequest(ctx, { action: 'status', sessionId: 'foreign' }), /open DSCODE/);
  preset = 'standard'; assert.throws(() => desktopMetricsRequest(ctx, { action: 'status', sessionId: agent.id }), /open DSCODE/);
});

test('Desktop usage clears stale data on refresh errors and discards hidden/session state', async t => {
  let definition, Component, inject, refresh, reject = false, calls = 0;
  runInNewContext(readFileSync(new URL('../plugins/session-metrics/desktop-client.mjs', import.meta.url), 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } }, setInterval: fn => { refresh = fn; return 1; }, clearInterval() {},
  });
  const status = { provider: 'fixture', model: 'fixture', cost: 0, partial: true, calls: 1, pending: 0, contextPercent: null, cachePercent: null,
    currentTps: null, averageTps: null, requestActive: false, balance: null, subscription: null, budget: null, turns: [], totalTurns: 0, unattributed: 0, unattributedPartial: true };
  definition.factory(() => React).apply({ effect: fn => fn(), sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_name, fn) => fn(), register: (spec, component) => { inject = spec.inject; Component = component; return () => {}; } },
    connection: { rpc: { call: async () => { calls++; if (reject) throw Error('Session closed'); return { ok: true, value: status }; } } },
  });
  let renderer; const props = { ...inject('one'), useTabInfo: () => ({ tab: { visible: true } }) };
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  assert(JSON.stringify(renderer.toJSON()).includes('Unknown')); assert(!JSON.stringify(renderer.toJSON()).includes('$0.0000'));
  reject = true; await act(async () => refresh()); assert.equal(renderer.root.findAllByType('dl').length, 0);
  assert(JSON.stringify(renderer.toJSON()).includes('Session closed'));
  await act(async () => renderer.update(React.createElement(Component, { ...props, useTabInfo: () => ({ tab: { visible: false } }) })));
  assert.equal(renderer.toJSON(), null); reject = false;
  await act(async () => renderer.update(React.createElement(Component, { ...inject('two'), useTabInfo: props.useTabInfo })));
  assert.equal(calls, 3); assert(!JSON.stringify(renderer.toJSON()).includes('Session closed'));
});
