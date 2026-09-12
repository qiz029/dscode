import { readMetrics } from './store.mjs';
import { estimateCost } from './pricing.mjs';
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
export function formatFooter(metrics, context, columns = 80) {
  const ctx = Number.isFinite(context) ? `${Math.round(context)}%` : '--';
  const cache = metrics.cache === null ? '--' : `${metrics.cache.toFixed(1)}%`;
  const dollars = metrics.unknown && metrics.cost === 0 ? '--' : `~$${metrics.cost.toFixed(metrics.cost < 1 ? 4 : 2)}${metrics.unknown ? '+' : ''}${metrics.pending ? '…' : ''}`;
  const full = `ctx ${ctx} · ${dollars} · cache ${cache}`;
  if (full.length <= columns) return full;
  const short = `ctx ${ctx} · ${dollars}`;
  if (short.length <= columns) return short;
  const tiny = `ctx ${ctx}`;
  return tiny.length <= columns ? tiny : tiny.slice(0, Math.max(0, columns));
}
export function footerFor(id, stats, columns) {
  try {
    const data = id ? source?.(id) : undefined;
    const ledger = id && process.env.DSH_HOME ? readMetrics(process.env.DSH_HOME, id) : { rows: [], corrupt: false };
    const summary = summarize(ledger.rows, data?.events ?? [], ledger.corrupt);
    const used = data?.used;
    const capacity = data?.capacity ?? stats.contextWindow;
    return formatFooter(summary, Number.isFinite(used) && capacity > 0 ? used / capacity * 100 : undefined, columns);
  } catch { return formatFooter({ cost: 0, unknown: true, cache: null }, undefined, columns); }
}
