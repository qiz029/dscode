// USD per million tokens. Snapshot of the official page opened 2026-09-11.
// https://api-docs.deepseek.com/quick_start/pricing/
export const PRICE_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/';
export const PRICE_VERSION = 'deepseek-2026-09-11';
export function estimateCost(provider, model, usage, time) {
  if (provider !== 'deepseek-official' || !usage || !Number.isFinite(time)) return null;
  // Earlier requests require an older price table; never back-price them at today's rate.
  if (time < Date.UTC(2026, 8, 11)) return null;
  const flash = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)
    || model === 'deepseek-v4-pro' && time >= Date.UTC(2026, 8, 14, 4);
  if (!flash && model !== 'deepseek-v4-pro') return null;
  const peak = isPeak(time);
  const [read, input, output] = flash ? [0.003, 0.15, 0.6] : [0.022, 0.66, 1.98];
  const values = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0];
  if (!values.every(n => Number.isFinite(n) && n >= 0) || values[3] !== 0) return null;
  return (values[0] * input + values[1] * output + values[2] * read) * (peak ? 2 : 1) / 1e6;
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
