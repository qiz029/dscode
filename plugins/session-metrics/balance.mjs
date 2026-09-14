// Remaining provider balance, refreshed on a long cache. DeepSeek's response
// also carries the trusted clock: its `Date` header anchors peak/off-peak pricing
// without a second network call. OpenRouter has no peak window, so only its
// remaining credits are read.
const SOURCES = {
  'deepseek-official': { url: 'https://api.deepseek.com/user/balance', env: 'DEEPSEEK_API_KEY', parse: body => parseBalance(body), clock: true },
  openrouter: { url: 'https://openrouter.ai/api/v1/credits', env: 'OPENROUTER_API_KEY', parse: body => parseOpenRouterCredits(body), clock: false },
};
export const BALANCE_PROVIDERS = Object.freeze(Object.keys(SOURCES));
const CACHE_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const snapshots = new Map();
let clock = { anchor: null, skewMs: 0 };
const snapshotOf = provider => snapshots.get(provider) ?? { balance: null, fetchedAt: 0, pending: false };

/** Best-effort positive USD balance from a `/user/balance` body. */
export function parseBalance(body) {
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const usd = infos.find(info => String(info?.currency ?? '').toUpperCase() === 'USD') ?? infos[0];
  const total = Number(usd?.total_balance);
  if (!Number.isFinite(total) || total < 0) return null;
  return body?.is_available === false ? null : total;
}

/** Remaining USD credits from an OpenRouter `/credits` body: purchased minus used. */
export function parseOpenRouterCredits(body) {
  const credits = Number(body?.data?.total_credits), used = Number(body?.data?.total_usage);
  if (body?.data?.total_credits == null || body?.data?.total_usage == null) return null;
  if (!Number.isFinite(credits) || !Number.isFinite(used) || credits < 0 || used < 0) return null;
  return Math.max(0, credits - used);
}

export function balanceNow(provider = 'deepseek-official') { return snapshotOf(provider).balance; }
/** Clock anchored to the last DeepSeek balance response's `Date` header, else the local one. */
export function trustedNow() {
  const local = Date.now();
  return clock.anchor === null ? local : local + clock.skewMs;
}

/** Refresh one provider at most once per cache window; never throws into the render path. */
export async function refreshBalance(options = {}) {
  const provider = options.provider ?? 'deepseek-official';
  const source = SOURCES[provider];
  if (!source) return null;
  const snapshot = snapshotOf(provider);
  const now = Date.now();
  if (snapshot.pending || now - snapshot.fetchedAt < CACHE_MS) return snapshot.balance;
  const retrySoon = () => Date.now() - (CACHE_MS - RETRY_MS);
  const key = options.key ?? process.env[source.env];
  if (!key) { snapshots.set(provider, { ...snapshot, fetchedAt: retrySoon(), pending: false }); return snapshot.balance; }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return snapshot.balance;
  snapshots.set(provider, { ...snapshot, pending: true });
  try {
    const response = await fetchImpl(source.url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    const header = source.clock ? response.headers?.get?.('date') : null;
    const anchor = header ? Date.parse(header) : NaN;
    const body = await response.json();
    const parsed = response.ok ? source.parse(body) : null;
    if (Number.isFinite(anchor)) clock = { anchor, skewMs: anchor - Date.now() };
    snapshots.set(provider, {
      balance: parsed === null && response.ok ? null : parsed ?? snapshot.balance,
      fetchedAt: parsed === null ? retrySoon() : Date.now(),
      pending: false,
    });
  } catch {
    // A transient failure keeps the last known balance and retries sooner.
    snapshots.set(provider, { ...snapshot, fetchedAt: retrySoon(), pending: false });
  }
  return snapshotOf(provider).balance;
}
