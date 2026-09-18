import { replaceOnce } from './patch-util.mjs';

// Auto-compaction prices its threshold from the routed model's cache discount
// (plugins/compaction/threshold.mjs) unless the deployment configured one.
export function patchCompactionPricing(text) {
  const marker = '// dscode-compaction-threshold-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text, 'import z from "@deepseek-ai/schemastery";', 'import { pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";\nimport z from "@deepseek-ai/schemastery";');
  text = replaceOnce(text, '\treturn deepFreeze({\n\t\tthresholdRatio,\n', '\treturn deepFreeze({\n\t\tthresholdRatio,\n\t\tdscodePricedThreshold: config.thresholdRatio === void 0,\n');
  text = replaceOnce(text, 'const spec = resolveCompactSpec(policy, context.contextWindow);', 'const spec = resolveCompactSpec(await dscodePricedCompactionPolicy(this.config, policy), context.contextWindow);');
  return marker + '\n' + text;
}

// Prefetch compaction: one lead below the priced threshold the engine summarizes
// the oldest compactable span in the background without appending anything, and
// crossing the threshold commits that summary instead of summarizing again. The
// content appended past the prefetched span stays verbatim behind the
// checkpoint, and a commit that still has to wait opens the ordinary compaction
// marker first, so the TUI keeps showing its compaction indicator.
export function patchCompactionPrefetch(text) {
  const marker = '// dscode-compaction-prefetch-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text,
    'import { pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";',
    'import { prefetchThresholdTokens as dscodePrefetchThresholdTokens, pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";');
  text = replaceOnce(text,
    '\t\tconst spec = resolveCompactSpec(await dscodePricedCompactionPolicy(this.config, policy), context.contextWindow);\n',
    '\t\tconst spec = resolveCompactSpec(await dscodePricedCompactionPolicy(this.config, policy), context.contextWindow);\n' +
    '\t\tthis.dscodePlanPrefetch(agent, measurement, spec, context.contextWindow, signal);\n');
  text = replaceOnce(text,
    '\t\tlet result = null;\n\t\tfor (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {',
    '\t\tlet result = null;\n' +
    '\t\tconst dscodePrefetched = await this.dscodeCommitPrefetch(agent);\n' +
    '\t\tif (dscodePrefetched !== null) {\n' +
    '\t\t\tresult = dscodePrefetched;\n' +
    '\t\t\tmeasurement = meter.measure(agent.session);\n' +
    '\t\t\tif (measurement.totalTokens < spec.thresholdTokens) return result;\n' +
    '\t\t}\n' +
    '\t\tfor (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {');
  text = replaceOnce(text, DSCODE_REGION_ANCHOR, dscodePrefetchMethods() + DSCODE_REGION_ANCHOR);
  return marker + '\n' + text;
}

/** Apply every compaction patch to one pinned engine source, in marker order. */
export function patchCompactionBasic(text) {
  return patchCompactionOverflowPrune(patchCompactionReserve(patchCompactionPrefetch(patchCompactionPricing(text))));
}

// Completion reserve: an adapter that keeps the completion budget inside the context
// window rejects the request once messages plus completion exceed the window, so the
// messages may only reach window - maxTokens. Pricing the threshold from the full window
// put it above that ceiling, which made the pressure path - and with it prefetch
// compaction - unreachable: every compaction arrived as overflow recovery, which prunes
// and then summarizes synchronously (v0.7.15 measured a 26.8 s stall per compaction).
// Overflow recovery: the pruner runs first and may already return the failed request under the
// window. The caller retries whenever that prune replaced the surface, so a summary here would
// only add a model call and its stall to a request that no longer needs one. v0.7.15 hit this
// with a 125-token overshoot: pruning freed 87k tokens and the engine still summarized for 26.8 s.
export function patchCompactionOverflowPrune(text) {
  const marker = '// dscode-compaction-overflow-prune-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text,
    'import { effectiveContextWindow as dscodeEffectiveContextWindow, prefetchThresholdTokens as dscodePrefetchThresholdTokens, pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";',
    'import { effectiveContextWindow as dscodeEffectiveContextWindow, fitsInWindow as dscodeFitsInWindow, prefetchThresholdTokens as dscodePrefetchThresholdTokens, pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";');
  text = replaceOnce(text, DSCODE_REGION_ANCHOR, dscodeOverflowFitsMethod() + DSCODE_REGION_ANCHOR);
  text = replaceOnce(text, DSCODE_OVERFLOW_PRUNE_BLOCK, DSCODE_OVERFLOW_PRUNE_BLOCK_AFTER);
  return marker + '\n' + text;
}

/** The overflow branch's prune-then-compact prologue, matched exactly once. */
const DSCODE_OVERFLOW_PRUNE_BLOCK = '\t\t\tif (prune !== void 0) {\n\t\t\t\tprune.pruneSession(agent.session);\n\t\t\t\tmeasurement = meter.measure(agent.session);\n\t\t\t}\n\t\t\tconst range = selectCompactableRange(agent.session, measurement, 0);';
/** The same prologue, remembering the surface generation and skipping a needless summary. */
const DSCODE_OVERFLOW_PRUNE_BLOCK_AFTER = '\t\t\tconst dscodePrunedGeneration = agent.session.surface.replaceGeneration;\n\t\t\tif (prune !== void 0) {\n\t\t\t\tprune.pruneSession(agent.session);\n\t\t\t\tmeasurement = meter.measure(agent.session);\n\t\t\t}\n\t\t\tif (await this.dscodeOverflowFits(agent, target, dscodePrunedGeneration, measurement, signal)) return null;\n\t\t\tconst range = selectCompactableRange(agent.session, measurement, 0);';

/** The overflow-recovery fit check, inserted ahead of the region dependencies it reuses. */
function dscodeOverflowFitsMethod() {
  return [
    '\t/**',
    '\t * dscode: whether overflow-recovery pruning alone returned the failed request under the',
    '\t * window. The caller retries whenever the prune replaced the surface, so a summary here',
    '\t * would only add a model call and its stall to a request that already fits.',
    '\t * @param agent - agent recovering from a provider context overflow.',
    '\t * @param target - the routed provider/model that rejected the request.',
    '\t * @param generation - the surface generation before the prune.',
    '\t * @param measurement - the measurement taken after the prune.',
    '\t * @param signal - live turn cancellation signal.',
    '\t * @returns whether the retry may skip compaction.',
    '\t */',
    '\tasync dscodeOverflowFits(agent, target, generation, measurement, signal) {',
    '\t\tif (agent.session.surface.replaceGeneration <= generation) return false;',
    '\t\tconst info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);',
    '\t\treturn dscodeFitsInWindow(measurement.totalTokens, info);',
    '\t}',
    '',
  ].join('\n');
}
export function patchCompactionReserve(text) {
  const marker = '// dscode-compaction-reserve-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text,
    'import { prefetchThresholdTokens as dscodePrefetchThresholdTokens, pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";',
    'import { effectiveContextWindow as dscodeEffectiveContextWindow, prefetchThresholdTokens as dscodePrefetchThresholdTokens, pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";');
  text = replaceOnce(text,
    'const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;',
    'const dscodeModelInfo = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);\n\t\tconst context = dscodeModelInfo.context;');
  text = replaceOnce(text,
    'const spec = resolveCompactSpec(await dscodePricedCompactionPolicy(this.config, policy), context.contextWindow);',
    'const spec = resolveCompactSpec(await dscodePricedCompactionPolicy(this.config, policy), dscodeEffectiveContextWindow(context, dscodeModelInfo));');
  text = replaceOnce(text,
    'this.dscodePlanPrefetch(agent, measurement, spec, context.contextWindow, signal);',
    'this.dscodePlanPrefetch(agent, measurement, spec, spec.contextWindow, signal);');
  return marker + '\n' + text;
}

const DSCODE_REGION_ANCHOR = '\t/** Bind the effective token meter and dynamically dispatched summarizer hook. */\n\tregionDependencies() {';

/** The prefetch methods, inserted ahead of the region dependencies they reuse. */
function dscodePrefetchMethods() {
  return [
    '\t/** dscode: the one background prefetch this engine may hold per session. */',
    '\tdscodePrefetch = /* @__PURE__ */ new WeakMap();',
    '\t/**',
    '\t * dscode: start one background summarization of the oldest compactable span once the',
    '\t * measured pressure crosses the prefetch mark, one lead below the priced threshold.',
    '\t * Nothing is appended and no compaction lock is taken, so an invalidated or cancelled',
    '\t * prefetch costs only the summarization call.',
    '\t * @param agent - agent whose pressure the caller just priced.',
    '\t * @param measurement - the measurement the caller priced.',
    '\t * @param spec - the caller\'s resolved spec for this route.',
    '\t * @param contextWindow - the route\'s context window.',
    '\t * @param signal - live turn signal forwarded to the summarizer.',
    '\t */',
    '\tdscodePlanPrefetch(agent, measurement, spec, contextWindow, signal) {',
    '\t\tconst session = agent.session;',
    '\t\tconst existing = this.dscodePrefetch.get(session);',
    '\t\tif (existing !== void 0) {',
    '\t\t\tif (existing.failure === null) return;',
    '\t\t\tthis.dscodePrefetch.delete(session);',
    '\t\t}',
    '\t\tif (measurement.totalTokens >= spec.thresholdTokens) return;',
    '\t\tif (measurement.totalTokens < dscodePrefetchThresholdTokens(spec.thresholdTokens, contextWindow)) return;',
    '\t\tif (inspectCompactionEntryState(session).unmatchedCompactionStart !== void 0) return;',
    '\t\tconst range = selectCompactableRange(session, measurement, spec.retainTokens);',
    '\t\tif (range === null) return;',
    '\t\tlet selection;',
    '\t\ttry {',
    '\t\t\tselection = validateSurfaceRegion(session, range.start, range.end);',
    '\t\t} catch (error) {',
    '\t\t\treturn;',
    '\t\t}',
    '\t\tconst prefetch = { compactionId: CompactionId(randomUUID()), summarized: null, failure: null, wait: null };',
    '\t\tthis.dscodePrefetch.set(session, prefetch);',
    '\t\tprefetch.wait = (async () => {',
    '\t\t\ttry {',
    '\t\t\t\tprefetch.summarized = await summarizeCompaction(this.regionDependencies(), prepareCompaction(this.regionDependencies(), session, selection), agent, prefetch.compactionId, void 0, signal);',
    '\t\t\t} catch (error) {',
    '\t\t\t\tprefetch.failure = error;',
    '\t\t\t}',
    '\t\t})();',
    '\t}',
    '\t/**',
    '\t * dscode: commit the pending prefetch, or return null so the caller summarizes afresh.',
    '\t * A finished summary is validated before the durable marker opens; one still running',
    '\t * opens the marker first, so its wait carries the ordinary compaction indicator.',
    '\t * Commit replaces the prefetched span with its checkpoint and leaves everything',
    '\t * appended after it verbatim.',
    '\t * @param agent - agent whose pressure triggered the automatic compaction.',
    '\t * @returns the committed compaction result, or null when no prefetch was usable.',
    '\t */',
    '\tasync dscodeCommitPrefetch(agent) {',
    '\t\tconst session = agent.session;',
    '\t\tconst prefetch = this.dscodePrefetch.get(session);',
    '\t\tif (prefetch === void 0) return null;',
    '\t\tthis.dscodePrefetch.delete(session);',
    '\t\tif (prefetch.failure !== null) return null;',
    '\t\tconst dependencies = this.regionDependencies();',
    '\t\tif (prefetch.summarized !== null) try {',
    '\t\t\tassertSelectedSpanStable(dependencies, session, prefetch.summarized);',
    '\t\t} catch (error) {',
    '\t\t\treturn null;',
    '\t\t}',
    '\t\tconst openTurn = inspectCompactionEntryState(session).openTurn;',
    '\t\tconst lifecycle = {',
    '\t\t\tcompactionId: prefetch.compactionId,',
    '\t\t\t...openTurn === null ? {} : { turn: openTurn }',
    '\t\t};',
    '\t\tconst startEvent = session.append("compaction/start", lifecycle);',
    '\t\tlet closing = false;',
    '\t\ttry {',
    '\t\t\tawait prefetch.wait;',
    '\t\t\tif (prefetch.failure !== null) throw prefetch.failure;',
    '\t\t\tassertSelectedSpanStable(dependencies, session, prefetch.summarized);',
    '\t\t\tconst pending = commitCompactionBody(session, startEvent, prefetch.summarized);',
    '\t\t\tclosing = true;',
    '\t\t\tconst endEvent = session.append("compaction/end", lifecycle);',
    '\t\t\treturn completeCompaction(pending, endEvent);',
    '\t\t} catch (error) {',
    '\t\t\tif (!closing) session.append("compaction/end", { ...lifecycle, error: errorChain(error) });',
    '\t\t\treturn null;',
    '\t\t}',
    '\t}',
    '',
  ].join('\n');
}
