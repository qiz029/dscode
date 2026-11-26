import { createHash } from 'node:crypto';
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import { isAttachmentError } from '@deepseek-ai/dsh-attachment';
import { prepareImages } from '../custom/images.mjs';
import { normalizedEvents } from '../custom/wire.mjs';
import { sseData, translate } from '../providers/chat-stream.mjs';
import { errorCode, retryAfterMs } from '../providers/http-errors.mjs';
import { MODELS, getModel } from './models.mjs';
import { prefixHash, requestBody, REPLAY_KIND } from './wire.mjs';

export class MiniMaxAdapter extends LlmAdapter {
  constructor(config) { super(); this.config = config; }
  providerInfo(provider) { return { id: provider, name: 'MiniMax' }; }
  providerRetryPolicy() { return this.config.options().retryPolicy; }
  async listModels(provider) { return MODELS.map(({ id, name, inputModalities }) => ({ provider, id, name, inputModalities })); }
  async resolveModel(provider, id) {
    const model = getModel(id), reasoning = model.efforts.length ? { efforts: model.efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
      defaultEffort: ReasoningEffortId(model.defaultEffort) } : undefined;
    return { provider, id, name: model.name, context: { contextWindow: model.contextWindow }, defaultMaxTokens: model.maxTokens,
      inputModalities: model.inputModalities, ...(reasoning ? { reasoning } : {}) };
  }
  async *stream(options) {
    const settings = this.config.options(), model = getModel(options.model), controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
    let timer, timedOut = false;
    const pulse = () => { clearTimeout(timer); timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.streamIdleTimeoutMs); timer.unref?.(); };
    try {
      signal.throwIfAborted();
      const key = await this.config.resolveApiKey(settings);
      const account = createHash('sha256').update(key).digest('hex');
      const attachments = this.config.resolveAttachments?.();
      const images = await prepareImages(options.messages, model, attachments, ref => attachments && this.config.resolveImageAccess?.(attachments, ref), signal);
      const body = requestBody({ ...options, messages: images.messages }, model, images, account, settings.serviceTier);
      signal.throwIfAborted(); pulse();
      const response = await (this.config.fetch ?? globalThis.fetch)(settings.baseURL + '/v1/messages', {
        method: 'POST', redirect: 'error', signal, body: JSON.stringify(body),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      });
      if (!response.ok) {
        let detail; try { detail = (await response.json())?.error; } catch { /* Classify by status. */ }
        const delay = retryAfterMs(response.headers.get('retry-after'));
        throw new LlmError(`MiniMax API returned HTTP ${response.status}`, errorCode(response.status, detail),
          { status: response.status, ...(delay ? { providerRetryAfterMs: delay } : {}) });
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel(); throw new LlmError('MiniMax did not return an SSE stream', 'MALFORMED_RESPONSE');
      }
      const replay = {};
      for await (const chunk of translate(normalizedEvents(sseData(response.body, pulse), 'anthropic', replay, true), { model: model.id, kind: REPLAY_KIND, label: 'MiniMax' })) {
        signal.throwIfAborted();
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          let args; try { args = JSON.parse(chunk.block.arguments); } catch { /* Rejected below. */ }
          if (!args || typeof args !== 'object' || Array.isArray(args) || !chunk.block.id || !chunk.block.name) throw new LlmError('Invalid MiniMax tool call', 'MALFORMED_RESPONSE');
        }
        if (chunk.type === 'finish' && chunk.replayState) Object.assign(chunk.replayState.response,
          { nativeContent: replay.nativeContent, requestPrefix: prefixHash(body), account });
        clearTimeout(timer); yield chunk; pulse();
      }
    } catch (error) {
      if (options.signal?.aborted) throw new LlmError('MiniMax request cancelled', 'ABORTED');
      if (timedOut) throw new LlmError('MiniMax request timed out', 'TIMEOUT');
      if (isAttachmentError(error)) throw new LlmError('MiniMax image input failed: ' + error.code, error.code);
      if (error instanceof LlmError) throw error;
      throw new LlmError('Could not complete the MiniMax request', 'TRANSPORT');
    } finally { clearTimeout(timer); controller.abort(); }
  }
}
