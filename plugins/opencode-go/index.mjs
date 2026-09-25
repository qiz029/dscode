import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { plainConfig } from '../cordis-config/plain.mjs';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { OpenCodeGoAdapter, PROVIDER } from './adapter.mjs';
import { dscodeVersion } from './version.mjs';

// The `opencode-go` route: the OpenCode Go subscription's chat-completions models through
// DSCODE's OpenRouter request loop, keyed by the API key from the OpenCode console.
export const name = 'dscode-opencode-go';
export const inject = ['llm'];
const NS = 'llm-opencode-go';
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const API_KEY_REF = 'OPENCODE_API_KEY';

// Each `.volatile()` field arrives as a reference the Settings form and a profile edit both
// write, so every read below sees the current value.
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(API_KEY_REF).volatile(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300000).volatile(),
  maxRequestImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
});

/** Validated connection facts from one config snapshot. */
export function resolveOptions(config = {}) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw new Error(`${name}: streamIdleTimeoutMs must be a positive number`);
  const baseURL = (config.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!URL.canParse(baseURL)) throw new Error(`${name}: baseURL must be a URL`);
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv || API_KEY_REF),
    baseURL,
    streamIdleTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes ?? 20 * 1024 * 1024,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${name}: retryPolicy`),
  };
}

export function apply(ctx, config = {}) {
  // `/login opencode-go` and `/provider` own the key, as for the other routes, so Settings
  // must not generate a second form for this entry.
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
  const resolveKey = async ref => {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value || undefined;
    return launchEnvironmentOf(ctx).get(ref)?.value || undefined;
  };
  const adapter = new OpenCodeGoAdapter({
    options,
    version: dscodeVersion(),
    resolveApiKey: async connection => {
      const key = await resolveKey(connection.apiKeyEnv);
      if (key !== undefined) return assertUsableApiKey(key, name, connection.apiKeyEnv);
      throw new LlmError(`${name}: no API key for OpenCode Go; run /login opencode-go, or export ${connection.apiKeyEnv} in the launching environment`, 'MISSING_CREDENTIAL');
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
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
}
