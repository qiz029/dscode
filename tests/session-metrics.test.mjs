import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateCost } from '../plugins/session-metrics/pricing.mjs';
import { summarize, formatFooter, footerFor, displayWidth } from '../plugins/session-metrics/view.mjs';
import { apply } from '../plugins/session-metrics/index.mjs';
import { readMetrics } from '../plugins/session-metrics/store.mjs';
import { createWindowRate, estimatedDeltaTokens, sessionAverageTps } from '../plugins/session-metrics/rate.mjs';
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
  assert.match(formatFooter(summary, 43.2), /context: 43%.*\$0\.00 \/ \$(?:--|\d+\.\d{2}).*cache hit: 9\.0%/);
});
test('live TPS divides by the time the window actually spans, restarts after a pause, and calibrates to settled usage', () => {
  const session = {}, other = {};
  const rate = createWindowRate();
  assert.equal(rate.get(session, 10000), null);
  assert.equal(estimatedDeltaTokens({ type: 'usage', usage }), 0);
  assert.equal(estimatedDeltaTokens({ type: 'text-delta', text: '你好' }), 1.5);
  rate.add(session, { type: 'text-delta', text: 'a'.repeat(40) }, 10000);
  assert.equal(rate.get(session, 10000), 20, 'the first sample is rated over the half-second minimum span, not five seconds');
  rate.add(session, { type: 'reasoning-delta', text: 'b'.repeat(40) }, 11000);
  assert.equal(rate.get(session, 11000), 20, '20 tokens over one second');
  rate.add(session, { type: 'tool-call-delta', argumentsDelta: 'c'.repeat(20) }, 12000);
  assert.equal(rate.get(session, 12000), 12.5, '25 tokens over two seconds');
  assert.equal(rate.get(other, 12000), null);
  assert.ok(Math.abs(rate.get(session, 14500) - 25 / 4.5) < 1e-9, '25 tokens over the 4.5 seconds the window spans');
  assert.equal(rate.get(session, 16000), 1.25, 'samples older than five seconds fall out: 5 tokens over four seconds');
  assert.equal(rate.get(session, 19000), 0, 'silence decays to zero');
  rate.calibrate(session, 25);
  assert.equal(rate.get(session, 19000), 0, 'a settled count equal to the estimate leaves the factor at one');
  // A tool call pauses output; the next chunk rates only its own burst, not the silence.
  rate.add(session, { type: 'text-delta', text: 'd'.repeat(80) }, 30000);
  assert.equal(rate.get(session, 30500), 40, '20 tokens over the half-second minimum span after a gap');
  rate.add(session, { type: 'text-delta', text: 'e'.repeat(80) }, 31000);
  assert.equal(rate.get(session, 31000), 40, '40 tokens over one second');
  // Settled usage says the byte estimate undercounted by half: later readings scale up.
  rate.calibrate(session, 80);
  assert.equal(rate.get(session, 31000), 60, 'the factor moves halfway toward the measured ratio');
  rate.calibrate(session, 0); rate.calibrate(session, NaN);
  assert.equal(rate.get(session, 31000), 60, 'zero or missing usage never changes the factor');
  rate.add(session, { type: 'text-delta', text: 'f'.repeat(4000) }, 31500);
  rate.calibrate(session, 10);
  assert(rate.get(session, 31500) > 0, 'ratios are clamped so one odd response cannot zero the rate');
});
test('session average is output tokens over summed LLM call time, excluding tool waits and idle', () => {
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 2000, data: { turn: 1, step: 1, usage: { outputTokens: 20 } } },
    { type: 'tool/call', time: 2000, data: { turn: 1 } },
    { type: 'tool/result', time: 8000, data: { turn: 1 } },
    { type: 'step/start', time: 8000, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', time: 10000, data: { turn: 1, step: 2, usage: { outputTokens: 40 } } },
    { type: 'turn/end', time: 10000, data: { turn: 1 } },
    { type: 'turn/start', time: 100000, data: { turn: 2 } },
    { type: 'step/start', time: 100000, data: { turn: 2, step: 1 } },
  ];
  assert.equal(sessionAverageTps(events.slice(0, 3)), 10, '20 tokens over a two-second call');
  assert.equal(sessionAverageTps(events), 15, '60 tokens over four seconds of calls; the six-second tool wait and the idle gap do not count');
  assert.equal(sessionAverageTps(events.slice(0, 2)), null, 'no settled call yet');
  assert.equal(sessionAverageTps([...events, { type: 'assistant/message', time: 102000, data: { turn: 2, step: 1 } }]), null, 'a message without usage makes the average unknown');
  assert.equal(sessionAverageTps([...events, { type: 'assistant/message', time: 102000, data: { turn: 9, step: 9, usage: { outputTokens: 5 } } }]), null, 'a message without its step start makes the average unknown');
});
test('footer protects the money and the context, dropping the rates first', () => {
  const metrics = { cost: 0.003, unknown: false, pending: 0, cache: 90 };
  const rates = { current: 12.3, average: 2.4 };
  const money = "\\$0\\.00 \\/ \\$-- ";
  for (const columns of [24, 28, 36, 40, 44, 56, 80, 100]) assert(formatFooter(metrics, 43, columns, rates).length <= columns);
  assert.match(formatFooter(metrics, 43, 24, rates), /^\$0\.00 \/ \$-- /, 'a very narrow footer keeps the money alone');
  assert.match(formatFooter(metrics, 43, 36, rates), new RegExp('^context: 43% \\| ' + money), 'context and money outrank the rates');
  assert.match(formatFooter(metrics, 43, 56, rates), new RegExp('^current: ~12\\.3 tps \\| context: 43% \\| ' + money), 'the current rate returns before the average');
  assert.match(formatFooter(metrics, 43, 80, rates), new RegExp('^current: ~12\\.3 tps \\| context: 43% \\| ' + money + '.*\\| cache hit: 90\\.0%$'), 'the cache rate returns last');
  assert.match(formatFooter(metrics, 43, 100, rates), /^current: ~12\.3 tps \| average: 2\.4 tps \| context: 43% \| \$0\.00 \/ \$-- .* \| cache hit: 90\.0%$/, 'both rates fit on a wide terminal');
});
test('the model header leads the footer and sheds the provider before the money', () => {
  const metrics = { cost: 0.003, unknown: false, pending: 0, cache: 90 };
  const rates = { current: 12.3, average: 2.4 };
  const long = 'deepseek-official: deepseek-flash @ ultra';
  const line = columns => formatFooter(metrics, 43, columns, rates, 'en', long);
  assert(line(140).startsWith(long + ' | current: ~12.3 tps | average: 2.4 tps'), 'the full header leads a wide footer');
  assert.match(line(92), /^deepseek-flash @ ultra \| current: ~12\.3 tps \| context: 43% \| \$0\.00/, 'the bare model keeps a rate the provider form cannot afford');
  assert.match(line(74), new RegExp('^' + long.replace(/[.:]/g, '\\$&') + ' \\| context: 43% \\| \\$0\\.00'), 'the provider form returns as soon as it fits again');
  assert.match(line(60), /^deepseek-flash @ ultra \| context: 43% \| \$0\.00/, 'the bare model and the context still fit at 60 columns');
  assert.match(line(40), /^deepseek-flash @ ultra \| \$0\.00 \/ \$--/, 'a narrow footer keeps the model and the money');
  assert.match(line(20), /^\$0\.00 \/ \$--/, 'the money is the last thing standing');
});
test('collector streaming deltas reach the live footer', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-live-rate-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const start = Date.now() - 10000;
  const session = { seq: 1, header: {}, snapshotEvents: () => [
    { type: 'turn/start', time: start, data: { turn: 1 } },
    { type: 'step/start', time: start, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: start + 5000, data: { turn: 1, step: 1, usage: { outputTokens: 20 } } },
    { type: 'turn/end', time: start + 10000, data: { turn: 1 } },
  ] };
  let wrapper, dispose;
  apply({
    effect: fn => { dispose = fn(); }, logger: { warn() {} },
    on: (_name, fn) => { wrapper = fn; },
    agents: { get: id => id === 'root' ? { session } : undefined },
    sessionProjections: { stateOf: () => ({ contextWindow: 100 }) },
    tokenMeter: { measure: () => ({ totalTokens: 43 }) },
  });
  try {
    for await (const _ of wrapper({ provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'root' }, async function* () {
      yield { type: 'text-delta', text: 'a'.repeat(40) };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 } };
    })) {}
    const line = footerFor('root', { contextWindow: 100 }, 100);
    assert.match(line, /current: ~20\.0 tps \| average: 4\.0 tps/, 'ten estimated tokens over the half-second minimum span; 20 settled tokens over a five-second call');
    assert.match(line, /context: 43%/);
  } finally {
    dispose?.();
    if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old;
    rmSync(home, { recursive: true, force: true });
  }
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

test('footer labels follow the interface language and wide characters count as two columns', () => {
  const metrics = { cost: 0.003, unknown: false, pending: 0, cache: 90 };
  const rates = { current: 12.3, average: 2.4 };
  assert.equal(displayWidth('context: 43%'), 12);
  assert.equal(displayWidth('上下文: 43%'), 11);
  assert.equal(displayWidth(' | '), 3);
  const zh = formatFooter(metrics, 43, 240, rates, 'zh-CN');
  assert.match(zh, /^当前: ~12\.3 tps | 平均: 2\.4 tps | 上下文: 43% | \$0\.00 \/ \$(?:--|\d+\.\d{2}).*缓存命中: 90\.0%$/);
  assert.match(formatFooter(metrics, 43, 80, rates, 'ja'), /^現在: ~12\.3 tps | 平均: 2\.4 tps | コンテキスト: 43%/);
  for (const columns of [20, 24, 30, 40, 60]) assert(displayWidth(formatFooter(metrics, 43, columns, rates, 'ko')) <= columns, `fits ${columns}`);
  assert.equal(formatFooter(metrics, 43, 80, rates, 'xx'), formatFooter(metrics, 43, 80, rates), 'unknown locale falls back to English');
});
