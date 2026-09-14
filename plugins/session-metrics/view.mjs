import { readMetrics } from './store.mjs';
import { t } from '../i18n/messages.mjs';
import { estimateCost } from './pricing.mjs';
import { sessionAverageTps } from './rate.mjs';
let source;
export function setMetricSource(next) { source = next; return () => { if (source === next) source = undefined; }; }
export function summarize(rows, events = [], corrupt = false) {
  const requests = new Map();
  let first = Infinity;
  for (const row of rows) {
    if (row.kind === 'start') first = Math.min(first, row.time);
    requests.set(row.id, { ...requests.get(row.id), ...row });
  }
  // Backfill old main/compaction calls from the durable log, only before the new ledger.
  let route = {};
  const history = [];
  for (const event of events) {
    if (event.type === 'request/header') route = event.data.header.config;
    if (event.time >= first) continue;
    if (event.type === 'assistant/message' || event.type === 'compaction/summary' && event.data.llmStreamCall) {
      const r = event.type === 'compaction/summary' ? event.data : route;
      history.push({ usage: event.data.usage, cost: estimateCost(r.provider, r.model, event.data.usage, event.time), kind: 'end' });
    } else if (event.type === 'assistant/attempt') history.push({ kind: 'end', cost: null });
  }
  let cost = 0, unknown = corrupt || history.length > 0, input = 0, hit = 0, cacheUnknown = false, calls = 0, pending = 0;
  // Historical overhead (review/title) was not recorded by this collector: mark partial.
  for (const row of [...history, ...requests.values()]) {
    calls++;
    if (row.kind !== 'end') { pending++; continue; }
    if (!Number.isFinite(row.cost)) unknown = true;
    else cost += row.cost;
    const u = row.usage;
    if (!u || !Number.isFinite(u.inputTokens) || !Number.isFinite(u.outputTokens)) { cacheUnknown = true; continue; }
    const total = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    input += total; hit += u.cacheReadTokens ?? 0;
    if (total > 0 && u.cacheReadTokens === undefined) cacheUnknown = true;
  }
  return { cost, unknown, calls, pending, cache: input > 0 && !cacheUnknown ? Math.min(100, hit / input * 100) : null };
}
/** Terminal columns of a string: East Asian wide characters (including the ｜ separator) take two. */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(char) ? 2 : 1;
  return width;
}
export function formatFooter(metrics, context, columns = 80, rates, locale = 'en') {
  const label = key => t(locale, key);
  const ctx = Number.isFinite(context) ? `${Math.round(context)}%` : '--';
  const cache = metrics.cache === null ? '--' : `${metrics.cache.toFixed(1)}%`;
  const dollars = metrics.unknown && metrics.cost === 0 ? '--' : `~$${metrics.cost.toFixed(metrics.cost < 1 ? 4 : 2)}${metrics.unknown ? '+' : ''}${metrics.pending ? '…' : ''}`;
  const parts = rates ? [
    `${label('footer.current')}: ${Number.isFinite(rates.current) ? '~' + rates.current.toFixed(1) : '--'} tps`,
    `${label('footer.average')}: ${Number.isFinite(rates.average) ? rates.average.toFixed(1) : '--'} tps`,
    `${label('footer.context')}: ${ctx}`, dollars, `${label('footer.cache')} ${cache}`,
  ] : [`${label('footer.context')}: ${ctx}`, dollars, `${label('footer.cache')} ${cache}`];
  for (let count = parts.length; count > 0; count--) {
    const value = parts.slice(0, count).join(' ｜ ');
    if (displayWidth(value) <= columns) return value;
  }
  let clipped = '';
  for (const char of parts[0]) { if (displayWidth(clipped + char) > columns) break; clipped += char; }
  return clipped;
}
export function footerFor(id, stats, columns, locale = 'en') {
  try {
    const data = id ? source?.(id) : undefined;
    const ledger = id && process.env.DSH_HOME ? readMetrics(process.env.DSH_HOME, id) : { rows: [], corrupt: false };
    const summary = summarize(ledger.rows, data?.events ?? [], ledger.corrupt);
    const used = data?.used;
    const capacity = data?.capacity ?? stats.contextWindow;
    const average = sessionAverageTps(data?.events ?? []);
    return formatFooter(summary, Number.isFinite(used) && capacity > 0 ? used / capacity * 100 : undefined, columns, { current: data?.currentTps, average }, locale);
  } catch { return formatFooter({ cost: 0, unknown: true, cache: null }, undefined, columns, { current: null, average: null }, locale); }
}
