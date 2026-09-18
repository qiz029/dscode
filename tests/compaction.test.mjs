import test from 'node:test';
import assert from 'node:assert/strict';
import { TETRIS_HEIGHT, TETRIS_WIDTH, tetrisFrame, tetrisFrames } from '../plugins/compaction/tetris.mjs';
import { DEFAULT_THRESHOLD_RATIO, PREFETCH_LEAD_RATIO, compactionPreview, effectiveContextWindow, fitsInWindow, prefetchThresholdTokens, pricedCompactionPolicy, pricedThresholdRatio, thresholdForCacheRatio } from '../plugins/compaction/threshold.mjs';
import { cacheReadRatio } from '../plugins/session-metrics/pricing.mjs';
import { setOpenRouterModels as setOpenRouterPrices } from '../plugins/openrouter/models.mjs';
import { DscodeCompactionEngine } from '../plugins/compaction/engine.mjs';

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

test('fitsInWindow mirrors the rule the provider enforces', () => {
  assert.equal(fitsInWindow(700, { context: { contextWindow: 1000 }, defaultMaxTokens: 256 }), true);
  assert.equal(fitsInWindow(744, { context: { contextWindow: 1000 }, defaultMaxTokens: 256 }), true, 'the ceiling itself fits');
  assert.equal(fitsInWindow(745, { context: { contextWindow: 1000 }, defaultMaxTokens: 256 }), false);
  assert.equal(fitsInWindow(999, { context: { contextWindow: 1000 } }), true, 'no reserve leaves the whole window');
  assert.equal(fitsInWindow(1001, { context: { contextWindow: 1000 } }), false);
  assert.equal(fitsInWindow(10, { context: { contextWindow: undefined } }), false, 'an unknown window is never a fit');
  assert.equal(fitsInWindow(undefined, { context: { contextWindow: 1000 } }), false);
  // The observed overflow: 792,701 message tokens plus the 256k budget exceeded 1,048,576 by
  // 125 tokens, while the prune that ran first freed 87,018 of them.
  assert.equal(fitsInWindow(792_701, { context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 }), false);
  assert.equal(fitsInWindow(792_701 - 87_018, { context: { contextWindow: 1_048_576 }, defaultMaxTokens: 256_000 }), true);
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

// A fake engine carries the real prototype, so the policy under test is the
// shipped one while every dependency and the durable transaction stay stubs.
function makeEngine(overrides = {}) {
  return Object.assign(Object.create(DscodeCompactionEngine.prototype), {
    config: { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [], compactionRetries: 1, maxOverflowRetries: 1 },
    dscodePricedThreshold: true,
    dscodePrefetch: new WeakMap(),
    dscodePendingPrefetch: new WeakMap(),
    dscodeWarnedTargets: new Set(),
  }, overrides);
}

const signal = new AbortController().signal;

test('the engine subclasses the upstream backend instead of patching it', async () => {
  const { BasicCompactionEngine } = await import('@deepseek-ai/dsh-compaction-basic');
  assert.ok(DscodeCompactionEngine.prototype instanceof BasicCompactionEngine, 'the durable transaction stays upstream');
  assert.notEqual(DscodeCompactionEngine.prototype.compactIfNeeded, BasicCompactionEngine.prototype.compactIfNeeded, 'the policy is the override');
  assert.notEqual(DscodeCompactionEngine.prototype.summarize, BasicCompactionEngine.prototype.summarize, 'the prefetch injection point is the override');
});

test('pressure compaction waits for the priced threshold', async () => {
  const attempt = (provider, model, { priced = true, config = {}, modelInfo = { context: { contextWindow: 1000 } } } = {}) => {
    const engine = makeEngine({
      dscodePricedThreshold: priced,
      config: { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [], compactionRetries: 1, ...config },
      ctx: {
        get: () => undefined,
        tokenMeter: { measure: () => ({ totalTokens: 850, nodes: [{ seq: 1, tokens: 850 }] }) },
        llm: { resolveModelInfo: async () => modelInfo },
        logger: { warn: () => {} },
      },
    });
    const agent = { session: { seq: 0, surface: { nodes: [] }, requestHeader: () => ({ config: { provider, model } }) } };
    return DscodeCompactionEngine.prototype.compactIfNeeded.call(engine, agent, 'pressure', signal);
  };
  assert.equal(await attempt('deepseek-official', 'deepseek-v4-flash'), null, 'a deep cache discount waits until 90%');
  // The adapter reserves the completion budget inside the window, so the messages may only
  // reach 1000 - 256 = 744 - below the 900 a full-window priced threshold would wait for.
  await assert.rejects(attempt('deepseek-official', 'deepseek-v4-flash', { modelInfo: { context: { contextWindow: 1000 }, defaultMaxTokens: 256 } }), /surface does not match/, 'the completion reserve prices the threshold below the real ceiling');
  assert.equal(prefetchThresholdTokens(Math.floor(744 * 0.9), 744), 595, 'the prefetch mark follows the effective window');
  await assert.rejects(attempt('deepseek-official', 'deepseek-v4-flash', { priced: false, config: { thresholdRatio: 0.8 } }), /surface does not match/, 'a configured threshold keeps 80%');
  try {
    setOpenRouterPrices(OPENROUTER_FIXTURE);
    await assert.rejects(attempt('openrouter', 'plain/model'), /surface does not match/, 'no cache discount compacts at 60%');
  } finally { setOpenRouterPrices({}, 0); }
});

test('overflow recovery lets its prune decide first', async () => {
  const attempt = async (totalTokens, replacesSurface = true) => {
    let generation = 0;
    const session = {
      seq: 0,
      surface: { nodes: [], get replaceGeneration() { return generation; } },
      requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }),
    };
    const engine = makeEngine({
      config: { thresholdRatio: 0.8, retainRatio: 0.16, modelPolicies: [], compactionRetries: 1, maxOverflowRetries: 1 },
      ctx: {
        get: () => ({ pruneSession: () => { if (replacesSurface) generation += 1; } }),
        tokenMeter: { measure: () => ({ totalTokens, nodes: [{ seq: 1, tokens: totalTokens }] }) },
        llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 256 }) },
        logger: { warn: () => {} },
      },
    });
    return DscodeCompactionEngine.prototype.compactIfNeeded.call(engine, { session }, 'context-overflow', signal);
  };
  assert.equal(await attempt(700), null, 'a prune that already fits the window skips the summary');
  await assert.rejects(attempt(700, false), /surface does not match/, 'the skip needs a replaced surface, otherwise the caller would not retry');
});

test('a finished prefetch is committed over its own span without a second summary', async () => {
  const session = { seq: 0, surface: { nodes: [], replaceGeneration: 3 }, requestHeader: () => ({}) };
  const agent = { session };
  const summarized = { summary: [{ type: 'text', text: 'cached checkpoint' }] };
  const engine = makeEngine({
    dscodePrefetch: new WeakMap([[session, { range: { start: 5, end: 6 }, generation: 3, summarized, failure: null, wait: Promise.resolve() }]]),
    compactRegion: async (start, end) => {
      assert.deepEqual([start, end], [5, 6], 'the upstream transaction runs over the prefetched span');
      return engine.summarize({ messages: [] }, agent, signal);
    },
  });
  assert.equal(await DscodeCompactionEngine.prototype.dscodeCommitPrefetch.call(engine, agent, signal), summarized, 'the transaction commits the summary the prefetch already produced');
  assert.equal(engine.dscodePendingPrefetch.get(session), undefined, 'the injected summary is consumed exactly once');
  assert.equal(engine.dscodePrefetch.get(session), undefined, 'a committed prefetch is not held');

  const stale = makeEngine({
    dscodePrefetch: new WeakMap([[session, { range: { start: 5, end: 6 }, generation: 2, summarized, failure: null, wait: Promise.resolve() }]]),
    compactRegion: async () => { throw Error('an invalidated prefetch must not reach the transaction'); },
  });
  assert.equal(await DscodeCompactionEngine.prototype.dscodeCommitPrefetch.call(stale, agent, signal), null, 'a rewritten surface invalidates the prefetch');
});

test('the prefetch plan starts only between its mark and the threshold', () => {
  const session = { seq: 0, surface: { nodes: [] }, requestHeader: () => ({}) };
  const engine = makeEngine();
  const spec = { thresholdTokens: 900, contextWindow: 1000, retainTokens: 160 };
  const plan = totalTokens => DscodeCompactionEngine.prototype.dscodePlanPrefetch.call(engine, { session }, { totalTokens, nodes: [] }, spec, signal);
  plan(799);
  assert.equal(engine.dscodePrefetch.get(session), undefined, 'below the mark nothing is summarized');
  plan(900);
  assert.equal(engine.dscodePrefetch.get(session), undefined, 'the pressure path owns the threshold itself');
  plan(800);
  assert.equal(engine.dscodePrefetch.get(session), undefined, 'an empty surface offers no span to prefetch');
});

test('the target policy merges the exact-model override', () => {
  const engine = makeEngine({
    config: {
      thresholdRatio: 0.8, retainRatio: 0.16, compactionRetries: 1, maxTokens: 8192, maxOverflowRetries: 1,
      summarizationProvider: '', summarizationModel: '',
      modelPolicies: [{ provider: 'deepseek-official', model: 'deepseek-v4-pro', thresholdRatio: 0.5, retainRatio: 0.1 }],
    },
  });
  assert.deepEqual(DscodeCompactionEngine.prototype.dscodeTargetPolicy.call(engine, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }), {
    target: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, thresholdRatio: 0.5, retainRatio: 0.1,
    summarizationProvider: '', summarizationModel: '', maxTokens: 8192, compactionRetries: 1, maxOverflowRetries: 1,
  });
  const inherited = DscodeCompactionEngine.prototype.dscodeTargetPolicy.call(engine, { provider: 'other', model: 'x' });
  assert.equal(inherited.thresholdRatio, 0.8);
  assert.equal(inherited.retainRatio, 0.16);
});

test('a compact spec rejects a retention at or above its threshold', () => {
  const engine = makeEngine();
  const policy = { target: { provider: 'p', model: 'm' }, thresholdRatio: 0.9, retainRatio: 0.16 };
  assert.deepEqual(DscodeCompactionEngine.prototype.dscodeCompactSpec.call(engine, policy, 1000), { ...policy, contextWindow: 1000, thresholdTokens: 900, retainTokens: 160 });
  assert.throws(() => DscodeCompactionEngine.prototype.dscodeCompactSpec.call(engine, { target: { provider: 'p', model: 'm' }, thresholdRatio: 0.5, retainRatio: 0.5 }, 1000), /retainTokens \(500\) must be less than threshold tokens 500/);
  assert.throws(() => DscodeCompactionEngine.prototype.dscodeCompactSpec.call(engine, policy, 0), /contextWindow/);
});

test('an active compaction lock rejects a second automatic run', () => {
  const session = {
    seq: 2,
    eventAt: seq => seq === 1 ? { type: 'compaction/start', seq: 1, data: { compactionId: 'x' } } : { type: 'turn/start', seq: 0, data: { turn: 1 } },
  };
  const engine = makeEngine();
  assert.throws(() => DscodeCompactionEngine.prototype.dscodeAssertInactive.call(engine, session, 'automatic pressure compaction'), /compaction already in progress/);
  const ended = { seq: 2, eventAt: seq => seq === 1 ? { type: 'compaction/end', seq: 1, data: {} } : { type: 'turn/start', seq: 0, data: { turn: 1 } } };
  assert.equal(DscodeCompactionEngine.prototype.dscodeAssertInactive.call(engine, ended, 'automatic pressure compaction'), undefined);
});
