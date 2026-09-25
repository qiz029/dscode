import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What the OpenCode Go subscription has used. Go caps usage per rolling five hours, per week
// and per month; the account's inference service answers all three at `<root>/go/v1/usage`
// (the console's own proxy maps the public `/zen/go/v1/usage` there), with the account token
// and `x-opencode-org-id` — without the org header it answers 403. Each window carries a used
// percentage, `ok` or `rate-limited`, and when it resets.
//
// The endpoint is the console's own, not documented: every field is optional, and a shape
// change degrades to "usage unavailable", never to a wrong number. The status line runs in
// the terminal process, so the snapshot is also kept in DSH_HOME, as the Grok window is.

/** OpenCode's own clients poll no faster; one read a minute is plenty for a five-hour window. */
export const GO_USAGE_TTL_MS = 60_000;
export const WINDOWS = Object.freeze(['rolling', 'weekly', 'monthly']);
const FILE = 'opencode-go-usage.json';
const VERSION = 1;
let state;
let fetchedAt = 0;
let pending;
let disk;

/** The usage URL beside an account's chat endpoint (`…/go/openai/v1` → `…/go/v1/usage`), or undefined. */
export function usageURL(api) {
  if (typeof api !== 'string' || !URL.canParse(api)) return undefined;
  const url = new URL(api);
  const path = url.pathname.replace(/\/+$/, '');
  if (!/\/openai\/v1$/.test(path)) return undefined;
  url.pathname = path.replace(/\/openai\/v1$/, '/v1/usage');
  return url.href;
}

/** The three windows from one usage body, each with `percent`, `limited` and `resetsAt` when present. */
export function parseGoUsage(body) {
  const usage = {};
  for (const name of WINDOWS) {
    const window = body?.usage?.[name];
    if (window === null || typeof window !== 'object') continue;
    const percent = Number(window.percent);
    const resetsAt = typeof window.resetsAt === 'string' && Number.isFinite(Date.parse(window.resetsAt)) ? window.resetsAt : undefined;
    usage[name] = {
      ...(Number.isFinite(percent) ? { percent: Math.min(100, Math.max(0, percent)) } : {}),
      ...(window.status === 'rate-limited' ? { limited: true } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    };
  }
  return usage;
}

/** One read with request auth from the grant session; undefined when it cannot be read. */
export async function fetchGoUsage(auth, { fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const url = usageURL(auth?.baseURL);
  if (url === undefined || typeof fetchImpl !== 'function') return undefined;
  try {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${auth.apiKey}`, accept: 'application/json', ...auth.headers } });
    if (!response.ok) return undefined;
    const usage = parseGoUsage(await response.json());
    return Object.keys(usage).length === 0 ? undefined : { ...usage, fetchedAt: now };
  } catch {
    return undefined;
  }
}

/** Refresh at most once per interval, one read in flight; the last good snapshot survives a failed read. */
export async function currentGoUsage({ home, resolveAuth, fetch, now = Date.now() } = {}) {
  if (state !== undefined && now - fetchedAt < GO_USAGE_TTL_MS) return state;
  if (pending) return pending;
  pending = (async () => {
    const auth = await Promise.resolve(resolveAuth?.()).catch(() => undefined);
    if (auth === undefined) return state;
    const next = await fetchGoUsage(auth, { ...(fetch ? { fetch } : {}), now });
    if (next !== undefined) {
      state = next;
      fetchedAt = now;
      if (home !== undefined) writeGoUsage(home, next);
    }
    return state;
  })().finally(() => { pending = undefined; });
  return pending;
}

/** The snapshot the status line renders: this process's own, else the file another process wrote. */
export function goUsageNow(home = process.env.DSH_HOME, now = Date.now()) {
  if (state !== undefined) return state;
  if (home === undefined) return undefined;
  if (disk !== undefined && disk.home === home && now - disk.at < GO_USAGE_TTL_MS) return disk.value;
  let value;
  try {
    const cached = JSON.parse(readFileSync(join(home, FILE), 'utf8'));
    if (cached?.version === VERSION) value = cached;
  } catch { /* no snapshot yet */ }
  disk = { home, at: now, value };
  return value;
}

/** Atomic write of one snapshot; a failure leaves the previous file alone. */
export function writeGoUsage(home, snapshot) {
  try {
    mkdirSync(home, { recursive: true });
    const path = join(home, FILE);
    writeFileSync(`${path}.tmp`, JSON.stringify({ version: VERSION, ...snapshot }));
    renameSync(`${path}.tmp`, path);
  } catch { /* the status line keeps its previous state */ }
}

/** Forget the snapshot, here and on disk: after signing out the status line shows no usage. */
export function clearGoUsage(home) {
  setGoUsage(undefined, 0);
  if (home !== undefined) rmSync(join(home, FILE), { force: true });
}

/** Replace the in-memory snapshot; for tests. */
export function setGoUsage(next, at = Date.now()) {
  state = next;
  fetchedAt = at;
  pending = undefined;
  disk = undefined;
}
