// USD per million tokens. Snapshot of the official page opened 2026-09-11.
// https://api-docs.deepseek.com/quick_start/pricing/
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
export const PRICE_VERSION = 'deepseek-2026-09-11';
// OpenRouter list prices for the DeepSeek models `/provider openrouter` declares,
// from the pinned pi-ai 0.85.1 catalog (its OpenRouter /models snapshot).
// OpenRouter bills no peak window. [cache read, input, output].
export const OPENROUTER_PRICE_VERSION = 'openrouter-pi-ai-0.85.1';
const OPENROUTER_PRICES = {
  'deepseek/deepseek-v4-flash': [0.017052, 0.08526, 0.17052],
  'deepseek/deepseek-v4-pro': [0.074196, 0.890358, 1.780716],
  'deepseek/deepseek-v4-flash-vision-exp': [0.007, 0.22, 0.66],
};

/** The price table a provider's ledger entries are estimated with. */
export function priceVersionFor(provider) {
  return provider === 'openrouter' ? OPENROUTER_PRICE_VERSION : PRICE_VERSION;
}

export function estimateCost(provider, model, usage, time) {
  if (!usage || !Number.isFinite(time)) return null;
  if (provider === 'openrouter') return OPENROUTER_PRICES[model] ? charge(usage, OPENROUTER_PRICES[model]) : null;
  if (provider !== 'deepseek-official') return null;
  // Earlier requests require an older price table; never back-price them at today's rate.
  if (time < Date.UTC(2026, 8, 11)) return null;
  const flash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)
    || model === 'deepseek-v4-pro' && time >= Date.UTC(2026, 8, 14, 4);
  if (!flash && model !== 'deepseek-v4-pro') return null;
  const cost = charge(usage, flash ? [0.003, 0.15, 0.6] : [0.022, 0.66, 1.98]);
  return cost === null ? null : cost * (isPeak(time) ? 2 : 1);
}

function charge(usage, [read, input, output]) {
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (!values.every(n => Number.isFinite(n) && n >= 0) || values[3] !== 0) return null;
  return (values[0] * input + values[1] * output + values[2] * read) / 1e6;
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
