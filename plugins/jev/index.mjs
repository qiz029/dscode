import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, requestDecisions } from './client.mjs';
import { DEFAULT_THRESHOLDS, approvalQuestions, approvalState, approvalVerdict } from './approval.mjs';

// Jev is a decisions model, not a chat model: it answers typed questions about
// supplied state and never generates prose. The service below exposes exactly one
// consumer so far — the automatic permission review — and stays inert unless the
// deployment has an OpenRouter key, so mounting it changes nothing by itself.
export const name = 'dscode-jev';

export const Config = z.object({
  enabled: z.boolean().default(true),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  model: z.string().default(DEFAULT_MODEL),
  apiKeyEnv: z.string().role('credential-ref').default('OPENROUTER_API_KEY'),
  timeoutMs: z.number().step(1).min(1).default(8000),
  autoAllow: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.autoAllow),
  credentialRisk: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.credentialRisk),
  destructiveCeiling: z.number().min(0).default(DEFAULT_THRESHOLDS.destructiveCeiling),
});

export function resolveOptions(config = {}) {
  if (config.endpoint !== undefined && !URL.canParse(String(config.endpoint))) throw new Error(`${name}: endpoint must be a URL`);
  return {
    enabled: config.enabled !== false,
    endpoint: config.endpoint || DEFAULT_ENDPOINT,
    model: config.model || DEFAULT_MODEL,
    apiKeyEnv: credentialRef(config.apiKeyEnv || 'OPENROUTER_API_KEY'),
    timeoutMs: config.timeoutMs ?? 8000,
    thresholds: {
      autoAllow: config.autoAllow ?? DEFAULT_THRESHOLDS.autoAllow,
      credentialRisk: config.credentialRisk ?? DEFAULT_THRESHOLDS.credentialRisk,
      destructiveCeiling: config.destructiveCeiling ?? DEFAULT_THRESHOLDS.destructiveCeiling,
    },
  };
}

export function apply(ctx, config = {}) {
  const options = resolveOptions(config);
  const resolveKey = async () => {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) return (await credentials.resolve(options.apiKeyEnv))?.value || undefined;
    return launchEnvironmentOf(ctx).get(options.apiKeyEnv)?.value || undefined;
  };
  const service = {
    name,
    model: options.model,
    enabled: () => options.enabled,
    configured: async () => options.enabled && (await resolveKey()) !== undefined,
    // Returns a verdict, or undefined when Jev is unavailable, unconfigured, or
    // failed. The caller keeps its own reviewer for that case, so a Jev outage
    // degrades to the previous behaviour instead of allowing anything.
    approval: async ({ action, context, sessionId, signal } = {}) => {
      if (!options.enabled) return undefined;
      const apiKey = await resolveKey();
      if (!apiKey) return undefined;
      const started = Date.now();
      try {
        const response = await requestDecisions({
          endpoint: options.endpoint, model: options.model, apiKey,
          state: approvalState({ action, context }), questions: approvalQuestions(),
          sessionId, timeoutMs: options.timeoutMs, signal,
        });
        const verdict = approvalVerdict(response.answers, options.thresholds);
        if (verdict === undefined) return undefined;
        return { ...verdict, source: 'jev', model: response.model ?? options.model, usage: response.usage, durationMs: Date.now() - started };
      } catch (error) {
        ctx.logger.warn(`jev: ${error.message}`);
        return undefined;
      }
    },
  };
  ctx.provide('jev', service);
  return service;
}
