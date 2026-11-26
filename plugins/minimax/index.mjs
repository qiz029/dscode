import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { plainConfig } from '../cordis-config/plain.mjs';
import { MiniMaxAdapter } from './adapter.mjs';

export const name = 'dscode-minimax';
export const inject = ['llm'];
const BASE_URL = 'https://api.minimax.io/anthropic';
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('MINIMAX_API_KEY').volatile(),
  baseURL: z.string().default(BASE_URL).volatile(),
  serviceTier: z.union(['standard', 'priority']).default('standard').volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300000).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
});

export function resolveOptions(config = {}) {
  const url = new URL(config.baseURL || BASE_URL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('MiniMax base URL must use HTTP(S) without credentials, query or fragment');
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw Error('MiniMax idle timeout must be positive');
  return { baseURL: url.href.replace(/\/+$/, ''), apiKeyEnv: credentialRef(config.apiKeyEnv || 'MINIMAX_API_KEY'), serviceTier: config.serviceTier ?? 'standard',
    streamIdleTimeoutMs, retryPolicy: resolveRetryPolicy(config.retryPolicy, name + ': retryPolicy') };
}

export function apply(ctx, config = {}) {
  ctx.inject(['settings'], scoped => scoped.effect(() => scoped.settings.configure({ auto: false }, ctx.fiber)));
  let lastGood;
  const options = () => {
    try { lastGood = resolveOptions(plainConfig(config)); }
    catch (error) {
      if (!lastGood) throw error;
      ctx.logger.warn('MiniMax: retaining the last valid configuration');
    }
    return lastGood;
  };
  options();
  const adapter = new MiniMaxAdapter({ options,
    resolveApiKey: async connection => {
      const credentials = ctx.get('credentials');
      const key = credentials ? (await credentials.resolve(connection.apiKeyEnv))?.value : launchEnvironmentOf(ctx).get(connection.apiKeyEnv)?.value;
      if (key) return assertUsableApiKey(key, name, connection.apiKeyEnv);
      throw new LlmError('MiniMax needs an API key; run /login minimax or set MINIMAX_API_KEY', 'MISSING_CREDENTIAL');
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref),
  });
  ctx.llm.registerConfigurableProviders([{ provider: 'minimax', displayName: 'MiniMax', settingsNs: ctx.fiber.entry?.options.id ?? 'llm-minimax', settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter(['minimax'], adapter);
  let policy = options().retryPolicy;
  ctx.on('loader/volatile-update', () => {
    const next = options().retryPolicy;
    if (!deepEqualJson(policy, next)) { registration.replace(['minimax']); policy = next; }
  });
}
