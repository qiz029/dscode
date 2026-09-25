import { LlmError } from '@deepseek-ai/dsh-llm';

// Signing in to OpenCode Go with an OpenCode console account instead of a pasted API key.
//
// The console speaks the OAuth device flow (RFC 8628) to the public client `opencode-cli`,
// which is OpenCode's own CLI; DSCODE borrows that client id, so the consent page names the
// OpenCode CLI. The access token does not work on the public `zen/go/v1` endpoint: the
// console's `/api/config` names the account's own inference endpoint for `opencode-go`,
// which takes the token as a bearer plus `x-opencode-org-id` (probed 2026-09).
//
// Refresh tokens rotate: every refresh returns a new one and voids the old. DSCODE therefore
// keeps its own grant, separate from any OpenCode CLI login, and re-reads the store before
// giving up on a refused refresh, because another DSCODE process may have rotated it first.

export const CONSOLE_URL = 'https://opencode.ai/console';
export const CLIENT_ID = 'opencode-cli';
/** Credential reference holding the grant, as JSON, in the shared store. */
export const GRANT_REF = 'OPENCODE_OAUTH';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** Refresh once the access token has less than this left. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const GRANT_VERSION = 1;

async function request(fetchImpl, url, { method = 'GET', body, token, orgID, signal } = {}) {
  const response = await fetchImpl(url, {
    method, signal, redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      ...(orgID !== undefined ? { 'x-org-id': orgID } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, ok: response.ok, json, text };
}

const describe = result => result.json?.error_description ?? result.json?.error ?? `HTTP ${result.status}`;

/**
 * Start a device login.
 * @returns `{ deviceCode, userCode, url, intervalMs, expiresAt }`; `url` already carries the user code.
 */
export async function startDeviceLogin({ fetch: fetchImpl = globalThis.fetch, server = CONSOLE_URL, now = Date.now() } = {}) {
  const result = await request(fetchImpl, `${server}/auth/device/code`, { method: 'POST', body: { client_id: CLIENT_ID } });
  const device = result.json;
  if (!result.ok || typeof device?.device_code !== 'string' || typeof device.user_code !== 'string') {
    throw new Error(`OpenCode refused to start a login: ${describe(result)}`);
  }
  const url = new URL(device.verification_uri_complete ?? device.verification_uri ?? '/console/device', `${server}/`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('OpenCode returned an unusable verification URL');
  return {
    deviceCode: device.device_code,
    userCode: device.user_code,
    url: url.href,
    intervalMs: Math.max(1, Number(device.interval) || 5) * 1000,
    expiresAt: now + Math.max(1, Number(device.expires_in) || 600) * 1000,
  };
}

/**
 * Poll until the user approves, the code expires or `signal` aborts.
 * @returns the token response (`access_token`, `refresh_token`, `expires_in`).
 */
export async function pollDeviceToken(device, { fetch: fetchImpl = globalThis.fetch, server = CONSOLE_URL, signal, sleep, now = () => Date.now() } = {}) {
  const wait = sleep ?? (ms => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));
  let interval = device.intervalMs;
  while (now() < device.expiresAt) {
    await wait(interval);
    signal?.throwIfAborted();
    const result = await request(fetchImpl, `${server}/auth/device/token`, { method: 'POST', signal, body: { grant_type: DEVICE_GRANT, device_code: device.deviceCode, client_id: CLIENT_ID } });
    if (typeof result.json?.access_token === 'string') return result.json;
    const error = result.json?.error;
    if (error === 'authorization_pending') continue;
    if (error === 'slow_down') { interval += 5000; continue; }
    // A transient gateway failure is not an answer; keep polling until the code expires.
    if (result.status >= 500 || result.status === 429) continue;
    throw new Error(error === 'expired_token' ? 'the login code expired before it was approved' : error === 'access_denied' ? 'the login was declined' : `OpenCode refused the login: ${describe(result)}`);
  }
  throw new Error('the login code expired before it was approved');
}

/**
 * Turn a token response into a stored grant: the account, and the first organisation (by
 * name) whose console config carries `opencode-go`, with the inference endpoint it names.
 */
export async function completeGrant(token, { fetch: fetchImpl = globalThis.fetch, server = CONSOLE_URL, now = Date.now() } = {}) {
  const access = token.access_token;
  const [user, orgs] = await Promise.all([
    request(fetchImpl, `${server}/api/user`, { token: access }),
    request(fetchImpl, `${server}/api/orgs`, { token: access }),
  ]);
  if (!user.ok || !orgs.ok || !Array.isArray(orgs.json)) throw new Error(`OpenCode did not return the account: ${describe(user.ok ? orgs : user)}`);
  const sorted = orgs.json.filter(org => typeof org?.id === 'string')
    .toSorted((a, b) => String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
  for (const org of sorted) {
    const config = await request(fetchImpl, `${server}/api/config`, { token: access, orgID: org.id });
    const go = config.ok ? config.json?.config?.provider?.['opencode-go'] : undefined;
    if (typeof go?.api !== 'string' || !URL.canParse(go.api)) continue;
    return {
      version: GRANT_VERSION,
      access,
      refresh: token.refresh_token,
      expires: now + Math.max(0, Number(token.expires_in) || 0) * 1000,
      server,
      api: go.api.replace(/\/+$/, ''),
      orgID: org.id,
      ...(typeof org.name === 'string' ? { orgName: org.name } : {}),
      ...(typeof user.json?.email === 'string' ? { email: user.json.email } : {}),
    };
  }
  throw new Error('this OpenCode account has no organisation with an OpenCode Go subscription');
}

/** Exchange the grant's refresh token; the returned grant carries the rotated one. */
export async function refreshGrant(grant, { fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const result = await request(fetchImpl, `${grant.server ?? CONSOLE_URL}/auth/device/token`, { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: grant.refresh, client_id: CLIENT_ID } });
  if (typeof result.json?.access_token !== 'string') {
    const error = new Error(`OpenCode refused to refresh the login: ${describe(result)}`);
    error.invalidGrant = result.json?.error === 'invalid_grant';
    throw error;
  }
  return {
    ...grant,
    access: result.json.access_token,
    refresh: result.json.refresh_token ?? grant.refresh,
    expires: now + Math.max(0, Number(result.json.expires_in) || 0) * 1000,
  };
}

/** A stored grant, or undefined for anything that is not one. */
export function parseGrant(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let grant;
  try { grant = JSON.parse(value); } catch { return undefined; }
  const valid = grant?.version === GRANT_VERSION && typeof grant.access === 'string' && typeof grant.refresh === 'string'
    && Number.isFinite(grant.expires) && typeof grant.api === 'string' && URL.canParse(grant.api) && typeof grant.orgID === 'string';
  return valid ? grant : undefined;
}

/** The account facts safe to show: no token ever leaves through here. */
export function grantSummary(grant, now = Date.now()) {
  return { email: grant.email, orgName: grant.orgName, expiresInDays: Math.max(0, Math.round((grant.expires - now) / 86400000)) };
}

/**
 * The grant as request auth, refreshed when it is about to expire. One refresh runs at a
 * time per process; a refused refresh re-reads the store, because another DSCODE process
 * may already have rotated the token.
 */
export class GrantSession {
  /** @param store - `{ read(): Promise<string|undefined>, write(value): Promise<void> }` over the shared store. */
  constructor(store, { fetch, now = () => Date.now() } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.now = now;
    this.pending = undefined;
  }

  async current() {
    return parseGrant(await this.store.read());
  }

  /** Request auth from the stored grant, or undefined when there is none. */
  async auth() {
    let grant = await this.current();
    if (grant === undefined) return undefined;
    if (grant.expires - this.now() < REFRESH_MARGIN_MS) grant = await this.refresh(grant);
    return { apiKey: grant.access, baseURL: grant.api, headers: { 'x-opencode-org-id': grant.orgID } };
  }

  refresh(grant) {
    this.pending ??= (async () => {
      try {
        const next = await refreshGrant(grant, { ...(this.fetch ? { fetch: this.fetch } : {}), now: this.now() });
        await this.store.write(JSON.stringify(next));
        return next;
      } catch (error) {
        const stored = await this.current();
        if (stored !== undefined && stored.refresh !== grant.refresh && stored.expires - this.now() >= REFRESH_MARGIN_MS) return stored;
        throw new LlmError(`OpenCode Go login ${error.invalidGrant ? 'expired or was revoked' : 'could not be refreshed'}; run /opencode login again`, 'AUTH', { cause: error });
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
}
