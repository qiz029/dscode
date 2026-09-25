import { LlmError, ReasoningEffortId, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { OpenRouterAdapter } from '../openrouter/adapter.mjs';
import { effortInfo } from '../openrouter/wire.mjs';
import { DEFAULT_CONTEXT_WINDOW, GO_MODELS, OTHER_PROTOCOL_MODELS, goModel } from './models.mjs';
import { LABEL, PROVIDER, REPLAY_KIND, explainError, modelReasoning, requestBody } from './wire.mjs';

export { PROVIDER };
/** Output cap materialized when a caller names none. */
export const DEFAULT_OUTPUT_CAP = 131072;
const APP_URL = 'https://github.com/qiz029/dscode';

function modelInfo(provider, id, entry) {
  return { provider, id, name: entry?.name ?? id, inputModalities: entry?.inputModalities?.length ? [...entry.inputModalities] : ['text'] };
}

/**
 * OpenCode Go chat completions as a harness adapter. The request loop, image handling and
 * stream translation are OpenRouter's; this route supplies its own catalog, body and
 * headers. Go asks each client to name itself in the user agent and to send one stable
 * `x-opencode-session` per conversation.
 */
export class OpenCodeGoAdapter extends OpenRouterAdapter {
  /**
   * @param config - `options()` connection facts, `resolveApiKey(connection)`, `version`,
   *   optional `resolveAttachments()`, `resolveImageAccess(attachments, ref)` and `fetch`.
   */
  constructor(config) {
    super({ ensureModels: async () => {}, ...config });
  }

  get label() {
    return LABEL;
  }

  providerInfo(provider) {
    return { id: provider, name: LABEL };
  }

  async listModels(provider) {
    return [...GO_MODELS].map(([id, entry]) => modelInfo(provider, id, entry));
  }

  async resolveModel(provider, model) {
    const entry = goModel(model);
    const reasoning = modelReasoning(entry);
    return {
      ...modelInfo(provider, model, entry),
      context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_OUTPUT_CAP,
      ...(reasoning ? { reasoning: {
        efforts: reasoning.levels.map(id => ({ ...effortInfo(id), id: ReasoningEffortId(id) })),
        defaultEffort: ReasoningEffortId(reasoning.defaultEffort),
      } } : {}),
    };
  }

  async modelEntry(model) {
    const protocol = OTHER_PROTOCOL_MODELS.get(model);
    if (protocol !== undefined) {
      throw new LlmError(`${LABEL} serves "${model}" over its ${protocol} endpoint, which DSCODE does not support yet; pick a model from /model`, 'INVALID_REQUEST');
    }
    return goModel(model);
  }

  requestBody(options, context) {
    return requestBody(options, context);
  }

  requestHeaders(options) {
    return {
      ...attributionHeaders({ product: 'dscode', version: this.config.version ?? '0.0.0', url: APP_URL }),
      ...(options.sessionId !== undefined ? { 'x-opencode-session': String(options.sessionId).slice(0, 256) } : {}),
    };
  }

  translateOptions(options) {
    return { model: options.model, kind: REPLAY_KIND, label: LABEL };
  }

  async *stream(options) {
    try {
      yield* super.stream(options);
    } catch (error) {
      const explained = error instanceof LlmError ? explainError(error.message) : undefined;
      if (explained === undefined || explained === error.message) throw error;
      const status = error.failure?.status;
      throw new LlmError(explained, error.code, { cause: error, ...(status === undefined ? {} : { status }) });
    }
  }
}
