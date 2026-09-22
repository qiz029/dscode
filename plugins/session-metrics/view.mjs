import { readMetrics } from './store.mjs';
import { t } from '../i18n/messages.mjs';
import { estimateCost, peakEmoji } from './pricing.mjs';
import { balanceNow, trustedNow } from './balance.mjs';
import { grokSubscriptionNow } from '../grok/billing.mjs';
import { sessionAverageTps } from './rate.mjs';
import { attributeCostByTurn, evaluateBudget, parseBudget } from './turns.mjs';
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
    // An auxiliary call (memory, review, an aborted stream) can end without a usage chunk: that
    // call is unaccounted, not a cache miss, so it must not blank the whole session's ratio.
    if (!u) continue;
    if (!Number.isFinite(u.inputTokens) || !Number.isFinite(u.outputTokens)) { cacheUnknown = true; continue; }
    const total = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    // OpenRouter reports cache reads only when there are some: a missing count is zero, not unknown.
    input += total; hit += u.cacheReadTokens ?? 0;
  }
  // Per-turn attribution needs the ledger's own rows (the backfilled history has
  // no turn boundary), so it reads them directly instead of the merged map.
  const attribution = attributeCostByTurn(rows, events);
  return {
    cost, unknown, calls, pending,
    cache: input > 0 && !cacheUnknown ? Math.min(100, hit / input * 100) : null,
    turns: attribution.turns,
    lastTurn: attribution.lastTurn,
    unattributed: attribution.unattributed,
  };
}

/**
 * Per-turn cost for one live session, straight from its ledger, keyed by the
 * durable turn number. The /usage panel prices its turns with this: the token
 * meter says what each turn billed, this says what it cost.
 * @param id - the session id.
 * @param events - the session's durable events, for the turn windows.
 * @returns `{ turn, cost, calls, unknown }` per completed or running turn.
 */
export function turnCostsFor(id, events = []) {
  const entries = id && process.env.DSH_HOME ? readMetrics(process.env.DSH_HOME, id).rows : [];
  return attributeCostByTurn(entries, events).turns;
}
/**
 * Terminal columns of a string: East Asian wide characters (such as the cache label's
 * CJK glyphs) take two, and zero-width marks take none. The variation selectors matter
 * here: `❄️` is U+2744 plus U+FE0F, and counting that selector as a column made the
 * footer's provider budget swing with the DeepSeek pricing window.
 */
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u2600-\u27bf\u{1f300}-\u{1faff}]/u;
// eslint-disable-next-line no-misleading-character-class -- these are zero width by design
const ZERO_WIDTH = /[\u0300-\u036f\u200d\ufe00-\ufe0f]/;
export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += ZERO_WIDTH.test(char) ? 0 : WIDE.test(char) ? 2 : 1;
  return width;
}
/**
 * The money slot for the Grok subscription rail: a plan has credits and a reset time, not a
 * bill. The percentage is optional (the server omits it for a period without usage), and an
 * unread window shows the tier alone instead of a wrong number.
 */
export function grokFooterFact(subscription, locale = 'en', now = Date.now()) {
  const parts = [subscription?.tier ?? 'Grok'];
  const used = subscription?.usedPercent;
  if (Number.isFinite(used)) parts.push((Number.isInteger(used) ? String(used) : used.toFixed(1)) + '% ' + t(locale, 'footer.grokUsed'));
  const reset = resetStamp(subscription?.periodEnd, now);
  if (reset !== undefined) parts.push(t(locale, 'footer.grokResets') + ' ' + reset);
  return parts.join(' · ');
}

/** Local `MM-DD HH:MM` for a reset time, or undefined when the window is unknown or past. */
function resetStamp(iso, now) {
  const at = Date.parse(typeof iso === 'string' ? iso : '');
  if (!Number.isFinite(at) || at <= now) return undefined;
  const pad = value => String(value).padStart(2, '0');
  const date = new Date(at);
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/**
 * Fixed figure columns for the live footer. The status line re-reads these
 * figures every second, so a growing digit count must never move the segments
 * after it: each figure is right-aligned inside its own columns, and only the
 * terminal width decides which segments the drop ladder keeps.
 */
const FIGURE = {
  /** Request and session-average rates share the same fixed figure width. */
  rate: 6,
  /** `100%` context occupancy. */
  percent: 4,
  /** `100.0%` cache share. */
  share: 6,
};

/**
 * Columns {@link formatFooter} needs on top of the budget it is handed. The
 * fixed figures above only stop moving once their columns are really reserved,
 * so a caller that budgets the footer's width adds these columns first —
 * otherwise the padding evicts a figure the width would have seated. Six
 * measures the padding a live reading adds across the rate, context and cache
 * figures at the widths the drop ladder actually decides on.
 */
export const FOOTER_FIGURE_RESERVE = 6;

/** Right-align one figure inside its columns; a wider reading keeps its own width. */
function figure(text, width) {
  const padding = width - displayWidth(text);
  return padding > 0 ? ' '.repeat(padding) + text : text;
}

function footerFigures(metrics, context, rates, locale = 'en', provider = 'deepseek-official') {
  const label = key => t(locale, key);
  const ctx = figure(Number.isFinite(context) ? `${Math.round(context)}%` : '--', FIGURE.percent);
  const cache = figure(metrics.cache === null ? '--' : `${metrics.cache.toFixed(1)}%`, FIGURE.share);
  // The balance belongs to the provider serving the route; only DeepSeek's official one bills by a peak window.
  const balance = balanceNow(provider);
  const spend = metrics.unknown && metrics.cost === 0 ? '--' : `$${metrics.cost.toFixed(2)}${metrics.unknown ? '+' : ''}${metrics.pending ? '…' : ''}`;
  // The money is the one live figure whose digits are not reserved: they cross a
  // column a handful of times per session, and reserving them would evict a
  // per-second figure at the widths the footer actually runs at. A balance the
  // provider cannot report is left out instead of parked as `$--`.
  const dollars = provider === 'grok' ? grokFooterFact(grokSubscriptionNow(), locale)
    : spend + (balance === null ? '' : ' / $' + balance.toFixed(2)) + (provider === 'deepseek-official' ? ' ' + peakEmoji(trustedNow()) : '');
  // The budget slot rides the money figure: it answers "how much of the session's
  // limit is spent", which is a fact about the cost, not a second cost. A session
  // with no limit renders exactly as before, so the footer only grows by choice.
  const budget = metrics.budget;
  const budgeted = budget === undefined || budget.limit === null ? ''
    : `/${budget.limit.toFixed(2)}${budget.state === 'over' ? '⚠!' : budget.state === 'warn' ? '⚠' : ''}`;
  const money = dollars + budgeted;
  // The last completed turn is the one figure the whole-session total cannot
  // give: `$1.23 / $9.86 · #12 $0.04` reads "the session so far, of which the
  // last turn cost this". `+` marks a turn whose settled calls were not all
  // priceable, the same mark the total uses.
  const turn = metrics.lastTurn === undefined || !Number.isFinite(metrics.lastTurn.cost) ? ''
    : `#${metrics.lastTurn.turn} $${metrics.lastTurn.cost.toFixed(2)}${metrics.lastTurn.unknown ? '+' : ''}`;
  return {
    current: rates ? `${rates.active ? '◌' : ' '} ${figure(Number.isFinite(rates.current) ? rates.current.toFixed(1) : '--', FIGURE.rate)} tps` : '',
    average: rates ? `${figure(Number.isFinite(rates.average) ? rates.average.toFixed(1) : '--', FIGURE.rate)} tps ${label('footer.average')}` : '',
    context: `${ctx} ${label('footer.context')}`,
    money,
    cache: `${cache} ${label('footer.cache')}`,
    turn,
  };
}

/** Flat footer for text consumers; the TUI uses the same figures as separate groups. */
export function formatFooter(metrics, context, columns = 80, rates, locale = 'en', provider = 'deepseek-official') {
  const figures = footerFigures(metrics, context, rates, locale, provider);
  const { current, average, context: ctx, money, cache, turn } = figures;
  const base = rates ? [current, average, ctx, money, cache] : [ctx, money, cache];
  // The slot is reserved even when no turn has cost anything yet: the drop
  // ladder's indices are fixed against this array, and an unfilled slot renders
  // as '' (skipped by `render`) exactly like the absent figure would.
  base.splice(rates ? 3 : 1, 0, turn);
  // Narrow terminals shed the quietest figures first: the last turn, then
  // average, current and context, and only then the cache. The running cost is
  // the last thing standing, and its slot is index 4 (or 2 without rates) now
  // that the turn slot holds index 3 (or 1) open.
  const drops = rates ? [3, 1, 0, 2, 5, 4] : [1, 0, 3, 2];
  const render = omit => base.filter((part, index) => part !== '' && !omit.has(index)).join(' · ');
  for (let dropped = 0; dropped <= drops.length; dropped++) {
    const value = render(new Set(drops.slice(0, dropped)));
    if (displayWidth(value) <= columns) return value;
  }
  const floor = render(new Set(drops));
  let clipped = '';
  for (const char of floor) { if (displayWidth(clipped + char) > columns) break; clipped += char; }
  return clipped;
}
/**
 * The session's recorded spend and whether any of it is unpriceable, for a host
 * that must decide something (the budget gate) rather than only render it. Same
 * ledger and same rules as {@link footerFor}, so the figure the gate compares
 * and the figure the footer shows can never disagree.
 */
export function sessionSpend(id) {
  try {
    const ledger = id && process.env.DSH_HOME ? readMetrics(process.env.DSH_HOME, id) : { rows: [], corrupt: false };
    const data = id ? source?.(id) : undefined;
    const summary = summarize(ledger.rows, data?.events ?? [], ledger.corrupt);
    return { cost: summary.cost, unknown: summary.unknown, pending: summary.pending };
  } catch { return { cost: 0, unknown: true, pending: 0 }; }
}

/** Per-events memo: the status line renders up to once a second, and summarize/average are O(events). */
const footerCache = new WeakMap();
export function footerFor(id, stats, columns, provider = 'deepseek-official', locale = 'en', format = formatFooter) {
  const limit = parseBudget(process.env.DSCODE_SESSION_BUDGET_USD);
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
    // The budget comes from the environment for this process only: it is a
    // per-machine spending guard, not a session property worth persisting.
    const budget = limit === null ? undefined : evaluateBudget(summary.cost, limit);
    return format({ ...summary, ...(budget === undefined ? {} : { budget }) }, Number.isFinite(used) && capacity > 0 ? used / capacity * 100 : undefined, columns, { current: data?.currentTps, average, active: data?.requestActive }, locale, provider);
  } catch { return format({ cost: 0, unknown: true, cache: null }, undefined, columns, { current: null, average: null }, locale, provider); }
}

/** Structured figures preserve money/cache as one right-aligned group in the TUI. */
export function footerFiguresFor(id, stats, provider = 'deepseek-official', locale = 'en') {
  return footerFor(id, stats, 0, provider, locale,
    (metrics, context, _columns, rates, language, route) => footerFigures(metrics, context, rates, language, route));
}
