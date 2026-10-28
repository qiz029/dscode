import { createHash } from 'node:crypto';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { requestBody as messagesBody } from '../custom/wire.mjs';

export const REPLAY_KIND = 'dscode-minimax';
const isThinking = block => ['thinking', 'redacted_thinking'].includes(block.type);

export function prefixHash(body, messages = body.messages) {
  return createHash('sha256').update(JSON.stringify({ system: body.system, tools: body.tools,
    messages })).digest('hex');
}

export function requestBody(options, model, images, account, serviceTier = 'standard') {
  const effort = options.reasoningEffort ?? model.defaultEffort;
  if (effort !== undefined && !model.efforts.includes(effort)) {
    throw new LlmError('Unsupported MiniMax reasoning effort', 'UNSUPPORTED_REASONING_EFFORT');
  }
  const body = messagesBody({ id: 'minimax', api: 'anthropic', replayKind: REPLAY_KIND }, model,
    { ...options, reasoningEffort: undefined, temperature: undefined }, images);
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > model.maxOutputTokens) {
    throw new LlmError('MiniMax output budget must be between 1 and 524288 tokens', 'INVALID_REQUEST');
  }
  const sources = options.messages.filter(message => message.role === 'assistant');
  let assistant = 0;
  for (let index = 0; index < body.messages.length; index++) {
    const message = body.messages[index];
    if (message.role !== 'assistant') continue;
    const source = sources[assistant++]?.source, replay = source?.replayState?.response;
    const invalid = source?.provider !== 'minimax' || source.model !== model.id || replay?.account !== account
      || replay?.requestPrefix !== prefixHash(body, body.messages.slice(0, index));
    if (invalid) message.content = message.content.filter(block => !isThinking(block));
  }
  body.messages = body.messages.filter(message => message.content.length);
  if (model.thinking === 'adaptive') return { ...body, thinking: { type: 'adaptive' }, output_config: { effort } };
  return { ...body, ...(model.serviceTier ? { service_tier: serviceTier } : {}) };
}
