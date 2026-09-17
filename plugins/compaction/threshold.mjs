import { cacheReadRatio } from '../session-metrics/pricing.mjs';
import { ensureOpenRouterModels } from '../openrouter/models.mjs';

// Auto-compaction threshold priced from the route's cache discount. Staying put
// re-reads the whole context at the cache-read price; compacting pays for a
// summary call and re-reads the kept tail at the full input price once. With a
// deep discount (r = cache read / input price) a long context is cheap to carry,
// so compaction waits; with no discount it pays off early.
export const DEFAULT_THRESHOLD_RATIO = 0.8;

/** Threshold ratio for a cache-read / input price ratio; unknown prices keep the upstream default. */
export function thresholdForCacheRatio(ratio) {
  if (!Number.isFinite(ratio) || ratio < 0) return DEFAULT_THRESHOLD_RATIO;
  // Prices are decimal fractions: 0.3 / 3 must land on the 0.1 boundary, not just below it.
  const rounded = Math.round(ratio * 1e9) / 1e9;
  return rounded < 0.1 ? 0.9 : rounded < 0.5 ? 0.8 : 0.6;
}

/**
 * How far below the priced threshold a background prefetch starts, as a share of
 * the context window: at the default 80% threshold the prefetch mark is 70%.
 */
export const PREFETCH_LEAD_RATIO = 0.1;

/** Token mark where a background prefetch starts; an unknown window leaves the threshold itself. */
export function prefetchThresholdTokens(thresholdTokens, contextWindow, leadRatio = PREFETCH_LEAD_RATIO) {
  if (!Number.isFinite(thresholdTokens) || !Number.isInteger(contextWindow) || contextWindow <= 0) return thresholdTokens;
  return Math.max(0, thresholdTokens - Math.floor(contextWindow * leadRatio));
}

/** The route's threshold ratio, waiting for the OpenRouter listing when it has not loaded yet. */
export async function pricedThresholdRatio(provider, model, now = Date.now()) {
  if (provider === 'openrouter') await ensureOpenRouterModels({ home: process.env.DSH_HOME, now });
  return thresholdForCacheRatio(cacheReadRatio(provider, model, now));
}

/**
 * A compaction-basic route policy with the priced threshold. A threshold the
 * deployment configured, globally or for this route, is left as it is.
 * @param config - resolved compaction-basic config; `dscodePricedThreshold` marks an unset top-level threshold.
 * @param policy - that route's merged policy.
 */
export async function pricedCompactionPolicy(config, policy, now = Date.now()) {
  const { provider, model } = policy.target;
  const override = config.modelPolicies?.find(entry => entry.provider === provider && entry.model === model);
  if (config.dscodePricedThreshold !== true || override?.thresholdRatio !== undefined) return policy;
  const thresholdRatio = await pricedThresholdRatio(provider, model, now);
  // The retained tail must stay below the threshold, so a configured tail that large keeps the configured policy.
  if (policy.retainRatio !== undefined && policy.retainRatio >= thresholdRatio) return policy;
  return { ...policy, thresholdRatio };
}

/** Whether the session's current context would compact on a route's next step, or undefined when either size is unknown. */
export function compactionPreview({ used, contextWindow, thresholdRatio, label = '' }) {
  if (!Number.isFinite(used) || used <= 0 || !Number.isInteger(contextWindow) || contextWindow <= 0) return undefined;
  const threshold = Math.floor(contextWindow * thresholdRatio);
  return { label, used, contextWindow, thresholdRatio, threshold, compacts: used >= threshold, overflows: used >= contextWindow };
}
