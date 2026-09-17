import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// dscode: what the Grok subscription left, and when it resets. The CLI proxy answers two
// payloads on the same credential the models come from: /settings names the tier, and
// /billing?format=credits carries the weekly window plus the used percentage. The
// percentage is optional (the server omits it when a period has no usage), so the status
// line has three states: a number, no usage recorded yet, and unreadable.
//
// This is the undocumented rail the official CLI itself reads; every field is optional and
// a shape change must degrade to "usage unavailable", never to a crash or a wrong number.

export const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
export const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
/** The CLI re-reads its subscription every 60s (`subscription_watch_interval_secs`); so does DSCODE. */
export const GROK_SUBSCRIPTION_TTL_MS = 60_000;
const FILE = "grok-subscription.json";
const VERSION = 1;
let state;
let fetchedAt = 0;
let pending;
let disk;

const finite = value => Number.isFinite(Number(value)) ? Number(value) : undefined;
const percent = value => {
  const number = finite(value);
  return number === undefined ? undefined : Math.min(100, Math.max(0, number));
};
const stamp = value => typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * The weekly credit window from one `/billing?format=credits` body.
 * @returns `{ usedPercent?, periodStart?, periodEnd?, periodType?, onDemandCap?, onDemandUsed?,
 *   prepaidBalance?, unified? }` with unknown fields left out.
 */
export function parseGrokCredits(body) {
  const config = body?.config ?? {};
  const period = config.currentPeriod ?? {};
  const used = percent(config.creditUsagePercent);
  const onDemandCap = finite(config.onDemandCap?.val);
  const onDemandUsed = finite(config.onDemandUsed?.val);
  const prepaid = finite(config.prepaidBalance?.val);
  const periodEnd = stamp(period.end) ?? stamp(config.billingPeriodEnd);
  const periodStart = stamp(period.start) ?? stamp(config.billingPeriodStart);
  return {
    ...used === undefined ? {} : { usedPercent: used },
    ...periodStart === undefined ? {} : { periodStart },
    ...periodEnd === undefined ? {} : { periodEnd },
    ...stamp(period.type) === undefined ? {} : { periodType: stamp(period.type) },
    ...onDemandCap === undefined ? {} : { onDemandCap },
    ...onDemandUsed === undefined ? {} : { onDemandUsed },
    ...prepaid === undefined ? {} : { prepaidBalance: prepaid },
    ...config.isUnifiedBillingUser === true ? { unified: true } : {},
  };
}

/** The plan facts from one `/settings` body: the tier label and the access gate. */
export function parseGrokSettings(body) {
  const tier = stamp(body?.subscription_tier_display);
  const gate = stamp(body?.gate_message);
  const gateUrl = stamp(body?.gate_url);
  return {
    ...tier === undefined ? {} : { tier },
    ...stamp(body?.default_model) === undefined ? {} : { defaultModel: stamp(body.default_model) },
    ...body?.allow_access === false ? { blocked: true } : {},
    ...gate === undefined ? {} : { gateMessage: gate },
    ...gateUrl === undefined ? {} : { gateUrl },
  };
}

/** Both reads at once; either half may fail without losing the other. */
export async function fetchGrokSubscription({ token, userId, version = "1.0.34", fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (typeof fetchImpl !== "function") return undefined;
  const headers = { authorization: "Bearer " + token, accept: "application/json", "x-xai-token-auth": "xai-grok-cli", "x-authenticateresponse": "authenticate-response", "x-grok-client-version": version, ...userId === undefined ? {} : { "x-userid": userId } };
  const read = async url => {
    try {
      const response = await fetchImpl(url, { headers });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const [credits, settings] = await Promise.all([read(GROK_BILLING_URL), read(GROK_SETTINGS_URL)]);
  if (credits === undefined && settings === undefined) return undefined;
  return { ...parseGrokSettings(settings), ...parseGrokCredits(credits), fetchedAt: now };
}

/** The state the status line renders: cached for one refresh interval, one request in flight. */
export async function currentGrokSubscription({ home, ...options } = {}) {
  if (state !== undefined && Date.now() - fetchedAt < GROK_SUBSCRIPTION_TTL_MS) return state;
  if (pending) return pending;
  pending = (async () => {
    const next = await fetchGrokSubscription(options);
    if (next !== undefined) {
      state = next;
      fetchedAt = next.fetchedAt ?? Date.now();
      if (home !== undefined) writeGrokSubscription(home, next);
    }
    return state;
  })().finally(() => { pending = undefined; });
  return pending;
}

/** The last written subscription state, or undefined before the first successful read. */
export function readGrokSubscription(home) {
  try {
    const cached = JSON.parse(readFileSync(join(home, FILE), "utf8"));
    return cached?.version === VERSION && typeof cached === "object" ? cached : undefined;
  } catch {
    return undefined;
  }
}

/** Atomic write of one state snapshot; a failure leaves the previous file alone. */
export function writeGrokSubscription(home, snapshot) {
  try {
    mkdirSync(home, { recursive: true });
    const path = join(home, FILE);
    writeFileSync(path + ".tmp", JSON.stringify({ version: VERSION, ...snapshot }));
    renameSync(path + ".tmp", path);
  } catch { /* the status line simply keeps its previous state */ }
}

/** Replace the in-memory state; for tests. */
export function setGrokSubscription(next, at = Date.now()) {
  state = next;
  fetchedAt = at;
  pending = undefined;
  disk = undefined;
}

/**
 * The cached state without waiting for a fetch; the view uses this during a render. The live
 * process wins, then the state file the panel already reads, so a footer drawn before the
 * first refresh — or one drawn while the network is down — still shows the last window
 * instead of falling back to a bare tier name. One file read per refresh window keeps the
 * render path off the disk.
 */
export function grokSubscriptionNow(home = process.env.DSH_HOME) {
  if (state !== undefined) return state;
  if (home === undefined) return undefined;
  if (disk !== undefined && disk.home === home && Date.now() - disk.at < GROK_SUBSCRIPTION_TTL_MS) return disk.value;
  const value = readGrokSubscription(home);
  disk = { home, at: Date.now(), value };
  return value;
}
