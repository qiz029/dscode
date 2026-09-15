import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { OpenRouterAdapter, PROVIDER } from './adapter.mjs';
import { ensureOpenRouterModels } from './models.mjs';
import { OpenRouterSearchProvider, RoutedSearchProvider } from './search.mjs';

// The `openrouter` route: DSCODE's own OpenRouter adapter over its live model
// listing, configured by the `llm-openrouter` settings section, plus web search
// that follows the session's route.
export const name = 'dscode-openrouter';
export const inject = ['llm'];
const NS = 'llm-openrouter';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('OPENROUTER_API_KEY'),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  streamIdleTimeoutMs: z.number().min(1).default(300000),
  maxRequestImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024),
  searchModel: z.string().default('deepseek/deepseek-v4-flash'),
  retryPolicy: RetryPolicySchema,
});

/** Validated connection facts from one config snapshot. */
export function resolveOptions(config = {}) {
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) throw new Error(`${name}: streamIdleTimeoutMs must be a positive number`);
  const baseURL = (config.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!URL.canParse(baseURL)) throw new Error(`${name}: baseURL must be a URL`);
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv || 'OPENROUTER_API_KEY'),
    baseURL,
    streamIdleTimeoutMs,
    maxRequestImageBytes: config.maxRequestImageBytes ?? 20 * 1024 * 1024,
    searchModel: config.searchModel || 'deepseek/deepseek-v4-flash',
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `${name}: retryPolicy`),
  };
}

export function apply(ctx, config = {}) {
  let current = () => config, lastRaw, lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      lastGood = resolveOptions(raw);
      lastRaw = raw;
      return lastGood;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error(`${name}: keeping the last good configuration after an invalid settings section`);
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
  const home = process.env.DSH_HOME;
  const ensureModels = () => ensureOpenRouterModels({ home });
  const adapter = new OpenRouterAdapter({
    options,
    ensureModels,
    resolveApiKey: async connection => {
      const key = await resolveKey(connection.apiKeyEnv);
      if (key !== undefined) return assertUsableApiKey(key, name, connection.apiKeyEnv);
      throw new LlmError(`${name}: no API key for OpenRouter; run /login openrouter, or export ${connection.apiKeyEnv} in the launching environment`, 'MISSING_CREDENTIAL');
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  });
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'OpenRouter', settingsNs: NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = JSON.stringify(options().retryPolicy);
  ctx.inject(['settings'], settingsCtx => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: source => { current = source; },
      // The retry policy is captured at registration: re-register the route when it changes.
      onChange: () => {
        const policy = JSON.stringify(options().retryPolicy);
        if (policy === registeredPolicy) return;
        registration.replace([PROVIDER]);
        registeredPolicy = policy;
      },
    });
  });
  ctx.inject(['web'], webCtx => {
    const openrouter = new OpenRouterSearchProvider(() => {
      const connection = options();
      return { baseURL: connection.baseURL, model: connection.searchModel, resolveApiKey: () => resolveKey(connection.apiKeyEnv) };
    });
    webCtx.web.registerSearchProvider(openrouter);
    webCtx.web.registerSearchProvider(new RoutedSearchProvider({
      openrouter,
      // `ctx.web` keeps no per-call selection; the DeepSeek provider is looked up in its registry.
      deepseek: () => webCtx.web.searchProviders?.get?.('deepseek-official'),
      currentProvider: () => {
        const agent = ctx.get('agents')?.currentInitiator?.();
        return agent?.session?.requestHeader?.()?.config?.provider ?? agent?.options?.provider;
      },
      hasKey: async ref => (await resolveKey(credentialRef(ref))) !== undefined,
    }));
  });
  // Warm the listing for an OpenRouter user, so the first /model opens with every model.
  void resolveKey(options().apiKeyEnv).then(key => key === undefined ? undefined : ensureModels(), () => {});
}
