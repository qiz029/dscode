import { LlmError } from '@deepseek-ai/dsh-llm';
import { serializeMessages } from '../providers/chat-messages.mjs';
import { errorCode } from '../providers/http-errors.mjs';

export const REPLAY_KIND = 'dscode-custom';
const textOf = blocks => blocks.filter(b => b.type === 'text').map(b => b.text).join('');
const toolDefinitions = options => (options.tools ?? []).map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
function nativeReasoning(message, profile, model) {
  const source = message.source, replay = source?.replayState?.response;
  return source?.provider === profile.id && source.model === model && replay?.kind === REPLAY_KIND && replay.api === profile.api
    ? replay.nativeReasoning ?? [] : [];
}

export function requestBody(profile, model, options, images) {
  const budget = options.maxTokens ?? model.maxTokens ?? Math.min(4096, Math.floor(model.contextWindow / 4));
  const temperature = options.temperature === undefined ? {} : { temperature: options.temperature };
  const tools = toolDefinitions(options);
  const serialization = { model: model.id, images, dialect: { provider: profile.id, reasoningContent: () => false } };
  const effort = options.reasoningEffort;
  const thinking = effort === 'off' ? false : effort === 'high' ? true : model.thinking === 'off' ? false : model.thinking === 'on' ? true : undefined;
  if (effort !== undefined && !(profile.backend === 'omlx' && ['off', 'high'].includes(effort))) throw new LlmError('This custom model does not advertise that reasoning effort', 'UNSUPPORTED_REASONING_EFFORT');
  if (thinking !== undefined && profile.backend !== 'omlx') throw new LlmError('Thinking overrides currently require an identified oMLX service; use Server default', 'INVALID_REQUEST');
  const extra = thinking === undefined ? {} : profile.api === 'chat-completions' ? { enable_thinking: thinking } : { chat_template_kwargs: { enable_thinking: thinking } };
  const common = { model: model.id, stream: true, ...temperature, ...extra };
  if (profile.api === 'chat-completions') return { ...common,
    messages: serializeMessages(options.messages, { ...serialization, system: options.system }),
    max_tokens: budget, stream_options: { include_usage: true }, ...(tools.length ? { tools: tools.map(f => ({ type: 'function', function: f })) } : {}), ...(options.stop ? { stop: options.stop } : {}) };

  // Stateless replay: the local session remains authoritative, including native
  // reasoning items/signatures when the same endpoint protocol produced them.
  const input = [], anthropic = [];
  const system = [options.system, ...options.messages.filter(m => m.role === 'system').map(m => textOf(m.content))].filter(Boolean).join('\n\n');
  for (const message of options.messages.filter(m => m.role !== 'system')) {
    const native = nativeReasoning(message, profile, model.id);
    if (profile.api === 'responses') input.push(...native);
    const parts = [];
    if (profile.api === 'anthropic' && message.role === 'assistant') parts.push(...native);
    for (const wire of serializeMessages([message], serialization)) {
      if (wire.role === 'tool') {
        input.push({ type: 'function_call_output', call_id: wire.tool_call_id, output: wire.content });
        parts.push({ type: 'tool_result', tool_use_id: wire.tool_call_id, content: wire.content,
          ...(message.role === 'tool' && message.isError ? { is_error: true } : {}) });
      } else {
        if (wire.content) {
          const content = typeof wire.content === 'string' ? [{ type: 'text', text: wire.content }] : wire.content;
          if (profile.api === 'responses') input.push({ role: wire.role, content: content.map(part => part.type === 'text'
            ? { type: wire.role === 'assistant' ? 'output_text' : 'input_text', text: part.text }
            : { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }) });
          else for (const part of content) {
            if (part.type === 'text') parts.push(part);
            else {
              // The shared serializer creates data URLs from prepared attachment bytes.
              const [, mediaType, data] = /^data:([^;]+);base64,(.*)$/.exec(part.image_url.url);
              parts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
            }
          }
        }
        for (const call of wire.tool_calls ?? []) {
          input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
          let args;
          try { args = JSON.parse(call.function.arguments); } catch { throw new LlmError('Cannot replay invalid tool arguments', 'INVALID_REQUEST'); }
          parts.push({ type: 'tool_use', id: call.id, name: call.function.name, input: args });
        }
      }
    }
    if (parts.length) {
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      if (anthropic.at(-1)?.role === role) anthropic.at(-1).content.push(...parts);
      else anthropic.push({ role, content: parts });
    }
  }
  if (profile.api === 'responses') return { ...common, input, ...(system ? { instructions: system } : {}), max_output_tokens: budget, store: false, include: ['reasoning.encrypted_content'], ...(tools.length ? { tools: tools.map(t => ({ type: 'function', ...t })) } : {}) };
  // Native parallel tool results arrive as separate messages. After merging
  // their user turns, all results must precede accompanying text and screenshots.
  for (const message of anthropic) if (message.role === 'user') {
    message.content = [...message.content.filter(p => p.type === 'tool_result'), ...message.content.filter(p => p.type !== 'tool_result')];
  }
  return { ...common, messages: anthropic, ...(system ? { system } : {}), max_tokens: budget, ...(tools.length ? { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}), ...(options.stop ? { stop_sequences: options.stop } : {}) };
}

const delta = (value, extra = {}) => JSON.stringify({ choices: [{ index: 0, delta: value }], ...extra });
const toolDelta = (index, id, name, args = '') => delta({ tool_calls: [{ index, ...(id ? { id } : {}), function: { ...(name ? { name } : {}), arguments: args } }] });
function responseUsage(u) {
  return u && { prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens, prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 }, completion_tokens_details: { reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0 } };
}
function anthropicUsage(u) {
  return { prompt_tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), completion_tokens: u.output_tokens ?? 0,
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0, cache_write_tokens: u.cache_creation_input_tokens ?? 0 } };
}

/** Normalize the two event protocols to the shared chat stream assembler. */
export async function* normalizedEvents(payloads, api, replay) {
  if (api === 'chat-completions') { yield* payloads; return; }
  let usage = {}, finish = 'stop';
  const blocks = new Map(), emitted = new Set(), native = new Map();
  for await (const raw of payloads) {
    if (raw === '[DONE]') continue;
    let event;
    try { event = JSON.parse(raw); } catch { throw new LlmError('Malformed custom API stream event', 'MALFORMED_RESPONSE'); }
    if (event.error || event.type === 'error' || event.type === 'response.failed') {
      const error = event.error ?? event.response?.error;
      throw new LlmError('Custom API returned an error during streaming', errorCode(undefined, { ...error, metadata: { error_type: error?.code ?? error?.type } }));
    }
    if (event.type === 'response.refusal.delta') throw new LlmError('Custom model declined this request', 'CONTENT_FILTER');
    if (api === 'responses') {
      const i = event.output_index ?? 0;
      if (event.type === 'response.output_item.added') {
        blocks.set(i, event.item);
        if (event.item?.type === 'function_call') yield toolDelta(i, event.item.call_id, event.item.name);
      } else if (event.type === 'response.output_text.delta') {
        emitted.add(`text:${i}`); yield delta({ content: event.delta });
      } else if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
        emitted.add(`reasoning:${i}`); yield delta({ reasoning_content: event.delta });
      } else if (event.type === 'response.function_call_arguments.delta') {
        emitted.add(`args:${i}`); yield toolDelta(i, undefined, undefined, event.delta);
      } else if (event.type === 'response.output_item.done') {
        blocks.set(i, event.item);
        if (event.item?.type === 'reasoning') native.set(i, event.item);
      }
      if (['response.completed', 'response.incomplete'].includes(event.type)) {
        const response = event.response;
        if (!response || response.status === 'failed') throw new LlmError('Custom response failed', 'TRANSPORT');
        const items = response.output ?? [...blocks.values()];
        for (const [index, item] of items.entries()) {
          if (item.type === 'function_call' && !emitted.has(`args:${index}`)) yield toolDelta(index, item.call_id, item.name, item.arguments ?? '{}');
          if (item.type === 'message' && !emitted.has(`text:${index}`)) {
            const text = (item.content ?? []).map(b => b.text ?? '').join('');
            if (text) yield delta({ content: text });
          }
          if (item.type === 'reasoning') {
            native.set(index, item);
            if (!emitted.has(`reasoning:${index}`)) {
              const text = (item.summary ?? []).map(b => b.text ?? '').join('');
              if (text) yield delta({ reasoning_content: text });
            }
          }
        }
        replay.nativeReasoning = [...native.values()];
        const incomplete = response.incomplete_details?.reason;
        finish = event.type === 'response.incomplete' ? incomplete === 'max_output_tokens' ? 'length' : 'content_filter' : 'stop';
        yield JSON.stringify({ id: response.id, choices: [{ delta: {}, finish_reason: finish }], usage: responseUsage(response.usage) });
        yield '[DONE]'; return;
      }
    } else {
      if (event.type === 'message_start') { usage = { ...event.message?.usage }; yield delta({}, { id: event.message?.id }); }
      if (event.type === 'content_block_start') {
        const b = { ...event.content_block }; blocks.set(event.index, b);
        if (b.type === 'tool_use') yield toolDelta(event.index, b.id, b.name);
        if (b.type === 'text' && b.text) yield delta({ content: b.text });
        if (b.type === 'thinking' || b.type === 'redacted_thinking') {
          native.set(event.index, b);
          if (b.thinking) yield delta({ reasoning_content: b.thinking });
        }
      }
      if (event.type === 'content_block_delta') {
        const d = event.delta, b = blocks.get(event.index);
        if (d.type === 'text_delta') yield delta({ content: d.text });
        if (d.type === 'input_json_delta') { emitted.add(`args:${event.index}`); yield toolDelta(event.index, undefined, undefined, d.partial_json); }
        if (d.type === 'thinking_delta') { if (b) b.thinking = (b.thinking ?? '') + d.thinking; yield delta({ reasoning_content: d.thinking }); }
        if (d.type === 'signature_delta' && b) b.signature = (b.signature ?? '') + d.signature;
      }
      if (event.type === 'content_block_stop') {
        const b = blocks.get(event.index);
        if (b?.type === 'tool_use' && !emitted.has(`args:${event.index}`)) yield toolDelta(event.index, undefined, undefined, JSON.stringify(b.input ?? {}));
      }
      if (event.type === 'message_delta') {
        usage = { ...usage, ...event.usage };
        const reason = event.delta?.stop_reason;
        finish = reason === 'max_tokens' ? 'length' : reason === 'tool_use' ? 'tool_calls' : ['end_turn', 'stop_sequence', null, undefined].includes(reason) ? 'stop' : reason;
      }
      if (event.type === 'message_stop') {
        replay.nativeReasoning = [...native.values()];
        yield JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }], usage: anthropicUsage(usage) });
        yield '[DONE]'; return;
      }
    }
  }
  throw new LlmError('Custom API stream ended before its terminal event', 'TRANSPORT');
}
