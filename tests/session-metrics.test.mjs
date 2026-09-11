import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateCost } from '../plugins/session-metrics/pricing.mjs';
import { summarize, formatFooter } from '../plugins/session-metrics/view.mjs';
import { apply } from '../plugins/session-metrics/index.mjs';
import { readMetrics } from '../plugins/session-metrics/store.mjs';
const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 };
test('official prices use UTC weekday windows and announced Pro migration', () => {
  const price = (model, time) => estimateCost('deepseek-official', model, usage, Date.parse(time));
  assert.equal(price('deepseek-flash', '2026-09-11T00:00Z'), 0.753);
  assert.equal(price('deepseek-flash', '2026-09-11T01:00Z'), 1.506);
  assert.equal(price('deepseek-flash', '2026-09-12T01:00Z'), 0.753);
  assert.equal(price('deepseek-v4-pro', '2026-09-14T03:59Z'), 5.324);
  assert.equal(price('deepseek-v4-pro', '2026-09-14T04:00Z'), 0.753);
  assert.equal(price('unknown', '2026-09-11T01:00Z'), null);
  assert.equal(price('deepseek-flash', '2026-09-10T01:00Z'), null);
  assert.equal(estimateCost('proxy', 'deepseek-flash', usage, Date.now()), null);
});
test('session totals weight input tokens, retain unknowns and survive replay', () => {
  const rows = [
    { kind: 'start', id: 'a', time: 10 },
    { kind: 'end', id: 'a', cost: 0.001, usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 10 } },
    { kind: 'end', id: 'b', cost: 0.002, usage: { inputTokens: 9000, cacheReadTokens: 0, outputTokens: 20 } },
  ];
  const summary = summarize(rows);
  assert.equal(summary.cost, 0.003);
  assert.equal(summary.cache, 9);
  assert.deepEqual(summarize(JSON.parse(JSON.stringify(rows))), summary);
  assert.equal(summarize([...rows, { kind: 'start', id: 'pending', time: 20 }]).cache, 9);
  assert(summarize([...rows, { kind: 'end', id: 'failed', cost: null }]).unknown);
  assert.equal(summarize([...rows, { kind: 'end', id: 'failed', cost: null }]).cache, null);
  for (const columns of [20, 32, 48, 80, 120]) assert(formatFooter(summary, 43.2, columns).length <= columns);
  assert.match(formatFooter(summary, 43.2), /ctx 43%.*session ~\$0.0030.*cache 9.0%/);
});
test('collector includes child costs in parent, emits one final usage and records aborted unknowns', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-metrics-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  let wrapper;
  const parent = { session: { header: {} } };
  const child = { session: { header: { origin: 'subagent', parentSession: 'parent' } } };
  apply({ effect() {}, logger: { warn() {} }, on: (_name, fn) => { wrapper = fn; }, agents: { get: id => id === 'child' ? child : parent } });
  try {
    const options = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'child' };
    for await (const _ of wrapper(options, async function* () { yield { type: 'usage', usage: { ...usage, inputTokens: 1 } }; yield { type: 'usage', usage }; })) {}
    for (const id of ['child', 'parent']) {
      const data = readMetrics(home, id);
      assert.equal(data.rows.length, 2);
      assert.equal(summarize(data.rows).calls, 1);
      assert.equal(summarize(data.rows).cache, 50);
    }
    await assert.rejects(async () => { for await (const _ of wrapper({ ...options, sessionId: 'parent' }, async function* () { throw new Error('aborted'); })) {} }, /aborted/);
    assert(summarize(readMetrics(home, 'parent').rows).unknown);
  } finally { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; rmSync(home, { recursive: true, force: true }); }
});
