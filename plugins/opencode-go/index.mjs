import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { plainConfig } from '../cordis-config/plain.mjs';
import { OpenCodeGoAdapter, PROVIDER } from './adapter.mjs';
import { dscodeVersion } from './version.mjs';
import { GRANT_REF, GrantSession } from './oauth.mjs';
import { OpenCodeLogin, openCodeCommand } from './command.mjs';
import { GO_USAGE_TTL_MS, clearGoUsage, currentGoUsage } from './usage.mjs';
import { readLanguage } from '../i18n/messages.mjs';

// The `opencode-go` route: the OpenCode Go subscription's chat-completions models through
// DSCODE's OpenRouter request loop, authorised only by an OpenCode account login
// (`/opencode login`, see oauth.mjs). The login names the account's own inference endpoint,
// which also answers the subscription's usage for the status line (usage.mjs).
export const name = 'dscode-opencode-go';
export const inject = ['llm'];
const NS = 'llm-opencode-go';
/** Where requests go before a login names the account's endpoint; used only in messages. */
const DEFAULT_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';

// The route's credential reference is the login itself: `/provider` reads its status from
// here, and the credential store describes it as read-only so no key form is ever offered.
// Each `.volatile()` field arrives as a reference the Settings form and a profile edit both
// write, so every read below sees the current value.
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(GRANT_REF).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300000).volatile(),
  maxRequestImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
});

/** Validated connection facts from one config snapshot. */
export function resolveOptions(config = {}) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw new Error(`${name}: streamIdleTimeoutMs must be a positive number`);
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv || GRANT_REF),
    baseURL: DEFAULT_BASE_URL,
    streamIdleTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes ?? 20 * 1024 * 1024,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${name}: retryPolicy`),
  };
}

export function apply(ctx, config = {}) {
  // `/opencode` owns the login, so Settings must not generate a form for this entry.
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
  });
  let lastGood;
  const options = () => {
    try {
      lastGood = resolveOptions(plainConfig(config));
      return lastGood;
    } catch (error) {
      if (lastGood === undefined) throw error;
      ctx.logger.error(`${name}: keeping the last good configuration after an invalid edit`);
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();
  const home = process.env.DSH_HOME;
  // The login lives in the shared credential store beside the provider keys.
  const grants = {
    read: async () => (await ctx.get('credentials')?.resolve(GRANT_REF))?.value || undefined,
    write: value => ctx.get('credentials').set(GRANT_REF, value),
    remove: async () => {
      await ctx.get('credentials')?.unset(GRANT_REF);
      clearGoUsage(home);
    },
  };
  const session = new GrantSession(grants);
  const signedIn = async () => {
    const auth = await session.auth();
    if (auth !== undefined) return auth;
    throw new LlmError(`${name}: not signed in to OpenCode Go; run /opencode login`, 'MISSING_CREDENTIAL');
  };
  const adapter = new OpenCodeGoAdapter({
    options,
    version: dscodeVersion(),
    resolveAccount: signedIn,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  });
  // Keep the subscription's usage fresh for the status line while signed in.
  const refreshUsage = () => currentGoUsage({ home, resolveAuth: () => session.auth() });
  ctx.inject(['commands'], commandsCtx => {
    const login = new OpenCodeLogin({
      store: grants,
      grant: () => session.current(),
      onSignedIn: () => { void refreshUsage().catch(() => {}); },
      log: message => ctx.logger.info(`${name}: ${message}`),
    });
    commandsCtx.effect(() => () => login.dispose());
    commandsCtx.commands.register(openCodeCommand(login, () => readLanguage()));
  });
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'OpenCode Go', settingsNs: ctx.fiber.entry?.options.id ?? NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  // The retry policy is captured at registration: re-register when an edit changes it.
  let registeredPolicy = options().retryPolicy;
  ctx.on('loader/volatile-update', () => {
    let policy;
    try { policy = options().retryPolicy; } catch (error) { ctx.logger.warn(error); return; }
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  });
  void refreshUsage().catch(() => {});
  const timer = setInterval(() => { void refreshUsage().catch(() => {}); }, GO_USAGE_TTL_MS);
  timer.unref?.();
  ctx.effect(() => () => clearInterval(timer));
}
