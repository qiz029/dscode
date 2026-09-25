import z from '@deepseek-ai/schemastery';
import { LlmError, RetryPolicySchema, assertUsableApiKey, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { plainConfig } from '../cordis-config/plain.mjs';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { OpenRouterAdapter, PROVIDER } from './adapter.mjs';
import { ensureOpenRouterModels } from './models.mjs';
import { OpenRouterSearchProvider, RoutedSearchProvider } from './search.mjs';
import { ExaSearchProvider } from '../opencode-go/search.mjs';
import { dscodeVersion } from '../opencode-go/version.mjs';

// The `openrouter` route: DSCODE's own OpenRouter adapter over its live model
// listing, configured by this entry's own profile row, plus web search that
// follows the session's route (including Exa for an OpenCode Go session).
export const name = 'dscode-openrouter';
export const inject = ['llm'];
const NS = 'llm-openrouter';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

// DSH 0.1.7 replaced settings sections with volatile configuration: a field marked
// `.volatile()` reaches the plugin as a reference the Settings form and a profile edit
// both write, so each read below sees the current value without a change callback.
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('OPENROUTER_API_KEY').volatile(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  streamIdleTimeoutMs: z.number().min(1).default(300000).volatile(),
  maxRequestImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024).volatile(),
  searchModel: z.string().default('deepseek/deepseek-v4-flash').volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
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
  // The TUI renders this route's own page, so Settings must not generate a form for it.
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
  ctx.llm.registerConfigurableProviders([{ provider: PROVIDER, displayName: 'OpenRouter', settingsNs: ctx.fiber.entry?.options.id ?? NS, settingsPath: [] }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  // The retry policy is captured at registration, and a reference carries no change
  // callback: re-register the route when an edit lands on a different policy.
  let registeredPolicy = options().retryPolicy;
  ctx.on('loader/volatile-update', () => {
    let policy;
    try { policy = options().retryPolicy; } catch (error) { ctx.logger.warn(error); return; }
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
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
      // An OpenCode Go session searches through Exa, as OpenCode's own client does.
      exa: new ExaSearchProvider(() => ({ resolveApiKey: () => resolveKey(credentialRef('EXA_API_KEY')), userAgent: `dscode/${dscodeVersion() ?? '0.0.0'}` })),
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
