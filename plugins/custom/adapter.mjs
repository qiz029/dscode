import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders } from '@deepseek-ai/dsh-llm';
import { isAttachmentError } from '@deepseek-ai/dsh-attachment';
import { sseData, translate } from '../providers/chat-stream.mjs';
import { errorCode, retryAfterMs } from '../providers/http-errors.mjs';
import { endpoint } from './config.mjs';
import { normalizedEvents, requestBody, REPLAY_KIND } from './wire.mjs';
import { prepareImages } from './images.mjs';

export function authHeaders(profile, key) {
  if (profile.auth !== 'none' && !key) throw new LlmError('Custom provider needs an API key; edit it in /provider → Custom', 'MISSING_CREDENTIAL');
  return { ...(profile.api === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
    ...(profile.auth === 'none' ? {} : profile.auth === 'x-api-key' ? { 'x-api-key': key } : { authorization: `Bearer ${key}` }) };
}

/** One request per service in this Host. Background calls queue behind foreground work. */
class RequestQueue {
  busy = false;
  waiting = [];
  async acquire(signal, background) {
    signal?.throwIfAborted();
    if (!this.busy) { this.busy = true; return () => this.release(); }
    await new Promise((resolve, reject) => {
      const item = { resolve, background };
      const abort = () => { this.waiting = this.waiting.filter(x => x !== item); reject(signal.reason); };
      item.resolve = () => { signal?.removeEventListener('abort', abort); resolve(); };
      signal?.addEventListener('abort', abort, { once: true });
      this.waiting.push(item);
    });
    return () => this.release();
  }
  release() {
    if (!this.waiting.length) { this.busy = false; return; }
    const foreground = this.waiting.findIndex(x => !x.background);
    this.waiting.splice(foreground < 0 ? 0 : foreground, 1)[0].resolve();
  }
}

export class CustomAdapter extends LlmAdapter {
  constructor({ profile, resolveKey, resolveAttachments, resolveImageAccess, fetch = globalThis.fetch }) {
    super(); this.profile = profile; this.resolveKey = resolveKey; this.fetch = fetch; this.queues = new Map();
    this.resolveAttachments = resolveAttachments; this.resolveImageAccess = resolveImageAccess;
  }
  providerInfo(provider) { return { id: provider, name: this.profile(provider)?.name ?? provider }; }
  async listModels(provider) {
    return (this.profile(provider)?.models ?? []).filter(m => m.contextWindow).map(m => ({ provider, id: m.id, name: m.name, inputModalities: [...(m.inputModalities ?? ['text'])] }));
  }
  async resolveModel(provider, id) {
    const p = this.profile(provider), m = p?.models.find(m => m.id === id);
    if (!m?.contextWindow) throw new LlmError('Custom model is missing or has no context window; edit it in /provider → Custom', 'INVALID_REQUEST');
    return { provider, id, name: m.name, inputModalities: [...(m.inputModalities ?? ['text'])], context: { contextWindow: m.contextWindow },
      defaultMaxTokens: m.maxTokens ?? Math.min(4096, Math.floor(m.contextWindow / 4)),
      ...(p.backend === 'omlx' ? { reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'On' }], ...(m.thinking !== 'default' ? { defaultEffort: ReasoningEffortId(m.thinking === 'off' ? 'off' : 'high') } : {}) } } : {}) };
  }
  async *stream(options) {
    const profile = this.profile(options.provider);
    const model = profile?.models.find(m => m.id === options.model);
    if (!model?.contextWindow) throw new LlmError('Configure this custom model and its context window first', 'INVALID_REQUEST');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let timer, release, timedOut = false;
    const pulse = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, profile.timeoutMs); timer.unref?.(); };
    try {
      let queue = this.queues.get(profile.id);
      if (!queue) { queue = new RequestQueue(); this.queues.set(profile.id, queue); }
      release = await queue.acquire(signal, ['session-title', 'session-card', 'compaction'].includes(options.purpose));
      signal.throwIfAborted();
      const key = await this.resolveKey(profile);
      const attachments = this.resolveAttachments?.();
      const images = await prepareImages(options.messages, model, attachments, ref => attachments && this.resolveImageAccess?.(attachments, ref), signal);
      signal.throwIfAborted();
      const body = requestBody(profile, model, { ...options, messages: images.messages }, images);
      pulse();
      const response = await this.fetch(endpoint(profile), { method: 'POST', redirect: 'error', headers: { ...attributionHeaders(), ...authHeaders(profile, key), 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), signal });
      if (!response.ok) {
        // Inspect the error only to classify context overflow/rate limits. Never
        // attach the raw response: gateways sometimes echo their request headers.
        const raw = await response.text();
        let detail;
        try { detail = JSON.parse(raw)?.error; } catch { /* status still classifies non-JSON errors */ }
        const delay = retryAfterMs(response.headers.get('retry-after'));
        throw new LlmError(`Custom API returned HTTP ${response.status}`, errorCode(response.status, detail), { status: response.status, ...(delay ? { providerRetryAfterMs: delay } : {}) });
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new LlmError('Custom API did not return an SSE stream', 'MALFORMED_RESPONSE');
      }
      const replay = {};
      const events = normalizedEvents(sseData(response.body, pulse), profile.api, replay);
      for await (const chunk of translate(events, { model: model.id, kind: REPLAY_KIND, label: profile.name })) {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          try { const args = JSON.parse(chunk.block.arguments); if (!args || typeof args !== 'object' || Array.isArray(args) || !chunk.block.id || !chunk.block.name) throw Error(); }
          catch { throw new LlmError('Custom model returned an invalid tool call', 'MALFORMED_RESPONSE'); }
        }
        if (chunk.type === 'finish' && chunk.replayState) Object.assign(chunk.replayState.response, { api: profile.api, ...replay });
        clearTimeout(timer); yield chunk; pulse();
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('Custom request cancelled', 'ABORTED');
      if (timedOut) throw new LlmError(`Custom API idle timeout after ${profile.timeoutMs}ms; the model may still be loading`, 'TIMEOUT');
      if (isAttachmentError(error)) throw new LlmError(`Custom image input failed: ${error.code}`, error.code);
      // Never reflect a server response or transport error that might contain credentials.
      if (error instanceof LlmError) throw new LlmError(error.code === 'MISSING_CREDENTIAL' ? error.message : `Custom request failed: ${error.code}`, error.code, {
        ...(error.failure?.status ? { status: error.failure.status } : {}),
        ...(error.failure?.providerRetryAfterMs ? { providerRetryAfterMs: error.failure.providerRetryAfterMs } : {}),
        ...(error.failure?.offloadImages ? { offloadImages: error.failure.offloadImages } : {}),
      });
      throw new LlmError('Could not connect to the custom API', 'TRANSPORT');
    } finally { clearTimeout(timer); controller.abort(); release?.(); }
  }
}
