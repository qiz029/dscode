// Remaining DeepSeek balance, refreshed on a long cache, plus the trusted clock
// that comes with it: the same request's `Date` header anchors peak/off-peak
// pricing without a second network call.
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
let snapshot = { balance: null, fetchedAt: 0, clock: null, skewMs: 0, pending: false };

/** Best-effort positive USD balance from a `/user/balance` body. */
export function parseBalance(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const usd = infos.find(info => String(info?.currency ?? '').toUpperCase() === 'USD') ?? infos[0];
  const total = Number(usd?.total_balance);
  if (!Number.isFinite(total) || total < 0) return null;
  return body?.is_available === false ? null : total;
}

export function balanceNow() { return snapshot.balance; }
/** Clock anchored to the last balance response's `Date` header, else the local one. */
export function trustedNow() {
  const local = Date.now();
  return snapshot.clock === null ? local : local + snapshot.skewMs;
}

/** Refresh at most once per cache window; never throws into the render path. */
export async function refreshBalance(options = {}) {
  const now = Date.now();
  if (snapshot.pending || now - snapshot.fetchedAt < CACHE_MS) return snapshot.balance;
  const key = options.key ?? process.env.DEEPSEEK_API_KEY;
  if (!key) { snapshot = { ...snapshot, fetchedAt: now - (CACHE_MS - RETRY_MS), pending: false }; return snapshot.balance; }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return snapshot.balance;
  snapshot.pending = true;
  try {
    const response = await fetchImpl(BALANCE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    const header = response.headers?.get?.('date');
    const anchor = header ? Date.parse(header) : NaN;
    const body = await response.json();
    const parsed = response.ok ? parseBalance(body) : null;
    snapshot = {
      balance: parsed === null && response.ok ? null : parsed ?? snapshot.balance,
      fetchedAt: parsed === null ? Date.now() - (CACHE_MS - RETRY_MS) : Date.now(),
      clock: Number.isFinite(anchor) ? anchor : snapshot.clock,
      skewMs: Number.isFinite(anchor) ? anchor - Date.now() : snapshot.skewMs,
      pending: false,
    };
  } catch {
    // A transient failure keeps the last known balance and retries sooner.
    snapshot = { ...snapshot, fetchedAt: Date.now() - (CACHE_MS - RETRY_MS), pending: false };
  }
  return snapshot.balance;
}
