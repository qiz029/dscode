import { grokAuthState, minutesLeft } from "./auth.mjs";
import { grokSubscriptionNow, readGrokSubscription } from "./billing.mjs";

// dscode: one snapshot for the two surfaces that show the Grok rail: the /login grok panel and
// the provider list. The live process value wins; a state file written by another process (a
// second DSCODE on the same Mac) is the fallback, so a panel opened before the first refresh
// still shows the last known window.

/**
 * @returns `{ status: { kind, expiresIn? }, subscription? }`; `kind` is the local login state
 *   (`ready`, `expired`, `missing`, `malformed`) and `expiresIn` is minutes on a ready login.
 */
export function grokStatusSnapshot({ home = process.env.DSH_HOME, now = Date.now() } = {}) {
  const auth = grokAuthState({ now });
  const stored = grokSubscriptionNow() ?? (home === undefined ? undefined : readGrokSubscription(home));
  return {
    status: { kind: auth.kind, ...auth.kind === "ready" ? { expiresIn: minutesLeft(auth.credential, now) } : {} },
    ...stored === undefined ? {} : { subscription: stored },
  };
}

/** One line for the provider list: the login state, not a key name. */
export function grokStatusText(snapshot = grokStatusSnapshot()) {
  if (snapshot.status.kind === "ready") return "grok login detected";
  if (snapshot.status.kind === "expired") return "grok login expired · run grok login";
  if (snapshot.status.kind === "malformed") return "grok login file unreadable · run grok login";
  return "no grok login · run grok login";
}
