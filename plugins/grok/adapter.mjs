import { LlmAdapter, LlmError, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { grokModel, listGrokModels } from "./models.mjs";
import { PROVIDER, effortInfo, errorCode, errorMessage, requestBody, retryAfterMs, sseData, translate } from "./wire.mjs";

export { PROVIDER };
/** Context assumed for a model the catalog does not size. */
export const DEFAULT_CONTEXT_WINDOW = 131072;
/** Output cap materialized when a caller names none. */
export const DEFAULT_OUTPUT_CAP = 131072;

function modelInfo(provider, id, entry) {
  return { provider, id, name: entry?.name ?? id, inputModalities: ["text"] };
}

/**
 * xAI chat completions as a harness adapter: the subscription rail of the official grok
 * CLI, over the model catalog that rail publishes. The connection facts and the token
 * resolve per request, so a fresh `grok login` reaches the next call without a restart.
 */
export class GrokAdapter extends LlmAdapter {
  /** @param config - `options()`, `ensureModels()`, `resolveToken()`, optional `fetch`. */
  constructor(config) {
    super();
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: "Grok" };
  }

  providerRetryPolicy() {
    return this.config.options().retryPolicy;
  }

  /** Models that can drive an agent: the catalog the subscription rail filtered for this account. */
  async listModels(provider) {
    await this.config.ensureModels();
    return listGrokModels().map(([id, entry]) => modelInfo(provider, id, entry));
  }

  async resolveModel(provider, model) {
    await this.config.ensureModels();
    const entry = grokModel(model);
    const efforts = entry?.efforts ?? [];
    return {
      ...modelInfo(provider, model, entry),
      context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      ...entry?.maxOutput === undefined ? {} : { defaultMaxTokens: Math.min(entry.maxOutput, DEFAULT_OUTPUT_CAP) },
      ...efforts.length === 0 ? {} : { reasoning: {
        efforts: efforts.map(id => ({ ...effortInfo(id), id: ReasoningEffortId(id) })),
        ...entry?.defaultEffort === undefined ? {} : { defaultEffort: ReasoningEffortId(entry.defaultEffort) },
      } },
    };
  }

  async *stream(options) {
    const connection = this.config.options();
    const idle = new AbortController(), consumer = new AbortController();
    let timer;
    const pulse = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error("Grok stream idle")), connection.streamIdleTimeoutMs);
      timer.unref?.();
    };
    const signal = AbortSignal.any([idle.signal, consumer.signal, ...options.signal ? [options.signal] : []]);
    try {
      const token = await this.config.resolveToken();
      await this.config.ensureModels();
      const entry = grokModel(options.model);
      const body = requestBody(options, { entry });
      pulse();
      const fetchImpl = this.config.fetch ?? globalThis.fetch;
      let response;
      try {
        response = await fetchImpl(connection.baseURL + "/chat/completions", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`Grok request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
      }
      if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
        const raw = await response.text();
        let error;
        try { error = JSON.parse(raw)?.error; } catch { /* not JSON */ }
        if (response.ok && error === undefined) throw new LlmError(`Grok returned a non-stream response: ${raw.slice(0, 120)}`, "MALFORMED_RESPONSE");
        const delay = retryAfterMs(response.headers.get("retry-after"));
        const status = response.ok ? Number.isInteger(error?.code) ? error.code : undefined : response.status;
        throw new LlmError(errorMessage(error, `Grok API error (HTTP ${response.status})`), errorCode(response.ok ? undefined : response.status, error), {
          cause: new Error(raw.length > 0 ? raw : `Grok HTTP ${response.status}`),
          ...status === undefined ? {} : { status },
          ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        });
      }
      if (!response.body) throw new LlmError("Grok returned no response body", "EMPTY_RESPONSE");
      for await (const chunk of translate(sseData(response.body, pulse), { model: options.model })) {
        clearTimeout(timer);
        yield chunk;
        pulse();
      }
    } catch (error) {
      if (idle.signal.aborted && !options.signal?.aborted) throw new LlmError(`Grok stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
      if (options.signal?.aborted) throw new LlmError("Grok request aborted by caller", "ABORTED", { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`Grok API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    } finally {
      clearTimeout(timer);
      consumer.abort("Grok stream consumer stopped");
    }
  }
}
