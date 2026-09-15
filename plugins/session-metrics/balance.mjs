import { OPENROUTER_API, parseOpenRouterCredits, parseOpenRouterKeyRemaining } from '../providers/openrouter-account.mjs';

export { parseOpenRouterCredits, parseOpenRouterKeyRemaining };

// Remaining provider balance, refreshed on a long cache. DeepSeek's response
// also carries the trusted clock: its `Date` header anchors peak/off-peak pricing
// without a second network call. OpenRouter has no peak window. Its account
// credits (`/credits`) are documented as management-only but are served to
// inference keys too; a key refused them falls back to its own remaining limit (`/key`).
const SOURCES = {
  'deepseek-official': { env: 'DEEPSEEK_API_KEY', clock: true, requests: ({ key }) => [{ url: 'https://api.deepseek.com/user/balance', key, parse: body => parseBalance(body) }] },
  openrouter: { env: 'OPENROUTER_API_KEY', managementEnv: 'OPENROUTER_MANAGEMENT_KEY', clock: false, requests: ({ key, managementKey }) => [
    { url: `${OPENROUTER_API}/credits`, key: managementKey ?? key, parse: parseOpenRouterCredits },
    { url: `${OPENROUTER_API}/key`, key, parse: parseOpenRouterKeyRemaining },
  ] },
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
  const key = options.key ?? process.env[source.env];
  const managementKey = options.managementKey ?? (source.managementEnv ? process.env[source.managementEnv] : undefined);
  const requests = source.requests({ key, managementKey }).filter(request => request.key);
  const mode = managementKey ? 'management' : 'key';
  const now = Date.now();
  // A newly added (or removed) management key changes the source; it is read at once.
  if (snapshot.pending || snapshot.mode === mode && now - snapshot.fetchedAt < CACHE_MS) return snapshot.balance;
  const retrySoon = () => Date.now() - (CACHE_MS - RETRY_MS);
  if (requests.length === 0) { snapshots.set(provider, { ...snapshot, mode, fetchedAt: retrySoon(), pending: false }); return snapshot.balance; }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return snapshot.balance;
  snapshots.set(provider, { ...snapshot, pending: true });
  try {
    let response, body, request;
    for (request of requests) {
      response = await fetchImpl(request.url, { headers: { Authorization: `Bearer ${request.key}`, Accept: 'application/json' } });
      body = await response.json();
      // A key refused this reading falls through to the next source.
      if (response.ok || (response.status !== 401 && response.status !== 403)) break;
    }
    const header = source.clock ? response.headers?.get?.('date') : null;
    const anchor = header ? Date.parse(header) : NaN;
    const parsed = response.ok ? request.parse(body) : null;
    if (Number.isFinite(anchor)) clock = { anchor, skewMs: anchor - Date.now() };
    snapshots.set(provider, {
      mode,
      balance: parsed === null && response.ok ? null : parsed ?? snapshot.balance,
      fetchedAt: parsed === null ? retrySoon() : Date.now(),
      pending: false,
    });
  } catch {
    // A transient failure keeps the last known balance and retries sooner.
    snapshots.set(provider, { ...snapshot, mode, fetchedAt: retrySoon(), pending: false });
  }
  return snapshotOf(provider).balance;
}
