import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, contentHasImage, offloadedImageText, projectOffloadedImages, requiredImageOffload } from '@deepseek-ai/dsh-llm';
import { listOpenRouterModels, openRouterModel } from './models.mjs';
import { PROVIDER, effortInfo, errorCode, errorMessage, modelReasoning, requestBody, retryAfterMs, sseData, translate } from './wire.mjs';

export { PROVIDER };
/** Context assumed for a model the listing does not size. */
export const DEFAULT_CONTEXT_WINDOW = 262144;
/** Output cap materialized when a caller names none; OpenRouter reserves credit for it. */
export const DEFAULT_OUTPUT_CAP = 131072;
const APP_URL = 'https://github.com/qiz029/dscode';
const IMAGE_POLICY = Object.freeze({ maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 });

/**
 * What `/model` offers on this route: the labs DSCODE tunes and tests, plus the current
 * flagship line of the mainstream Western labs. OpenRouter carries hundreds of tool-calling
 * models, and an alphabetical wall of them is not a picker, so the list is curated by hand;
 * an id OpenRouter retires drops out of the picker until this list is edited.
 * Only the picker narrows: `resolveModel` still serves every id the listing knows, so a
 * session already on a trimmed model, `exec --model` and provider switches keep working.
 */
export const LISTED_MODELS = Object.freeze([
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4.1-flash',
  'z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'z-ai/glm-5.3-flashx',
  'moonshotai/kimi-k3', 'moonshotai/kimi-k2.7-code', 'moonshotai/kimi-k2.6',
  'qwen/qwen3.8-max-0902', 'qwen/qwen3.8-flash', 'qwen/qwen3.8-27b', 'qwen/qwen3.7-plus',
  'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro-ultraspeed',
  'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-fable-5.1', 'anthropic/claude-haiku-4.5',
  'openai/gpt-6-astra-pro', 'openai/gpt-6-astra', 'openai/gpt-5.6-luna-pro', 'openai/gpt-5.6-terra-pro',
  'google/gemini-3.8-flash', 'google/gemini-3.1-pro-preview',
  'x-ai/grok-4.7', 'x-ai/grok-build-0.1',
]);
const LISTED = new Set(LISTED_MODELS);

function modelInfo(provider, id, entry) {
  return { provider, id, name: entry?.name ?? id, inputModalities: entry?.inputModalities?.length ? [...entry.inputModalities] : ['text'] };
}

function collectImages(blocks, refs) {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment);
    else if (block.type === 'tool-result') collectImages(block.content, refs);
  }
}

/**
 * OpenRouter chat completions as a harness adapter: fetch + SSE with the model
 * directory, reasoning controls and prices of OpenRouter's live listing. Connection
 * facts and the key resolve per request, so settings and `/login` changes reach the
 * next call.
 */
export class OpenRouterAdapter extends LlmAdapter {
  /**
   * @param config - `options()` connection facts, `resolveApiKey(connection)`, `ensureModels()`,
   *   optional `resolveAttachments()`, `resolveImageAccess(attachments, ref)` and `fetch`.
   */
  constructor(config) {
    super();
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: 'OpenRouter' };
  }

  providerRetryPolicy() {
    return this.config.options().retryPolicy;
  }

  /** The curated picker list, narrowed to entries that can drive an agent: text output and tool calls. */
  async listModels(provider) {
    await this.config.ensureModels();
    return listOpenRouterModels().filter(([id, entry]) => LISTED.has(id) && entry.tools !== false && entry.textOutput !== false).map(([id, entry]) => modelInfo(provider, id, entry));
  }

  async resolveModel(provider, model) {
    await this.config.ensureModels();
    const entry = openRouterModel(model);
    const reasoning = modelReasoning(model, entry);
    return {
      ...modelInfo(provider, model, entry),
      context: { contextWindow: entry?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
      ...(entry?.maxOutput ? { defaultMaxTokens: Math.min(entry.maxOutput, DEFAULT_OUTPUT_CAP) } : {}),
      ...(reasoning ? { reasoning: {
        efforts: reasoning.levels.map(id => ({ ...effortInfo(id), id: ReasoningEffortId(id) })),
        ...(reasoning.defaultEffort ? { defaultEffort: ReasoningEffortId(reasoning.defaultEffort) } : {}),
      } } : {}),
    };
  }

  /** Name in error messages; a subclass serving another route renames it. */
  get label() {
    return 'OpenRouter';
  }

  /** The model's catalog entry, after the catalog is loaded. */
  async modelEntry(model) {
    await this.config.ensureModels();
    return openRouterModel(model);
  }

  /** The chat-completions body for one prepared request. */
  requestBody(options, context) {
    return requestBody(options, context);
  }

  /** Route headers beyond auth, content type and the user agent. */
  requestHeaders() {
    return { 'HTTP-Referer': APP_URL, 'X-OpenRouter-Title': 'DSCODE', 'X-OpenRouter-Categories': 'cli-agent' };
  }

  /**
   * Where and how the next request authenticates: the bearer secret, the base URL and any
   * extra headers. A subclass whose credential carries its own endpoint overrides this.
   */
  async resolveAuth(connection) {
    return { apiKey: await this.config.resolveApiKey(connection), baseURL: connection.baseURL, headers: {} };
  }

  /** Options for the stream translation: the replay kind and error label. */
  translateOptions(options) {
    return { model: options.model };
  }

  async *stream(options) {
    const connection = this.config.options();
    const label = this.label;
    // The endpoint the request went to, for error messages: the route's own until auth names another.
    let endpoint = connection.baseURL;
    const idle = new AbortController(), consumer = new AbortController();
    let timer;
    const pulse = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error(`${label} stream idle`)), connection.streamIdleTimeoutMs);
      timer.unref?.();
    };
    const signal = AbortSignal.any([idle.signal, consumer.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      const auth = await this.resolveAuth(connection);
      endpoint = auth.baseURL;
      const entry = await this.modelEntry(options.model);
      pulse();
      const images = await this.prepareImages(options, entry, connection, signal);
      const body = this.requestBody(images?.options ?? options, { entry, images });
      const fetchImpl = this.config.fetch ?? globalThis.fetch;
      let response;
      try {
        response = await fetchImpl(`${auth.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${auth.apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...attributionHeaders(),
            ...this.requestHeaders(options),
            ...auth.headers,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`${label} request to ${endpoint} failed`, 'TRANSPORT', { cause: error });
      }
      // A rejected request, or a 200 whose JSON body holds only an error.
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const raw = await response.text();
        let error;
        try { error = JSON.parse(raw)?.error; } catch { /* not JSON */ }
        if (response.ok && error === undefined) throw new LlmError(`${label} returned a non-stream response: ${raw.slice(0, 120)}`, 'MALFORMED_RESPONSE');
        const delay = retryAfterMs(response.headers.get('retry-after'));
        const status = response.ok ? (Number.isInteger(error?.code) ? error.code : undefined) : response.status;
        throw new LlmError(errorMessage(error, `${label} API error (HTTP ${response.status})`), errorCode(response.ok ? undefined : response.status, error), {
          cause: new Error(raw.length > 0 ? raw : `${label} HTTP ${response.status}`),
          ...(status === undefined ? {} : { status }),
          ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        });
      }
      if (!response.body) throw new LlmError(`${label} returned no response body`, 'EMPTY_RESPONSE');
      for await (const chunk of translate(sseData(response.body, pulse), this.translateOptions(options))) {
        // The idle clock measures the provider, not a slow consumer.
        clearTimeout(timer);
        yield chunk;
        pulse();
      }
    } catch (error) {
      if (idle.signal.aborted && !options.signal?.aborted) throw new LlmError(`${label} stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
      if (options.signal?.aborted) throw new LlmError(`${label} request aborted by caller`, 'ABORTED', { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`${label} API stream from ${endpoint} failed`, 'TRANSPORT', { cause: error });
    } finally {
      clearTimeout(timer);
      consumer.abort(`${label} stream consumer stopped`);
    }
  }

  /**
   * Read request versions of every retained image.
   *
   * DSH 0.1.7 made the offloaded set a durable surface fact: a route projects what the
   * surface already offloaded into text and reports how much more must go with
   * `IMAGE_OFFLOAD_REQUIRED`, instead of dropping the oldest occurrences itself. The
   * `compaction-image-offload` executor records that choice and retries, so the decision
   * survives a route change, resume and replay rather than being remade per request.
   */
  async prepareImages(options, entry, connection, signal) {
    const attachments = this.config.resolveAttachments?.();
    const access = ref => (attachments === undefined ? undefined : this.config.resolveImageAccess?.(attachments, ref));
    const messages = projectOffloadedImages(options.messages, ref => offloadedImageText(ref, access(ref)));
    const withImages = messages.some(message => contentHasImage(message.content));
    if (!withImages) return messages === options.messages ? undefined : { options: { ...options, messages: [...messages] }, versions: new Map(), access };
    if (!entry?.inputModalities?.includes('image')) throw new LlmError(`${this.label} model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT');
    if (attachments === undefined) throw new LlmError(`${this.label} image input requires the durable attachment service.`, 'UNSUPPORTED_CONTENT');
    const refs = new Map();
    for (const message of messages) collectImages(message.content, refs);
    const versions = new Map(await Promise.all([...refs.values()].map(async ref => [ref.attachmentId, await attachments.readImageRequest(ref, IMAGE_POLICY, signal)])));
    const offloadImages = requiredImageOffload(
      messages,
      { representation: 'base64', maxBytes: connection.maxRequestImageBytes, byteQuantum: 1 },
      block => versions.get(block.attachment.attachmentId).bytes,
    );
    if (offloadImages > 0) {
      throw new LlmError(
        `${this.label} request images exceed ${connection.maxRequestImageBytes} bytes; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      );
    }
    return { options: { ...options, messages: [...messages] }, versions, access };
  }
}
