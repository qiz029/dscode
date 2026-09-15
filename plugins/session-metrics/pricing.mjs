import { openRouterPriceVersion, openRouterRates } from '../openrouter/models.mjs';

// USD per million tokens. Snapshot of the official page opened 2026-09-11.
// https://api-docs.deepseek.com/quick_start/pricing/
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
export const PRICE_VERSION = 'deepseek-2026-09-11';
// OpenRouter calls carry their billed cost; an unbilled one is estimated from the live model listing (plugins/openrouter/models.mjs).
// Until that table loads, the DeepSeek models keep these list prices from the pinned
// pi-ai 0.85.1 catalog. OpenRouter bills no peak window. [cache read, input, output].
export const OPENROUTER_PRICE_VERSION = 'openrouter-pi-ai-0.85.1';
const OPENROUTER_PRICES = {
  'deepseek/deepseek-v4-flash': [0.017052, 0.08526, 0.17052],
  'deepseek/deepseek-v4-pro': [0.074196, 0.890358, 1.780716],
  'deepseek/deepseek-v4-flash-vision-exp': [0.007, 0.22, 0.66],
};

/** The price table a ledger entry for this route is estimated with. */
export function priceVersionFor(provider, model) {
  if (provider !== 'openrouter') return PRICE_VERSION;
  return model !== undefined && openRouterRates(model) !== undefined ? openRouterPriceVersion() : OPENROUTER_PRICE_VERSION;
}

const promptTokens = usage => (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);

export function estimateCost(provider, model, usage, time) {
  if (!usage || !Number.isFinite(time)) return null;
  if (provider === 'openrouter') {
    // A model that lists no cache-read or cache-write price bills that input at the input rate.
    const live = openRouterRates(model, promptTokens(usage));
    if (live) return charge(usage, [live.cacheRead ?? live.input, live.input, live.output], live.cacheWrite ?? live.input);
    return OPENROUTER_PRICES[model] ? charge(usage, OPENROUTER_PRICES[model]) : null;
  }
  if (provider !== 'deepseek-official') return null;
  const rates = deepSeekRates(model, time);
  if (!rates) return null;
  const cost = charge(usage, rates);
  return cost === null ? null : cost * (isPeak(time) ? 2 : 1);
}

/** DeepSeek list prices [cache read, input, output] at `time`, before the peak multiplier. */
function deepSeekRates(model, time) {
  // Earlier requests require an older price table; never back-price them at today's rate.
  if (time < Date.UTC(2026, 8, 11)) return undefined;
  const flash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)
    || model === 'deepseek-v4-pro' && time >= Date.UTC(2026, 8, 14, 4);
  if (!flash && model !== 'deepseek-v4-pro') return undefined;
  return flash ? [0.003, 0.15, 0.6] : [0.022, 0.66, 1.98];
}

/**
 * Cache-read price over input price for a route, or undefined when the route is unpriced.
 * A model that lists no cache-read price bills cached input at the input rate (1).
 */
export function cacheReadRatio(provider, model, time = Date.now()) {
  let rates;
  if (provider === 'openrouter') {
    const live = openRouterRates(model);
    rates = live ? [live.cacheRead ?? live.input, live.input] : OPENROUTER_PRICES[model];
  } else if (provider === 'deepseek-official') rates = deepSeekRates(model, time);
  return rates && rates[1] > 0 ? rates[0] / rates[1] : undefined;
}

/** Cost in USD; cache writes need a write price, or the call stays unpriced. */
function charge(usage, [read, input, output], write) {
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (!values.every(n => Number.isFinite(n) && n >= 0) || values[3] !== 0 && !Number.isFinite(write)) return null;
  return (values[0] * input + values[1] * output + values[2] * read + values[3] * (write ?? 0)) / 1e6;
}

/**
 * Peak/off-peak window in UTC: weekdays 01:00-04:00 and 06:00-10:00.
 * @param time - Unix ms timestamp.
 * @returns Whether that instant bills at the peak rate.
 */
export function isPeak(time) {
  const date = new Date(time), day = date.getUTCDay(), hour = date.getUTCHours();
  return day >= 1 && day <= 5 && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
}

/** Footer marker for the billing window: fire for peak, snowflake for off-peak. */
export function peakEmoji(time) {
  return isPeak(time) ? '🔥' : '❄️';
}
