import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { TETRIS_HEIGHT, TETRIS_WIDTH, tetrisFrame, tetrisFrames } from '../plugins/compaction/tetris.mjs';
import { DEFAULT_THRESHOLD_RATIO, PREFETCH_LEAD_RATIO, compactionPreview, effectiveContextWindow, prefetchThresholdTokens, pricedCompactionPolicy, pricedThresholdRatio, thresholdForCacheRatio } from '../plugins/compaction/threshold.mjs';
import { cacheReadRatio } from '../plugins/session-metrics/pricing.mjs';
import { setOpenRouterModels as setOpenRouterPrices } from '../plugins/openrouter/models.mjs';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { patchCompactionBasic } from '../scripts/patch-compaction.mjs';

const TODAY = Date.UTC(2026, 8, 14, 12);
const OPENROUTER_FIXTURE = { 'cached/model': { input: 3, output: 15, cacheRead: 0.75 }, 'plain/model': { input: 1, output: 2 } };

test('the Tetris bot clears the well every loop', () => {
  const frames = tetrisFrames();
  assert(frames.every(frame => frame.length === TETRIS_HEIGHT && frame.every(row => row.length === TETRIS_WIDTH && /^[.@#=]+$/.test(row))));
  assert(frames.every(frame => frame.join('').split('@').length - 1 <= 4), 'at most one falling piece');
  assert(frames.some(frame => frame.includes('='.repeat(TETRIS_WIDTH))), 'full rows flash before they clear');
  assert.deepEqual(frames.at(-1), Array(TETRIS_HEIGHT).fill('.'.repeat(TETRIS_WIDTH)), 'the loop ends on an empty well');
  assert.deepEqual(tetrisFrame(frames.length + 2), frames[2]);
  assert.deepEqual(tetrisFrame(-1), frames.at(-1));
});

test('the compaction threshold follows the cache discount tiers', () => {
  for (const [ratio, threshold] of [[0, 0.9], [0.02, 0.9], [0.0999, 0.9], [0.1, 0.8], [0.4999, 0.8], [0.5, 0.6], [1, 0.6], [undefined, 0.8], [NaN, 0.8], [-1, 0.8]]) {
    assert.equal(thresholdForCacheRatio(ratio), threshold, String(ratio));
  }
  assert.equal(DEFAULT_THRESHOLD_RATIO, 0.8);
});

test('the prefetch mark leads the priced threshold by a tenth of the window', () => {
  assert.equal(PREFETCH_LEAD_RATIO, 0.1);
  assert.equal(prefetchThresholdTokens(800, 1000), 700, 'the default 80% threshold prefetches at 70%');
  assert.equal(prefetchThresholdTokens(600, 1000), 500);
  assert.equal(prefetchThresholdTokens(900, 1000), 800);
  assert.equal(prefetchThresholdTokens(800, 1000, 0), 800, 'a zero lead prefetches at the threshold');
  assert.equal(prefetchThresholdTokens(50, 1000), 0, 'a tiny threshold never goes negative');
  assert.equal(prefetchThresholdTokens(800, undefined), 800, 'an unknown window keeps the threshold');
  assert.equal(prefetchThresholdTokens(800, 0), 800);
  assert.ok(Number.isNaN(prefetchThresholdTokens(Number.NaN, 1000)));
});

test('the effective window subtracts the completion budget the adapter reserves', async () => {
  assert.equal(effectiveContextWindow({ contextWindow: 1000 }, { defaultMaxTokens: 256 }), 744);
  assert.equal(effectiveContextWindow({ contextWindow: 1000 }, {}), 1000, 'an adapter without a completion budget keeps the window');
  assert.equal(effectiveContextWindow({ contextWindow: 1000 }, { defaultMaxTokens: 0 }), 1000);
  assert.equal(effectiveContextWindow({ contextWindow: 1000 }, { defaultMaxTokens: 1000 }), 1000, 'a reserve as large as the window is ignored');
  assert.equal(effectiveContextWindow({ contextWindow: 0 }, { defaultMaxTokens: 256 }), 0);
  assert.equal(effectiveContextWindow(undefined, { defaultMaxTokens: 256 }), undefined);
  // The real route: DeepSeek's 1M window with its 256k default completion budget. The provider
  // rejected a request whose 792,701 message tokens plus 256,000 completion tokens exceeded
  // 1,048,576, so a 90% threshold priced from the full window (943,718) could never fire first.
  assert.equal(effectiveContextWindow({ contextWindow: 1_048_576 }, { defaultMaxTokens: 256_000 }), 792_576);
  assert.ok(792_576 + 256_000 <= 1_048_576, 'the message ceiling plus the reserve fits the window');
  // The real resolver, not a hand-written contract: the DeepSeek adapter reports the
  // completion budget as a top-level `defaultMaxTokens`, and its 1M default window plus
  // the 256k budget is exactly the pair that rejected the request behind this fix.
  const { DeepSeekAdapter, DEFAULT_MAX_TOKENS, DEFAULT_CONTEXT_WINDOW } = await import('@deepseek-ai/dsh-llm-deepseek');
  assert.equal(DEFAULT_MAX_TOKENS, 256_000);
  assert.equal(DEFAULT_CONTEXT_WINDOW, 1_000_000);
  const connection = { models: [], defaultContextWindow: 1_048_576, maxTokens: DEFAULT_MAX_TOKENS, defaults: { thinking: 'disabled' } };
  const info = DeepSeekAdapter.prototype.modelInfoFor.call({}, connection, 'deepseek-official', 'deepseek-flash');
  assert.equal(info.defaultMaxTokens, 256_000, 'the reserve is a top-level field of the resolved model info');
  assert.equal(info.context.contextWindow, 1_048_576);
  assert.equal(effectiveContextWindow(info.context, info), 792_576, 'the engine patch prices this exact pair');
});

test('route prices give the cache-read ratio', async () => {
  assert.equal(cacheReadRatio('deepseek-official', 'deepseek-v4-flash', TODAY), 0.003 / 0.15);
  assert.equal(cacheReadRatio('deepseek-official', 'deepseek-v4-pro', Date.UTC(2026, 8, 12)), 0.022 / 0.66);
  assert.equal(cacheReadRatio('deepseek-official', 'deepseek-v4-flash', Date.UTC(2026, 8, 1)), undefined, 'no back-pricing before the price table');
  assert.equal(cacheReadRatio('proxy', 'deepseek-flash', TODAY), undefined);
  assert.equal(cacheReadRatio('openrouter', 'deepseek/deepseek-v4-flash'), 0.017052 / 0.08526, 'the pinned table is the fallback');
  try {
    setOpenRouterPrices(OPENROUTER_FIXTURE);
    assert.equal(cacheReadRatio('openrouter', 'cached/model'), 0.25);
    assert.equal(cacheReadRatio('openrouter', 'plain/model'), 1, 'no cache-read price bills cached input at the input rate');
    assert.equal(cacheReadRatio('openrouter', 'missing/model'), undefined);
    assert.equal(await pricedThresholdRatio('openrouter', 'cached/model'), 0.8);
    assert.equal(await pricedThresholdRatio('openrouter', 'plain/model'), 0.6);
  } finally { setOpenRouterPrices({}, 0); }
  assert.equal(await pricedThresholdRatio('deepseek-official', 'deepseek-v4-pro', TODAY), 0.9);
});

test('a configured threshold wins over the priced one', async () => {
  const policy = Object.freeze({ target: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, thresholdRatio: 0.8, retainRatio: 0.16 });
  const priced = { dscodePricedThreshold: true, modelPolicies: [] };
  assert.deepEqual(await pricedCompactionPolicy(priced, policy, TODAY), { ...policy, thresholdRatio: 0.9 });
  assert.equal(await pricedCompactionPolicy({ ...priced, dscodePricedThreshold: false }, policy, TODAY), policy);
  assert.equal(await pricedCompactionPolicy({ ...priced, modelPolicies: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', thresholdRatio: 0.7 }] }, policy, TODAY), policy);
  const wideTail = { ...policy, retainRatio: 0.9 };
  assert.equal(await pricedCompactionPolicy(priced, wideTail, TODAY), wideTail, 'a retained tail at the priced threshold keeps the configured policy');
  assert.equal((await pricedCompactionPolicy(priced, { ...policy, target: { provider: 'proxy', model: 'x' } }, TODAY)).thresholdRatio, 0.8);
});

test('a model switch preview compares the context with the new threshold', () => {
  assert.deepEqual(compactionPreview({ used: 700, contextWindow: 1000, thresholdRatio: 0.6, label: 'openrouter/plain/model' }),
    { label: 'openrouter/plain/model', used: 700, contextWindow: 1000, thresholdRatio: 0.6, threshold: 600, compacts: true, overflows: false });
  assert.equal(compactionPreview({ used: 500, contextWindow: 1000, thresholdRatio: 0.6 }).compacts, false);
  assert.equal(compactionPreview({ used: 1200, contextWindow: 1000, thresholdRatio: 0.9 }).overflows, true);
  assert.equal(compactionPreview({ used: 0, contextWindow: 1000, thresholdRatio: 0.9 }), undefined);
  assert.equal(compactionPreview({ used: 10, contextWindow: undefined, thresholdRatio: 0.9 }), undefined);
});

test('compaction-basic compacts at the priced threshold', async t => {
  const fixture = createTestRuntime({ runtime: true });
  t.after(fixture.close);
  const file = `${fixture.root}/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`;
  const text = readFileSync(file, 'utf8');
  assert(text.startsWith('// dscode-compaction-reserve-v1\n'));
  assert(text.includes('// dscode-compaction-prefetch-v1'));
  assert(text.includes('// dscode-compaction-threshold-v1'));
  assert.equal(patchCompactionBasic(text), text);
  assert.throws(() => patchCompactionBasic('unknown upstream'), /drift/);
  assert.match(text, /dscodeEffectiveContextWindow\(context, dscodeModelInfo\)/);
  assert.match(text, /dscodePlanPrefetch\(agent, measurement, spec, spec\.contextWindow, signal\)/);
  assert.match(text, /const dscodePrefetched = await this\.dscodeCommitPrefetch\(agent\);/);
  const { BasicCompactionEngine } = await import(pathToFileURL(file).href);
  // Below the prefetch mark, and again once the threshold itself is due, the plan
  // step leaves the engine without a background summary to commit.
  const spec = { thresholdTokens: 800, retainTokens: 160 };
  const session = { seq: 0, eventAt: () => undefined, surface: { nodes: [] } };
  const signal = new AbortController().signal;
  let summarized = false;
  const engine = { config: {}, dscodePrefetch: new WeakMap(), ctx: { get: () => undefined }, regionDependencies: () => ({ meter: { measure: () => ({ totalTokens: 0, nodes: [] }) }, summarize: () => { summarized = true; } }) };
  const plan = totalTokens => BasicCompactionEngine.prototype.dscodePlanPrefetch.call(engine, { session }, { totalTokens, nodes: [] }, spec, 1000, signal);
  plan(699);
  assert.equal(summarized, false, 'below the mark nothing is summarized');
  assert.equal(engine.dscodePrefetch.get(session), undefined);
  plan(800);
  assert.equal(engine.dscodePrefetch.get(session), undefined, 'the pressure path owns the threshold itself');
  assert.equal(await BasicCompactionEngine.prototype.dscodeCommitPrefetch.call(engine, { session }), null, 'a missing prefetch commits nothing');
  // 850 of 1000 tokens: past 80% and 60%, below 90%. A pass past the threshold reaches range selection,
  // which rejects this fake surface; a pass below it returns null first. The prefetch plan is stubbed
  // out here because this surface cannot support it; its own behaviour is covered separately.
  const planned = [];
  const attempt = (provider, model, dscodePricedThreshold = true, modelInfo = { context: { contextWindow: 1000 } }) => BasicCompactionEngine.prototype.compactIfNeeded.call({
    config: { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [], dscodePricedThreshold, compactionRetries: 1, maxOverflowRetries: 1 },
    ctx: { get: () => undefined, tokenMeter: { measure: () => ({ totalTokens: 850, nodes: [{ seq: 1, tokens: 850 }] }) }, llm: { resolveModelInfo: async () => modelInfo } },
    dscodePrefetch: new WeakMap(),
    dscodePlanPrefetch: (agent, measurement, spec, contextWindow) => { planned.push({ spec, contextWindow }); },
    dscodeCommitPrefetch: BasicCompactionEngine.prototype.dscodeCommitPrefetch,
  }, { session: { seq: 0, surface: { nodes: [] }, requestHeader: () => ({ config: { provider, model } }) } }, 'pressure', new AbortController().signal);
  assert.equal(await attempt('deepseek-official', 'deepseek-v4-flash'), null, 'a deep cache discount waits until 90%');
  // The adapter reserves the completion budget inside the window, so the messages may only
  // reach 1000 - 256 = 744 - below the 900 a full-window priced threshold would wait for.
  // Before the reserve was priced in this returned null: the pressure path could never come
  // due, and every compaction arrived as overflow recovery (a rejected request, then a
  // synchronous summary - v0.7.15 measured 26.8 s of stall).
  await assert.rejects(attempt('deepseek-official', 'deepseek-v4-flash', true, { context: { contextWindow: 1000 }, defaultMaxTokens: 256 }), /surface does not match/, 'the completion reserve prices the threshold below the real ceiling');
  assert.equal(prefetchThresholdTokens(Math.floor(744 * 0.9), 744), 595, 'the prefetch mark follows the effective window');
  assert.equal(planned.at(-1).spec.contextWindow, 744, 'the resolved spec carries the effective window');
  assert.equal(planned.at(-1).contextWindow, 744, 'the prefetch plan is priced from the effective window');
  await assert.rejects(attempt('deepseek-official', 'deepseek-v4-flash', false), /surface does not match/, 'a configured threshold keeps 80%');
  try {
    setOpenRouterPrices(OPENROUTER_FIXTURE);
    await assert.rejects(attempt('openrouter', 'plain/model'), /surface does not match/, 'no cache discount compacts at 60%');
  } finally { setOpenRouterPrices({}, 0); }
});

