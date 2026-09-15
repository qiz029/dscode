import { readMetrics } from './store.mjs';
import { t } from '../i18n/messages.mjs';
import { estimateCost, peakEmoji } from './pricing.mjs';
import { balanceNow, trustedNow } from './balance.mjs';
import { sessionAverageTps } from './rate.mjs';
import { providerOfHeader } from '../providers/catalog.mjs';
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
    // Ledger rows cover everything from the first row's time on, so only older events are
    // backfilled. `continue`, not `break`: the loop must not depend on event ordering.
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
    // OpenRouter reports cache reads only when there are some: a missing count is zero, not unknown.
    input += total; hit += u.cacheReadTokens ?? 0;
  }
  return { cost, unknown, calls, pending, cache: input > 0 && !cacheUnknown ? Math.min(100, hit / input * 100) : null };
}
/** Terminal columns of a string: East Asian wide characters (such as the cache label's CJK glyphs) take two. */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u2600-\u27bf\u{1f300}-\u{1faff}]/u.test(char) ? 2 : 1;
  return width;
}
export function formatFooter(metrics, context, columns = 80, rates, locale = 'en', header = '', provider = providerOfHeader(header) ?? 'deepseek-official') {
  const label = key => t(locale, key);
  const ctx = Number.isFinite(context) ? `${Math.round(context)}%` : '--';
  const cache = metrics.cache === null ? '--' : `${metrics.cache.toFixed(1)}%`;
  // The balance belongs to the provider the header names; only DeepSeek's official route bills by a peak window.
  const balance = balanceNow(provider);
  const spend = metrics.unknown && metrics.cost === 0 ? '--' : `$${metrics.cost.toFixed(2)}${metrics.unknown ? '+' : ''}${metrics.pending ? '…' : ''}`;
  const dollars = `${spend} / ${balance === null ? '$--' : '$' + balance.toFixed(2)}${provider === 'deepseek-official' ? ' ' + peakEmoji(trustedNow()) : ''}`;
  const base = rates ? [
    `${label('footer.current')}: ${Number.isFinite(rates.current) ? '~' + rates.current.toFixed(1) : '--'} tps`,
    `${label('footer.average')}: ${Number.isFinite(rates.average) ? rates.average.toFixed(1) : '--'} tps`,
    `${label('footer.context')}: ${ctx}`, dollars, `${label('footer.cache')}: ${cache}`,
  ] : [`${label('footer.context')}: ${ctx}`, dollars, `${label('footer.cache')}: ${cache}`];
  // Narrow terminals shed the quietest figures first: average, cache hit, current. The
  // model header then falls back to its bare `model @ effort` form, then context goes,
  // and only then the header itself — the running cost is the last thing standing.
  const drops = rates ? [1, 4, 0, 2] : [2, 0];
  const offset = header === '' ? 0 : 1;
  const parts = header === '' ? base : [header, ...base];
  const short = header.replace(/^[^:]+: /, '');
  const heads = header === '' ? [''] : short === header ? [header] : [header, short];
  const render = ({ omit, head }) => parts
    .map((part, index) => (index === 0 && header !== '' ? head : part))
    .filter((part, index) => part !== '' && !omit.has(index))
    .join(' | ');
  for (let dropped = 0; dropped <= drops.length; dropped++) {
    const omit = new Set(drops.slice(0, dropped).map(index => index + offset));
    for (const head of heads) {
      const value = render({ omit, head });
      if (displayWidth(value) <= columns) return value;
    }
  }
  const floor = render({ omit: new Set(drops.map(index => index + offset)), head: '' });
  let clipped = '';
  for (const char of floor) { if (displayWidth(clipped + char) > columns) break; clipped += char; }
  return clipped;
}
/** Per-events memo: the status line renders up to once a second, and summarize/average are O(events). */
const footerCache = new WeakMap();
export function footerFor(id, stats, columns, header = '', locale = 'en') {
  try {
    const data = id ? source?.(id) : undefined;
    const ledger = id && process.env.DSH_HOME ? readMetrics(process.env.DSH_HOME, id) : { rows: [], corrupt: false };
    const events = data?.events ?? [];
    // Identity alone is not enough: a session event list may be appended to in place.
    const hit = events.length > 0 ? footerCache.get(events) : undefined;
    const tail = events.at(-1)?.time;
    const fresh = hit !== undefined && hit.key === ledger.rows && hit.length === events.length && hit.tail === tail;
    const summary = fresh ? hit.summary : summarize(ledger.rows, events, ledger.corrupt);
    const used = data?.used;
    const capacity = data?.capacity ?? stats.contextWindow;
    const average = fresh ? hit.average : sessionAverageTps(events);
    if (events.length > 0 && !fresh) footerCache.set(events, { key: ledger.rows, length: events.length, tail, summary, average });
    return formatFooter(summary, Number.isFinite(used) && capacity > 0 ? used / capacity * 100 : undefined, columns, { current: data?.currentTps, average }, locale, header);
  } catch { return formatFooter({ cost: 0, unknown: true, cache: null }, undefined, columns, { current: null, average: null }, locale, header); }
}
