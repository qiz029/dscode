import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateCost, priceVersionFor } from '../plugins/session-metrics/pricing.mjs';
import { RETRY_MS, openRouterRates, parseOpenRouterModels, refreshOpenRouterModels, setOpenRouterModels } from '../plugins/openrouter/models.mjs';
import { summarize, formatFooter, footerFor, displayWidth, setMetricSource } from '../plugins/session-metrics/view.mjs';
import { apply } from '../plugins/session-metrics/index.mjs';
import { appendMetric, ledgerPath, readMetrics } from '../plugins/session-metrics/store.mjs';
import { chargeTo } from '../plugins/session-metrics/attribution.mjs';
import { createSmoothedRate, sessionAverageTps } from '../plugins/session-metrics/rate.mjs';
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
test('OpenRouter prices the declared DeepSeek models at list price with no peak window', () => {
  const peak = Date.parse('2026-09-14T02:00Z'), quiet = Date.parse('2026-09-14T12:00Z');
  assert.equal(estimateCost('openrouter', 'deepseek/deepseek-v4-flash', usage, peak), estimateCost('openrouter', 'deepseek/deepseek-v4-flash', usage, quiet));
  assert.equal(Math.round(estimateCost('openrouter', 'deepseek/deepseek-v4-flash', usage, peak) * 1e6), 272832);
  assert.equal(Math.round(estimateCost('openrouter', 'deepseek/deepseek-v4-pro', usage, peak) * 1e6), 2745270);
  assert.equal(estimateCost('openrouter', 'deepseek/deepseek-v4-flash', { ...usage, cacheWriteTokens: 1 }, peak), null);
  assert.equal(estimateCost('openrouter', 'anthropic/claude-sonnet-4.5', usage, peak), null);
  assert.equal(priceVersionFor('openrouter'), 'openrouter-pi-ai-0.85.1');
  assert.equal(priceVersionFor('deepseek-official'), 'deepseek-2026-09-11');
});
test('OpenRouter calls are priced from its live listing, with long-prompt tiers and cache writes, cached for a day', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-openrouter-prices-'));
  t.after(() => { setOpenRouterModels({}, 0); rmSync(home, { recursive: true, force: true }); });
  const body = { data: [
    { id: 'anthropic/claude-sonnet-4.5', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375',
      overrides: [{ min_prompt_tokens: 200000, prompt: '0.000006', completion: '0.0000225', input_cache_read: '0.0000006', input_cache_write: '0.0000075' }] } },
    { id: 'deepseek/deepseek-v4-flash', pricing: { prompt: '0.00000008', completion: '0.00000016' } },
    { id: 'broken/model', pricing: { prompt: 'n/a', completion: '0' } },
  ] };
  assert.deepEqual(Object.keys(parseOpenRouterModels(body)), ['anthropic/claude-sonnet-4.5', 'deepseek/deepseek-v4-flash']);
  let calls = 0;
  const fetch = async url => { calls++; assert.equal(url, 'https://openrouter.ai/api/v1/models'); return { ok: true, json: async () => body }; };
  const now = Date.now(), time = Date.parse('2026-09-14T02:00Z');
  await refreshOpenRouterModels({ home, fetch, now });
  assert.equal(calls, 1);
  const micro = value => Math.round(value * 1e6);
  assert.equal(micro(estimateCost('openrouter', 'anthropic/claude-sonnet-4.5', { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 1000 }, time)), 22050, 'cache writes are priced');
  assert.equal(micro(estimateCost('openrouter', 'anthropic/claude-sonnet-4.5', { inputTokens: 250000, outputTokens: 1000 }, time)), 1522500, 'a long prompt bills the higher tier');
  assert.equal(micro(estimateCost('openrouter', 'deepseek/deepseek-v4-flash', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6 }, time)), 320000, 'no listed cache-read price bills cached input at the input rate');
  assert.equal(micro(estimateCost('openrouter', 'deepseek/deepseek-v4-flash', { inputTokens: 1e6, outputTokens: 0, cacheWriteTokens: 1e6 }, time)), 160000, 'no listed cache-write price bills written input at the input rate');
  assert.equal(estimateCost('openrouter', 'broken/model', usage, time), null);
  assert.match(priceVersionFor('openrouter', 'anthropic/claude-sonnet-4.5'), /^openrouter-models-\d{4}-\d{2}-\d{2}$/);
  assert.equal(priceVersionFor('openrouter', 'unlisted/model'), 'openrouter-pi-ai-0.85.1');
  await refreshOpenRouterModels({ home, fetch, now: now + 60_000 });
  assert.equal(calls, 1, 'the table is not refetched within a day');
  setOpenRouterModels({}, 0);
  await refreshOpenRouterModels({ home, fetch: async () => { throw new Error('offline'); }, now });
  assert.notEqual(openRouterRates('anthropic/claude-sonnet-4.5'), undefined, 'a restart reads the cached table without the network');
  setOpenRouterModels({}, 0);
  rmSync(join(home, 'openrouter-models.json'));
  await refreshOpenRouterModels({ home, fetch: async () => ({ ok: false, json: async () => ({}) }), now });
  assert.equal(openRouterRates('anthropic/claude-sonnet-4.5'), undefined, 'a failed listing leaves the pinned fallback in charge');
  assert.equal(Math.round(estimateCost('openrouter', 'deepseek/deepseek-v4-flash', usage, time) * 1e6), 272832);
});
test('an unusable model cache is throttled, then re-read for the next window', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-openrouter-cache-'));
  const path = join(home, 'openrouter-models.json');
  t.after(() => { setOpenRouterModels({}, 0); rmSync(home, { recursive: true, force: true }); });
  setOpenRouterModels({}, 0);
  const now = Date.parse('2026-03-01T02:00Z');
  const offline = async () => { throw new Error('offline'); };
  writeFileSync(path, '{ not json');
  await refreshOpenRouterModels({ home, fetch: offline, now });
  assert.equal(openRouterRates('cached/model'), undefined);
  writeFileSync(path, JSON.stringify({ version: 2, fetchedAt: Date.parse('2026-02-28T00:00Z'), models: { 'cached/model': { id: 'cached/model' } } }));
  await refreshOpenRouterModels({ home, fetch: offline, now: now + RETRY_MS - 1 });
  assert.equal(openRouterRates('cached/model'), undefined, 'inside the window the file is not read again');
  await refreshOpenRouterModels({ home, fetch: offline, now: now + RETRY_MS + 1 });
  assert.notEqual(openRouterRates('cached/model'), undefined, 'after the window a usable cache is picked up');
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
  assert.equal(summarize([...rows, { kind: 'end', id: 'failed', cost: null }]).cache, 9, 'a call that ends without usage is unaccounted, not a cache miss');
  assert.equal(summarize([...rows, { kind: 'end', id: 'broken', cost: 0, usage: { inputTokens: 'x', outputTokens: 1 } }]).cache, null, 'a malformed usage still makes the ratio unknowable');
  assert.equal(summarize([...rows, { kind: 'end', id: 'openrouter', cost: 0, usage: { inputTokens: 9000, outputTokens: 5 } }]).cache, 900 / 19000 * 100, 'a call reporting no cache reads counts as zero, not unknown');
  for (const columns of [20, 32, 48, 80, 120]) assert(formatFooter(summary, 43.2, columns).length <= columns);
  assert.match(formatFooter(summary, 43.2), /43% ctx · \$0\.00.*9\.0% cache$/);
});
test('smoothed TPS gives newer API-derived request rates more weight without an idle expiry', () => {
  const session = {}, other = {};
  const rate = createSmoothedRate();
  const record = sample => rate.begin(session, 'deepseek/high')(sample);
  const decay = 0.5;
  assert.equal(rate.get(session), null);
  record({ start: 1000, end: 3000, outputTokens: 100 });
  assert.equal(rate.get(session), 50, 'the first request supplies the initial rate');
  record({ start: 4000, end: 7000, outputTokens: 300 });
  const expected = (50 * decay + 100) / (decay + 1);
  assert.equal(rate.get(session), expected);
  assert.ok(expected > 75 && expected < 100, 'the newer 100 TPS sample outweighs the older 50 TPS sample');
  assert.equal(rate.get(other), null, 'sessions stay separate');
  rate.begin(session, 'deepseek/high');
  assert.equal(rate.get(session), expected, 'starting a request on the same route keeps the display');
  record({ start: 1000000, end: 1030000, outputTokens: 600 });
  assert.equal(rate.get(session), ((50 * decay + 100) * decay + 20) / ((decay + 1) * decay + 1),
    'a long idle gap does not expire history; a long request uses its full duration');
});
test('each newer valid request halves old weight, and invalid samples do not age it', () => {
  const session = {};
  const rate = createSmoothedRate();
  const record = sample => rate.begin(session, 'same-route')(sample);
  for (const outputTokens of [undefined, NaN, Infinity, -1]) {
    record({ start: 1000, end: 2000, outputTokens });
    assert.equal(rate.get(session), null);
  }
  for (const start of [2000, 3000, NaN, Infinity]) {
    record({ start, end: 2000, outputTokens: 10 });
    assert.equal(rate.get(session), null);
  }
  record({ start: 1000, end: 2000, outputTokens: 100 });
  record({ start: 2000, end: 3000 });
  assert.equal(rate.get(session), 100, 'missing usage does not decay previous samples');
  for (let index = 0; index < 3; index++) {
    record({ start: 2000 + index * 1000, end: 3000 + index * 1000, outputTokens: 0 });
    assert.ok(Math.abs(rate.get(session) - [100 / 3, 100 / 7, 100 / 15][index]) < 1e-12,
      'each reported zero halves all older weights before normalization');
  }
});
test('changing the model starts fresh and ignores late usage from a previous route', () => {
  const session = {};
  const rate = createSmoothedRate();
  const old = rate.begin(session, 'model-a');
  old({ start: 1000, end: 2000, outputTokens: 100 });
  const next = rate.begin(session, 'model-b');
  assert.equal(rate.get(session), null);
  old({ start: 1000, end: 3000, outputTokens: 1000 });
  assert.equal(rate.get(session), null, 'an old stream cannot restore the old model rate');
  next({ start: 3000, end: 4000, outputTokens: 20 });
  assert.equal(rate.get(session), 20);
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
  for (const columns of [20, 24, 28, 36, 40, 46, 56, 80, 100]) {
    for (const active of [false, true]) assert(formatFooter(metrics, 43, columns, { ...rates, active }).length <= columns);
  }
  assert.match(formatFooter(metrics, 43, 20, rates), /^\$0\.00/, 'a very narrow footer keeps the money alone');
  assert.match(formatFooter(metrics, 43, 24, rates), /^\$0\.00.*90\.0% cache$/, 'the cache rate survives next to the money');
  assert.match(formatFooter(metrics, 43, 34, rates), /^ 43% ctx · \$0\.00.*90\.0% cache$/, 'context returns before the rates');
  assert.match(formatFooter(metrics, 43, 50, rates), /^ {4}12\.3 tps · {2}43% ctx · \$0\.00.*90\.0% cache$/, 'the live rate returns before the average');
  assert.match(formatFooter(metrics, 43, 100, rates), /^ {4}12\.3 tps · {4}2\.4 tps avg · {2}43% ctx · \$0\.00.*90\.0% cache$/, 'both rates fit on a wide terminal');
});
test('a growing live figure never moves the segment after it', () => {
  const columns = 140;
  const at = (rates, context, cache) => formatFooter({ cost: 0.01, unknown: false, pending: 0, cache }, context, columns, rates);
  const small = at({ current: 9.9, average: 2.4 }, 1, 9);
  const active = at({ current: 9.9, average: 2.4, active: true }, 1, 9);
  const grown = at({ current: 124.5, average: 99.9 }, 100, 100);
  assert.match(small, /^ {5}9\.9 tps · {4}2\.4 tps avg · {3}1% ctx · \$0\.01/);
  assert.match(grown, /^ {3}124\.5 tps · {3}99\.9 tps avg · 100% ctx · \$0\.01/);
  // Reserved columns are what keeps these two readings aligned: the separators and
  // the segments after them sit at the same column whatever the figures say.
  for (const segment of ['avg', 'ctx', '$0.01', 'cache']) {
    assert.equal(small.indexOf(segment), grown.indexOf(segment), `${segment} keeps its column`);
    assert.equal(small.indexOf(segment), active.indexOf(segment), `${segment} stays aligned when request activity changes`);
  }
  assert.equal(small.indexOf('9.9 tps'), active.indexOf('9.9 tps'));
});

test('the budget slot rides the money figure and only appears when a limit is set', () => {
  const base = { cost: 0.42, unknown: false, pending: 0, cache: 90 };
  const at = (metrics, columns = 120) => formatFooter(metrics, 43, columns, { current: 24.6, average: 18.2 });
  assert.doesNotMatch(at(base), /\//, 'no limit means no budget slot at all');
  // The peak mark follows the real billing window, so this assertion accepts
  // either; `peakEmoji` itself is pinned by a fixed-time test below.
  assert.match(at({ ...base, budget: { state: 'ok', limit: 5 } }), /\$0\.42 (?:🔥|❄️)\/5\.00 /, 'a healthy budget reads beside the spend');
  assert.match(at({ ...base, budget: { state: 'warn', limit: 0.5 } }), /\$0\.42 (?:🔥|❄️)\/0\.50⚠/, 'the warn share is marked');
  assert.match(at({ ...base, budget: { state: 'over', limit: 0.4 } }), /\$0\.42 (?:🔥|❄️)\/0\.40⚠!/, 'over the limit is marked harder');
  // The slot never pushes the line past its columns; it is dropped with the other figures.
  for (const columns of [20, 24, 30, 40, 50, 60, 80, 120]) {
    const line = at({ ...base, budget: { state: 'warn', limit: 1 } }, columns);
    assert.ok(displayWidth(line) <= columns, `${columns} columns hold ${JSON.stringify(line)}`);
  }
});

test('the session budget reads one process-scoped limit and the footer follows it', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-budget-'));
  const oldHome = process.env.DSH_HOME, oldBudget = process.env.DSCODE_SESSION_BUDGET_USD;
  process.env.DSH_HOME = home;
  t.after(() => {
    setMetricSource(undefined);
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldBudget === undefined) delete process.env.DSCODE_SESSION_BUDGET_USD; else process.env.DSCODE_SESSION_BUDGET_USD = oldBudget;
    rmSync(home, { recursive: true, force: true });
  });
  // One settled main call costing a dollar at the official flash rate, priced by this collector.
  const start = Date.now() - 1000;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  appendMetric(home, 'root', { kind: 'start', id: 'one', time: start, provider: 'deepseek-official', model: 'deepseek-flash', purpose: 'agent' });
  appendMetric(home, 'root', { kind: 'end', id: 'one', time: start, endTime: start + 10, usage, cost: 0.62, priceVersion: 'deepseek-2026-09-11' });
  const stats = { contextWindow: 1000 };
  delete process.env.DSCODE_SESSION_BUDGET_USD;
  const unbudgeted = footerFor('root', stats, 120);
  assert.doesNotMatch(unbudgeted, /0\.62\//, 'an unset limit adds nothing');
  process.env.DSCODE_SESSION_BUDGET_USD = '1';
  const ok = footerFor('root', stats, 120);
  assert.match(ok, /\$0\.62 .*\/1\.00(?!\u26a0)/, 'under the warn share the slot is plain');
  process.env.DSCODE_SESSION_BUDGET_USD = '0.7';
  const warn = footerFor('root', stats, 120);
  assert.match(warn, /\/0\.70⚠/, 'past 80% the slot warns');
  process.env.DSCODE_SESSION_BUDGET_USD = '0.5';
  const over = footerFor('root', stats, 120);
  assert.match(over, /\/0\.50⚠!/, 'past the limit it marks over');
  // An unparseable limit is no limit, not a zero-dollar gate that blocks every prompt.
  process.env.DSCODE_SESSION_BUDGET_USD = 'oops';
  assert.doesNotMatch(footerFor('root', stats, 120), /⚠|\/\d/, 'a bad value never gates');
});

test('the provider decides the money slot and the peak marker', () => {
  const metrics = { cost: 0.003, unknown: false, pending: 0, cache: 90 };
  const line = (columns, provider) => formatFooter(metrics, 43, columns, undefined, 'en', provider);
  // The marker follows the billing window, so either emblem is valid here.
  assert.match(line(80, 'deepseek-official'), /\$0\.00 (?:🔥|❄️)/, 'the official route marks the billing window');
  assert.match(line(80, 'openrouter'), /^ 43% ctx · \$0\.00 · {2}90\.0% cache$/, 'another route keeps the plain spend');
  assert.doesNotMatch(line(80, 'openrouter'), /🔥|❄️/);
});
test('collector smooths completed API usage without estimating streams or counting aborted calls', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-live-rate-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  const start = Date.now() - 10000;
  const session = { seq: 1, header: {}, snapshotEvents: () => [
    { type: 'turn/start', time: start, data: { turn: 1 } },
    { type: 'step/start', time: start, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: start + 5000, data: { turn: 1, step: 1, usage: { outputTokens: 20 } } },
    { type: 'turn/end', time: start + 10000, data: { turn: 1 } },
  ] };
  let now = start + 20000;
  t.mock.method(Date, 'now', () => now);
  let wrapper;
  const disposers = [];
  apply({
    effect: fn => { disposers.push(fn()); }, logger: { warn() {} },
    on: (_name, fn) => { wrapper = fn; },
    agents: { get: id => id === 'root' ? { session } : undefined },
    sessionProjections: { stateOf: () => ({ contextWindow: 100 }) },
    tokenMeter: { measure: () => ({ totalTokens: 43 }) },
  });
  try {
    const options = { provider: 'deepseek-official', model: 'deepseek-flash', sessionId: 'root' };
    const footer = () => footerFor('root', { contextWindow: 100 }, 100);
    for await (const _ of wrapper(options, async function* () {
      assert.match(footer(), /^◌ /, 'the indicator is active before the first output or usage');
      yield { type: 'text-delta', text: '你好'.repeat(4000) };
      yield { type: 'reasoning-delta', text: 'reasoning'.repeat(1000) };
      yield { type: 'tool-call-delta', argumentsDelta: '{"hello":"world"}' };
      assert.match(footer(), /-- tps/, 'text, reasoning and tool bytes produce no rate');
      now += 2000;
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 } };
      assert.match(footer(), /-- tps/, 'intermediate cumulative usage is not counted as a completed request');
      now += 3000;
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 40, cacheReadTokens: 0 } };
    })) {}
    now += 1000;
    assert.match(footer(), /8\.0 tps · {4}4\.0 tps avg/, '40 reported tokens / 5 seconds, unchanged by idle time');
    assert.doesNotMatch(footer(), /[~◌]/, 'completion stops activity without altering the measured rate');
    assert.match(footer(), / 43% ctx/);
    for await (const _ of wrapper({ ...options, purpose: 'title' }, async function* () {
      now += 1000;
      assert.doesNotMatch(footer(), /◌/, 'auxiliary requests do not animate the main request indicator');
      yield { type: 'usage', usage: { outputTokens: 500 } };
    })) {}
    assert.match(footer(), /8\.0 tps/, 'auxiliary usage does not replace the main request rate');
    for await (const _ of wrapper(options, async function* () {
      assert.match(footer(), /8\.0 tps/, 'a new request retains the smoothed rate');
      now += 1000;
      yield { type: 'usage', usage: { outputTokens: 100 } };
    })) {}
    assert.match(footer(), /69\.3 tps/, 'the newer 100 TPS sample outweighs the older 8 TPS sample');
    for await (const _ of wrapper(options, async function* () {
      yield { type: 'text-delta', text: 'no usage' };
    })) {}
    assert.match(footer(), /69\.3 tps/, 'a response without usage adds no sample');
    await assert.rejects(async () => {
      for await (const _ of wrapper(options, async function* () {
        yield { type: 'text-delta', text: 'interrupted' };
        now += 1000;
        yield { type: 'usage', usage: { outputTokens: 9999 } };
        throw new Error('aborted fixture');
      })) {}
    }, /aborted fixture/);
    assert.match(footer(), /69\.3 tps/, 'an aborted call adds no sample even with partial usage');
    assert.doesNotMatch(footer(), /◌/, 'aborting also clears the activity indicator');
    now += 10000;
    assert.match(footer(), /69\.3 tps/, 'idle time does not expire the smoothed rate');
    for await (const _ of wrapper({ ...options, model: 'deepseek-v4-pro' }, async function* () {
      assert.match(footer(), /-- tps/, 'a different model clears the previous smoothed rate');
      now += 2000;
      yield { type: 'usage', usage: { outputTokens: 40 } };
    })) {}
    assert.match(footer(), /20\.0 tps/, 'the new model starts from its own usage');
    for await (const _ of wrapper({ ...options, model: 'deepseek-v4-pro', reasoningEffort: 'max' }, async function* () {
      assert.match(footer(), /-- tps/, 'a different effort also starts fresh');
      now += 1000;
      yield { type: 'usage', usage: { outputTokens: 30 } };
    })) {}
    assert.match(footer(), /30\.0 tps/);
  } finally {
    for (const dispose of disposers.reverse()) dispose?.();
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

test('a ledger is re-read incrementally, so appended rows appear without re-parsing history', t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-ledger-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = { kind: 'start', id: 'a', time: 1, model: '模型/flash' };
  appendMetric(home, 'ledger', first);
  assert.equal(readMetrics(home, 'ledger').rows.length, 1);
  appendMetric(home, 'ledger', { kind: 'end', id: 'a', time: 2, cost: 0.5, usage });
  const grown = readMetrics(home, 'ledger');
  assert.equal(grown.rows.length, 2);
  assert.deepEqual(grown.rows[0], first, 'the earlier row is kept, not re-parsed away');
  assert.equal(summarize(grown.rows).calls, 1);
  // A batch past one read: the incremental reader must not stop at a short read.
  const batch = 4000;
  appendFileSync(ledgerPath(home, 'ledger'), Array.from({ length: batch }, (_, index) => JSON.stringify({ kind: 'start', id: 'b' + index, time: index + 3, usage })).join('\n') + '\n');
  assert.equal(readMetrics(home, 'ledger').rows.length, 2 + batch);
  assert.equal(readMetrics(home, 'ledger').rows.at(-1).id, 'b' + (batch - 1));
  // A partially written trailing line is ignored until its newline arrives, then appears once.
  const path = ledgerPath(home, 'ledger');
  appendFileSync(path, '{"kind":"end"');
  assert.equal(readMetrics(home, 'ledger').rows.length, 2 + batch);
  writeFileSync(path, readFileSync(path, 'utf8') + '}\n');
  const completed = readMetrics(home, 'ledger');
  assert.equal(completed.rows.length, 3 + batch, 'the completed row appears exactly once');
  assert.equal(completed.rows.at(-1).kind, 'end');
});

test('footer labels follow the interface language and wide characters count as two columns', () => {
  const metrics = { cost: 0.003, unknown: false, pending: 0, cache: 90 };
  const rates = { current: 12.3, average: 2.4 };
  assert.equal(displayWidth('ctx 43%'), 7);
  assert.equal(displayWidth('90.0% 缓存'), 10);
  assert.equal(displayWidth(' · '), 3);
  const zh = formatFooter(metrics, 43, 240, rates, 'zh-CN');
  assert.match(zh, /^ {4}12\.3 tps · {4}2\.4 tps 平均 · {2}43% ctx · \$0\.00.*90\.0% 缓存$/);
  assert.match(formatFooter(metrics, 43, 104, rates, 'ja'), /^ {4}12\.3 tps · {4}2\.4 tps 平均 · {2}43% ctx/);
  for (const columns of [20, 24, 30, 40, 60]) assert(displayWidth(formatFooter(metrics, 43, columns, rates, 'ko')) <= columns, `fits ${columns}`);
  assert.equal(formatFooter(metrics, 43, 80, rates, 'xx'), formatFooter(metrics, 43, 80, rates), 'unknown locale falls back to English');
});

test('ledger rows time each call and charge plugin calls made for a session without a wire sessionId', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-metrics-timing-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  let wrapper;
  const root = { session: { header: {} } };
  apply({ effect() {}, logger: { warn() {} }, on: (_name, fn) => { wrapper = fn; }, agents: { get: id => id === 'root' ? root : undefined } });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const call = (options, delayMs = 0) => wrapper({ provider: 'deepseek-official', model: 'deepseek-flash', ...options }, async function* () {
    await sleep(delayMs); yield { type: 'block-start' }; yield { type: 'reasoning-delta', text: 'x' };
    await sleep(delayMs); yield { type: 'usage', usage };
  });
  try {
    for await (const _ of call({ sessionId: 'root' }, 25)) {}
    let rows = readMetrics(home, 'root').rows;
    const [start, end] = rows;
    assert.equal(start.purpose, 'agent');
    assert.equal(end.time, start.time, 'time stays the start so pricing is unchanged');
    assert(end.firstTokenTime - start.time >= 20, 'first token waits for the first output chunk, not block-start');
    assert(end.endTime - end.firstTokenTime >= 20, 'endTime is taken when the stream settles');
    await chargeTo('root', 'review', async () => { for await (const _ of call({ purpose: 'review' })) {} });
    await chargeTo('root', 'memory', async () => { for await (const _ of call({})) {} });
    for await (const _ of call({})) {}
    await chargeTo(undefined, 'memory', async () => { for await (const _ of call({})) {} });
    await chargeTo('other', 'memory', async () => { for await (const _ of call({ sessionId: 'root' })) {} });
    rows = readMetrics(home, 'root').rows;
    assert.deepEqual(rows.filter(row => row.kind === 'start').map(row => row.purpose), ['agent', 'review', 'memory', 'agent'], 'uncharged calls stay out; a wire sessionId wins over the charge');
    assert(rows.filter(row => row.kind === 'end').every(row => row.endTime >= row.time && row.sessionId === 'root'));
    assert.equal(readMetrics(home, 'other').rows.length, 0);
  } finally { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; rmSync(home, { recursive: true, force: true }); }
});

test('summarize counts an event that the ledger already recorded only once', () => {
  const rows = [
    { kind: 'start', id: 'a', time: 10 },
    { kind: 'end', id: 'a', time: 12, cost: 0.5, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } },
  ];
  // The same call, still present in the live event list after the ledger wrote it.
  const events = [
    { type: 'request/header', time: 9, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { type: 'assistant/message', time: 12, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50 } } },
  ];
  const summary = summarize(rows, events);
  assert.equal(summary.calls, 1, 'the ledger row and its event are one call, not two');
  assert.equal(summary.cost, 0.5);
});

test('the footer memo answers a cache hit and a rebuilt summary identically', t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-footer-memo-'));
  const old = process.env.DSH_HOME; process.env.DSH_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; setMetricSource(undefined); rmSync(home, { recursive: true, force: true }); });
  const events = [
    { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: 1000, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20 } } },
  ];
  setMetricSource(() => ({ events, used: 50, capacity: 100 }));
  const first = footerFor('memo', { contextWindow: 100 }, 120);
  const second = footerFor('memo', { contextWindow: 100 }, 120);
  assert.equal(second, first, 'a repeated render reuses the memo');
  // Same array identity, one more event: the length guard must rebuild.
  events.push({ type: 'step/start', time: 2000, data: { turn: 2, step: 1 } });
  events.push({ type: 'assistant/message', time: 4000, data: { turn: 2, step: 1, usage: { inputTokens: 100, outputTokens: 80 } } });
  assert.notEqual(footerFor('memo', { contextWindow: 100 }, 120), first, 'growing the event list invalidates the memo');
  // A ledger row arrives: the rows identity changes, so the cost is recomputed.
  appendMetric(home, 'memo', { kind: 'start', id: 'x', time: 10, provider: 'deepseek-official', model: 'deepseek-flash' });
  appendMetric(home, 'memo', { kind: 'end', id: 'x', time: 20, cost: 1.5, usage: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0 } });
  assert.match(footerFor('memo', { contextWindow: 100 }, 120), /\$1\.50/, 'a new ledger row reaches the footer');
});

test('the ledger reader keeps a complete row that has no trailing newline yet', t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-ledger-tail-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const path = ledgerPath(home, 'tail');
  mkdirSync(join(home, 'session-metrics'), { recursive: true });
  writeFileSync(path, '{"kind":"start","id":"a","time":1}\n{"kind":"end","id":"a","time":2,"cost":0.25,"usage":{"inputTokens":1,"outputTokens":1}}');
  const first = readMetrics(home, 'tail');
  assert.equal(first.rows.length, 2, 'a complete row without its newline is not lost');
  assert.equal(first.corrupt, false);
  // Once the writer terminates the line and appends another, nothing is counted twice.
  writeFileSync(path, '{"kind":"start","id":"a","time":1}\n{"kind":"end","id":"a","time":2,"cost":0.25,"usage":{"inputTokens":1,"outputTokens":1}}\n{"kind":"start","id":"b","time":3}\n');
  const grown = readMetrics(home, 'tail');
  assert.equal(grown.rows.length, 3);
  assert.deepEqual(grown.rows.map(row => row.id), ['a', 'a', 'b']);
});
