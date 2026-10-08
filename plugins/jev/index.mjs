import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { DEFAULT_ENDPOINT, DEFAULT_MODEL, requestDecisions } from './client.mjs';
import { DEFAULT_THRESHOLDS, approvalQuestions, approvalState, approvalVerdict } from './approval.mjs';
import { randomUUID } from 'node:crypto';
import { appendMetric } from '../session-metrics/store.mjs';
import { metricRecipients } from '../session-metrics/attribution.mjs';

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
  autoDeny: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.autoDeny),
  autoDenyProbability: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.autoDenyProbability),
  autoDenyCorroborated: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.autoDenyCorroborated),
  authorizedVeto: z.number().min(0).max(1).default(DEFAULT_THRESHOLDS.authorizedVeto),
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
    thresholds: Object.fromEntries(Object.keys(DEFAULT_THRESHOLDS).map(key => [key, config[key] ?? DEFAULT_THRESHOLDS[key]])),
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
      if (!apiKey || signal?.aborted) return undefined;
      const started = Date.now();
      const home = process.env.DSH_HOME, id = randomUUID();
      const recipients = sessionId && home ? metricRecipients(ctx.get('agents'), sessionId) : [];
      const save = entry => {
        for (const recipient of recipients) {
          try { appendMetric(home, recipient, { id, time: started, sessionId, provider: 'openrouter', model: options.model, purpose: 'review', source: 'jev', ...entry }); }
          catch { ctx.logger.warn('Jev cost telemetry could not be saved.'); }
        }
      };
      save({ kind: 'start' });
      let response;
      try {
        response = await requestDecisions({
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
      } finally {
        // The Decisions API bypasses llm.stream. Preserve its reported charge,
        // including an unusable verdict; never price an unknown attempt as zero.
        const raw = response?.usage;
        const usage = Number.isSafeInteger(raw?.input_tokens) && raw.input_tokens >= 0 && Number.isSafeInteger(raw?.output_tokens) && raw.output_tokens >= 0
          ? { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens } : null;
        save({ kind: 'end', endTime: Date.now(), usage,
          ...(typeof response?.model === 'string' ? { model: response.model.slice(0, 256) } : {}),
          cost: Number.isFinite(raw?.cost) && raw.cost >= 0 ? raw.cost : null, priceVersion: 'openrouter-decisions-billed' });
      }
    },
  };
  ctx.provide('jev', service);
  return service;
}
