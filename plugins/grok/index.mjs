import z from "@deepseek-ai/schemastery";
import { RetryPolicySchema, resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { plainConfig } from "../cordis-config/plain.mjs";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { GrokAdapter, PROVIDER } from "./adapter.mjs";
import { ensureGrokModels } from "./models.mjs";
import { GROK_SUBSCRIPTION_TTL_MS, currentGrokSubscription } from "./billing.mjs";
import { GROK_TOKEN_REF, grokAuthState } from "./auth.mjs";

// dscode: the `grok` route — the SuperGrok / X Premium+ subscription the official grok CLI
// already signed in for, driven through xAI chat completions. The token is read (never
// written) from the CLI credential file, the catalog and the weekly credit window come from
// the same CLI proxy the official client uses, and the status line reads the cached window
// instead of a dollar balance: a subscription has credits, not a bill.
export const name = "dscode-grok";
export const inject = ["llm"];
const NS = "llm-grok";
const DEFAULT_BASE_URL = "https://api.x.ai/v1";
/** The client version the CLI proxy is asked with; xAI refuses requests without one. */
const DEFAULT_CLIENT_VERSION = "1.0.34";

// DSH 0.1.7 replaced settings sections with volatile configuration: each `.volatile()`
// field arrives as a reference the Settings form and a profile edit both write, so the
// reads below always see the current value.
export const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref").default(GROK_TOKEN_REF).volatile(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  clientVersion: z.string().default(DEFAULT_CLIENT_VERSION).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300000).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
});


/** Validated connection facts from one config snapshot. */
export function resolveOptions(config = {}) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw new Error(name + ": streamIdleTimeoutMs must be a positive number");
  const baseURL = (config.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (!URL.canParse(baseURL)) throw new Error(name + ": baseURL must be a URL");
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv || GROK_TOKEN_REF),
    baseURL,
    clientVersion: config.clientVersion || DEFAULT_CLIENT_VERSION,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, name + ": retryPolicy"),
  };
}

/** The message a missing or expired CLI login deserves: the fix is a command, not a paste. */
export function loginHint(state) {
  if (state.kind === 'missing') return name + ': no local grok login found; run "grok login" (DSCODE reads ~/.grok/auth.json read-only)';
  if (state.kind === 'expired') return name + ': the local grok login expired; run "grok login" again (DSCODE never rotates that token)';
  return name + ': the local grok login file was not readable; run "grok login" again';
}

export function apply(ctx, config = {}) {
  // The TUI renders this route's own page, so Settings must not generate a form for it.
  ctx.inject(["settings"], settingsCtx => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
  });
  let lastGood;
  const options = () => {
    try {
      lastGood = resolveOptions(plainConfig(config));
      return lastGood;
    } catch (error) {
      if (lastGood === undefined) throw error;
      ctx.logger.error(name + ": keeping the last good configuration after an invalid edit");
      return lastGood;
    }
  };
  options();
  const home = process.env.DSH_HOME;
  /** The credential the route calls with, or undefined: the catalog must load without a login. */
  const resolveTokenSafe = async () => {
    const ref = options().apiKeyEnv;
    const credentials = ctx.get("credentials");
    try {
      const stored = credentials === undefined ? launchEnvironmentOf(ctx).get(ref)?.value : (await credentials.resolve(ref))?.value;
      if (stored !== undefined && stored.length > 0) return stored;
    } catch { /* fall through to the local login state for a better message */ }
    const state = grokAuthState();
    return state.kind === "ready" ? state.credential.token : undefined;
  };
  const resolveToken = async () => {
    const token = await resolveTokenSafe();
    if (token !== undefined) return token;
    throw new Error(loginHint(grokAuthState()));
  };
  const ensureModels = async () => {
    const token = await resolveTokenSafe();
    if (token === undefined) return;
    await ensureGrokModels({ home, token, version: options().clientVersion });
  };
  const adapter = new GrokAdapter({ options, ensureModels, resolveToken });
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: "Grok", settingsNs: ctx.fiber.entry?.options.id ?? NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  // The retry policy is captured at registration, and a reference carries no change
  // callback: re-register the route when an edit lands on a different policy.
  let registeredPolicy = options().retryPolicy;
  ctx.on("loader/volatile-update", () => {
    let policy;
    try { policy = options().retryPolicy; } catch (error) { ctx.logger.warn(error); return; }
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  });
  // Warm the catalog and the weekly window for a user who already ran `grok login`, then keep
  // the window fresh at the interval the official CLI itself watches (subscription_watch_interval_secs).
  const refresh = async () => {
    const state = grokAuthState();
    if (state.kind !== "ready") return;
    await ensureGrokModels({ home, token: state.credential.token, version: options().clientVersion });
    await currentGrokSubscription({ home, token: state.credential.token, userId: state.credential.userId, version: options().clientVersion });
  };
  void refresh().catch(() => {});
  const timer = setInterval(() => { void refresh().catch(() => {}); }, GROK_SUBSCRIPTION_TTL_MS);
  timer.unref?.();
  ctx.effect(() => () => clearInterval(timer));
}
