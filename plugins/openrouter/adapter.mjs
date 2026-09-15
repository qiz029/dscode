import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, contentHasImage, offloadRequestImagesWithPolicy, offloadedImageText } from '@deepseek-ai/dsh-llm';
import { listOpenRouterModels, openRouterModel } from './models.mjs';
import { PROVIDER, effortInfo, errorCode, errorMessage, modelReasoning, requestBody, retryAfterMs, sseData, translate } from './wire.mjs';

export { PROVIDER };
/** Context assumed for a model the listing does not size. */
export const DEFAULT_CONTEXT_WINDOW = 262144;
/** Output cap materialized when a caller names none; OpenRouter reserves credit for it. */
export const DEFAULT_OUTPUT_CAP = 131072;
const APP_URL = 'https://github.com/qiz029/dscode';
const IMAGE_POLICY = Object.freeze({ maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 });

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

  /** Models that can drive an agent: text output and tool calls. */
  async listModels(provider) {
    await this.config.ensureModels();
    return listOpenRouterModels().filter(([, entry]) => entry.tools !== false && entry.textOutput !== false).map(([id, entry]) => modelInfo(provider, id, entry));
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

  async *stream(options) {
    const connection = this.config.options();
    const idle = new AbortController(), consumer = new AbortController();
    let timer;
    const pulse = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error('OpenRouter stream idle')), connection.streamIdleTimeoutMs);
      timer.unref?.();
    };
    const signal = AbortSignal.any([idle.signal, consumer.signal, ...(options.signal ? [options.signal] : [])]);
    try {
      const apiKey = await this.config.resolveApiKey(connection);
      await this.config.ensureModels();
      const entry = openRouterModel(options.model);
      pulse();
      const images = await this.prepareImages(options, entry, connection, signal);
      const body = requestBody(images?.options ?? options, { entry, images });
      const fetchImpl = this.config.fetch ?? globalThis.fetch;
      let response;
      try {
        response = await fetchImpl(`${connection.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...attributionHeaders(),
            'HTTP-Referer': APP_URL,
            'X-OpenRouter-Title': 'DSCODE',
            'X-OpenRouter-Categories': 'cli-agent',
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new LlmError(`OpenRouter request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
      }
      // A rejected request, or a 200 whose JSON body holds only an error.
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        const raw = await response.text();
        let error;
        try { error = JSON.parse(raw)?.error; } catch { /* not JSON */ }
        if (response.ok && error === undefined) throw new LlmError(`OpenRouter returned a non-stream response: ${raw.slice(0, 120)}`, 'MALFORMED_RESPONSE');
        const delay = retryAfterMs(response.headers.get('retry-after'));
        const status = response.ok ? (Number.isInteger(error?.code) ? error.code : undefined) : response.status;
        throw new LlmError(errorMessage(error, `OpenRouter API error (HTTP ${response.status})`), errorCode(response.ok ? undefined : response.status, error), {
          cause: new Error(raw.length > 0 ? raw : `OpenRouter HTTP ${response.status}`),
          ...(status === undefined ? {} : { status }),
          ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
        });
      }
      if (!response.body) throw new LlmError('OpenRouter returned no response body', 'EMPTY_RESPONSE');
      for await (const chunk of translate(sseData(response.body, pulse), { model: options.model })) {
        // The idle clock measures the provider, not a slow consumer.
        clearTimeout(timer);
        yield chunk;
        pulse();
      }
    } catch (error) {
      if (idle.signal.aborted && !options.signal?.aborted) throw new LlmError(`OpenRouter stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
      if (options.signal?.aborted) throw new LlmError('OpenRouter request aborted by caller', 'ABORTED', { cause: error });
      if (error instanceof LlmError) throw error;
      throw new LlmError(`OpenRouter API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
    } finally {
      clearTimeout(timer);
      consumer.abort('OpenRouter stream consumer stopped');
    }
  }

  /** Read request versions of every image, oldest beyond the byte budget replaced by text first. */
  async prepareImages(options, entry, connection, signal) {
    if (!options.messages.some(message => contentHasImage(message.content))) return undefined;
    if (!entry?.inputModalities?.includes('image')) throw new LlmError(`OpenRouter model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT');
    const attachments = this.config.resolveAttachments?.();
    if (attachments === undefined) throw new LlmError('OpenRouter image input requires the durable attachment service.', 'UNSUPPORTED_CONTENT');
    const access = ref => this.config.resolveImageAccess?.(attachments, ref);
    const bounded = policyBytes => offloadRequestImagesWithPolicy(policyBytes.messages, {
      representation: 'base64', maxBytes: connection.maxRequestImageBytes, byteQuantum: 1,
      byteLength: policyBytes.byteLength, placeholder: ref => offloadedImageText(ref, access(ref)),
    });
    const estimated = bounded({ messages: options.messages, byteLength: ref => Math.min(ref.bytes, IMAGE_POLICY.maxBytes) });
    const refs = new Map();
    for (const message of estimated) collectImages(message.content, refs);
    const versions = new Map(await Promise.all([...refs.values()].map(async ref => [ref.attachmentId, await attachments.readImageRequest(ref, IMAGE_POLICY, signal)])));
    const exact = bounded({ messages: estimated, byteLength: ref => versions.get(ref.attachmentId).bytes });
    return { options: { ...options, messages: [...exact] }, versions, access };
  }
}
