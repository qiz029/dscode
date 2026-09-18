import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { ManualCompactionError, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
import { SessionSeq } from '@deepseek-ai/dsh-session';
import { effectiveContextWindow, fitsInWindow, prefetchThresholdTokens, pricedCompactionPolicy } from './threshold.mjs';

// DSCODE's compaction policy as a subclass of the upstream engine instead of a
// build-time patch of its source. It owns exactly the decisions this deployment
// adds - a threshold priced from the route's cache discount, the adapter's
// completion reserve, background prefetch, and overflow recovery that lets
// pruning decide first - and leaves the durable surface transaction to the
// upstream `compactRegion`, which stays the only writer.
//
// `BasicCompactionEngine` registers the automatic hooks itself and dispatches
// them through `this.compactIfNeeded`, so overriding it here replaces the policy
// without touching the installed package.
export class DscodeCompactionEngine extends BasicCompactionEngine {
  constructor(ctx, config) {
    super(ctx, config);
    // The upstream default hides whether the deployment configured a threshold,
    // so the priced policy is enabled only when the raw config left it unset.
    this.dscodePricedThreshold = config?.thresholdRatio === undefined;
    this.dscodePrefetch = new WeakMap();
    this.dscodePendingPrefetch = new WeakMap();
    this.dscodeWarnedTargets = new Set();
  }

  /**
   * Compact for step-boundary pressure or one provider-confirmed overflow, with
   * the threshold priced from the route's cache discount and the completion
   * budget the adapter reserves inside the window.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  async compactIfNeeded(agent, trigger, signal) {
    const target = this.dscodeRoutedTarget(agent.session);
    if (target === undefined) return null;
    const policy = this.dscodeTargetPolicy(target);
    const meter = this.ctx.tokenMeter;
    const prune = this.ctx.get('toolResultPruner');
    let measurement = meter.measure(agent.session);

    if (trigger === 'context-overflow') {
      // The pruner runs first and may already return the failed request under the
      // window. The caller retries whenever that prune replaced the surface, so a
      // summary here would only add a model call and its stall to a request that
      // no longer needs one.
      const generation = agent.session.surface.replaceGeneration;
      if (prune !== undefined) {
        prune.pruneSession(agent.session);
        measurement = meter.measure(agent.session);
      }
      if (agent.session.surface.replaceGeneration > generation) {
        const info = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
        if (fitsInWindow(measurement.totalTokens, info)) return null;
      }
      return this.dscodeCompactOldest(agent, measurement, 0, signal);
    }

    const modelInfo = await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal);
    const context = modelInfo.context;
    if (context === undefined) {
      const key = `${target.provider}/${target.model}`;
      if (!this.dscodeWarnedTargets.has(key)) {
        this.dscodeWarnedTargets.add(key);
        this.ctx.logger.warn(`compaction: no context capacity for ${key}; configure contextWindow on that adapter model`);
      }
      return null;
    }
    this.dscodeAssertInactive(agent.session, 'automatic pressure compaction');
    const spec = this.dscodeCompactSpec(await pricedCompactionPolicy({ ...this.config, dscodePricedThreshold: this.dscodePricedThreshold }, policy), effectiveContextWindow(context, modelInfo));

    this.dscodePlanPrefetch(agent, measurement, spec, signal);
    if (measurement.totalTokens < spec.thresholdTokens) return null;
    if (prune !== undefined) {
      prune.pruneSession(agent.session);
      measurement = meter.measure(agent.session);
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null;

    let result = null;
    const prefetched = await this.dscodeCommitPrefetch(agent, signal);
    if (prefetched !== null) {
      result = prefetched;
      measurement = meter.measure(agent.session);
      if (measurement.totalTokens < spec.thresholdTokens) return result;
    }
    for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) {
      const range = this.dscodeSelectRange(agent.session, measurement, spec.retainTokens);
      if (range === null) {
        if (result === null) return null;
        break;
      }
      result = await this.compactRegion(range.start, range.end, agent, signal);
      measurement = meter.measure(agent.session);
      if (measurement.totalTokens < spec.thresholdTokens) return result;
    }
    throw new Error(`compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts (${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`);
  }

  /**
   * Summarize the replayed region through the upstream cache-reusing call, or
   * return the summary a prefetch already produced for this exact commit.
   * @param input - replayed conversation prefix to condense.
   * @param agent - supplies routed-model history, fallback model, and session id.
   * @param signal - optional cancellation forwarded to the adapter.
   * @returns the summary blocks and the call envelope behind them.
   */
  async summarize(input, agent, signal) {
    const pending = this.dscodePendingPrefetch.get(agent.session);
    if (pending === undefined) return super.summarize(input, agent, signal);
    this.dscodePendingPrefetch.delete(agent.session);
    // The upstream transaction already opened its marker, so this wait is the visible
    // compaction. A failed or invalidated prefetch falls back to a fresh call instead
    // of failing a transaction that has already begun.
    await pending.wait;
    if (pending.failure !== null || agent.session.surface.replaceGeneration !== pending.generation) return super.summarize(input, agent, signal);
    return pending.summarized;
  }

  /** Compact the oldest compactable span for a retention budget, or return null when none is safe. */
  async dscodeCompactOldest(agent, measurement, retainTokens, signal) {
    const range = this.dscodeSelectRange(agent.session, measurement, retainTokens);
    if (range === null) return null;
    return this.compactRegion(range.start, range.end, agent, signal);
  }

  /** The routed provider/model of the session's latest durable request. */
  dscodeRoutedTarget(session) {
    const config = session.requestHeader()?.config;
    if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined;
    return { provider: config.provider, model: config.model };
  }

  /** Merge the exact-target override over the validated defaults for one routed target. */
  dscodeTargetPolicy(target) {
    const config = this.config;
    const override = config.modelPolicies.find(entry => entry.provider === target.provider && entry.model === target.model);
    const inherited = config.retainTokens === undefined ? { retainRatio: config.retainRatio } : { retainTokens: config.retainTokens };
    const retention = override?.retainTokens !== undefined ? { retainTokens: override.retainTokens }
      : override?.retainRatio !== undefined ? { retainRatio: override.retainRatio }
        : inherited;
    return {
      target: { ...target },
      thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
      ...retention,
      summarizationProvider: override?.summarizationProvider ?? config.summarizationProvider,
      summarizationModel: override?.summarizationModel ?? config.summarizationModel,
      maxTokens: override?.maxTokens ?? config.maxTokens,
      compactionRetries: override?.compactionRetries ?? config.compactionRetries,
      maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
    };
  }

  /** Scale one routed policy into concrete token budgets for its effective window. */
  dscodeCompactSpec(policy, contextWindow) {
    const key = `${policy.target.provider}/${policy.target.model}`;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) throw new Error(`compaction: contextWindow (${contextWindow}) must be a positive integer for ${key}`);
    const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
    const retainTokens = policy.retainTokens === undefined ? Math.floor(contextWindow * policy.retainRatio) : policy.retainTokens;
    if (retainTokens >= thresholdTokens) throw new Error(`compaction: retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens} for ${key}`);
    return { ...policy, contextWindow, thresholdTokens, retainTokens };
  }

  /**
   * Resolve the next range starting at the first non-system surface node while
   * retaining a priced recent tail and never splitting a tool-call/result pair.
   * @param session - session supplying authoritative current surface positions.
   * @param measurement - unified pressure and surface measurement from the conversation meter.
   * @param retainTokens - minimum recent tail budget retained verbatim.
   * @returns the positional range to compact, or `null`.
   */
  dscodeSelectRange(session, measurement, retainTokens) {
    const pricedNodes = measurement.nodes;
    if (pricedNodes.length === 0) return null;
    const surfaceNodes = session.surface.nodes;
    if (surfaceNodes.length !== pricedNodes.length || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) throw new Error('compaction: token-meter surface does not match the current session surface');
    const firstIdx = this.dscodeSystemHead(session, surfaceNodes[0]) === undefined ? 0 : 1;
    let accumulated = 0;
    let keepFromIdx = pricedNodes.length;
    for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
      accumulated += pricedNodes[index].tokens;
      keepFromIdx = index;
      if (accumulated >= retainTokens) break;
    }
    if (keepFromIdx <= firstIdx) return null;
    while (keepFromIdx > firstIdx) {
      if (toolPairingBalancedBefore(session, surfaceNodes[keepFromIdx])) break;
      keepFromIdx -= 1;
    }
    if (keepFromIdx <= firstIdx) return null;
    return { start: surfaceNodes[firstIdx], end: surfaceNodes[keepFromIdx - 1], startIdx: firstIdx, endIdx: keepFromIdx - 1 };
  }

  /** The `system/message` at a surface head, or undefined when that node is something else. */
  dscodeSystemHead(session, headSeq) {
    if (headSeq === undefined) return undefined;
    const head = session.eventAt(headSeq);
    return head.type === 'system/message' ? head : undefined;
  }

  /** The replayed conversation prefix a summary call condenses: system head, tools, then the shadowed messages. */
  dscodeSummarizationInput(session, shadowedSeqs) {
    const header = session.requestHeader();
    const nodes = session.surface.nodes;
    const system = this.dscodeSystemHead(session, nodes[0]);
    const head = system === undefined ? null : session.deriveEventMessage(system);
    const region = shadowedSeqs.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(message => message !== null);
    return { ...header?.tools === undefined ? {} : { tools: header.tools }, messages: head === null ? region : [head, ...region] };
  }

  /** The newest unmatched compaction start and end-seed boundary of one session. */
  dscodeEntryState(session) {
    let unmatchedCompactionStart;
    let entryStateKnown = false;
    let latestEndSeedSeq;
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(SessionSeq(seq));
      if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') latestEndSeedSeq = event.seq;
      if (!entryStateKnown) {
        if (event.type === 'compaction/start') {
          unmatchedCompactionStart = event;
          entryStateKnown = true;
        } else if (event.type === 'compaction/end') entryStateKnown = true;
      }
      if (entryStateKnown && latestEndSeedSeq !== undefined) break;
    }
    return { unmatchedCompactionStart, latestEndSeedSeq };
  }

  /** Reject a second compaction while the durable compaction lock is active. */
  dscodeAssertInactive(session, stage) {
    const { unmatchedCompactionStart, latestEndSeedSeq } = this.dscodeEntryState(session);
    if (unmatchedCompactionStart === undefined || (latestEndSeedSeq !== undefined && latestEndSeedSeq > unmatchedCompactionStart.seq)) return;
    throw new ManualCompactionError('busy', `${stage}: compaction already in progress; the session compaction lock is already active`);
  }

  /**
   * Start one background summarization of the oldest compactable span once the
   * measured pressure crosses the mark one lead below the priced threshold.
   * Nothing is appended and no compaction lock is taken, so an invalidated or
   * cancelled prefetch costs only the summarization call.
   * @param agent - agent whose pressure the caller just priced.
   * @param measurement - the measurement the caller priced.
   * @param spec - the caller's resolved spec for this route.
   * @param signal - live turn signal forwarded to the summarizer.
   */
  dscodePlanPrefetch(agent, measurement, spec, signal) {
    const session = agent.session;
    const existing = this.dscodePrefetch.get(session);
    if (existing !== undefined) {
      if (existing.failure === null) return;
      this.dscodePrefetch.delete(session);
    }
    if (measurement.totalTokens >= spec.thresholdTokens) return;
    if (measurement.totalTokens < prefetchThresholdTokens(spec.thresholdTokens, spec.contextWindow)) return;
    if (this.dscodeEntryState(session).unmatchedCompactionStart !== undefined) return;
    let range;
    try {
      range = this.dscodeSelectRange(session, measurement, spec.retainTokens);
    } catch (error) {
      return;
    }
    if (range === null) return;
    const shadowedSeqs = session.surface.nodes.slice(range.startIdx, range.endIdx + 1);
    const prefetch = { range: { start: range.start, end: range.end }, generation: session.surface.replaceGeneration, summarized: null, failure: null, wait: null };
    this.dscodePrefetch.set(session, prefetch);
    prefetch.wait = (async () => {
      try {
        const input = this.dscodeSummarizationInput(session, shadowedSeqs);
        prefetch.summarized = await this.summarize(input, agent, signal);
      } catch (error) {
        prefetch.failure = error;
      }
    })();
  }

  /**
   * Commit the pending prefetch when its span is still the same replacement
   * target, or return null so the caller summarizes afresh. The upstream
   * `compactRegion` owns the marker pair, the surface replacement and every
   * stability check; `summarize` then returns the summary already produced.
   * @param agent - agent whose pressure triggered the automatic compaction.
   * @param signal - live turn signal forwarded to the transaction.
   * @returns the committed compaction result, or null when no prefetch was usable.
   */
  async dscodeCommitPrefetch(agent, signal) {
    const session = agent.session;
    const prefetch = this.dscodePrefetch.get(session);
    if (prefetch === undefined) return null;
    this.dscodePrefetch.delete(session);
    if (prefetch.failure !== null) return null;
    if (session.surface.replaceGeneration !== prefetch.generation) return null;
    this.dscodePendingPrefetch.set(session, prefetch);
    try {
      return await this.compactRegion(prefetch.range.start, prefetch.range.end, agent, signal);
    } finally {
      this.dscodePendingPrefetch.delete(session);
    }
  }
}

export default DscodeCompactionEngine;
