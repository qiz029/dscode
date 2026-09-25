import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, QUOTA_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm';
import { OPENROUTER_EFFORTS } from '../providers/catalog.mjs';
import { ultraRequest } from '../ultra/policy.mjs';

// OpenRouter chat completions on the wire: request bodies, the SSE stream, and
// the translation into harness stream chunks. Pure functions; the adapter owns I/O.

export const PROVIDER = 'openrouter';
/** `replayState.response.kind` for responses this adapter produced. */
export const REPLAY_KIND = 'dscode-openrouter';
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';
// OpenRouter serves DeepSeek V4 thinking as none/high/xhigh; the route keeps the
// official off/low/high/max detents (and Ultra on max) with the spelling it accepts.
const DEEPSEEK_WIRE = Object.freeze({ ...OPENROUTER_EFFORTS, ultra: OPENROUTER_EFFORTS.max });
const DEEPSEEK_V4 = /^deepseek\/deepseek-v4/;
// Models whose provider rejects an assistant tool-call turn without `reasoning_content`.
// MiMo needs it too: Xiaomi's API answers 400 Invalid Format when thinking mode is not passed back.
const REASONING_CONTENT_MODELS = /^(?:deepseek\/deepseek-v4|moonshotai\/kimi-k2\.6|xiaomi\/mimo-v2\.6)/;
// Alibaba caches only at explicit breakpoints.
const EXPLICIT_CACHE_MODELS = /^qwen\//;
const DEFAULT_LEVELS = ['low', 'medium', 'high'];
// OpenRouter picks the upstream endpoint, but only among endpoints that honour every
// request parameter (by default it silently drops unsupported ones) and that do not
// serve fp4-quantized weights. INT4 stays: Kimi ships native INT4 weights.
const ROUTING = Object.freeze({ require_parameters: true, quantizations: Object.freeze(['int4', 'int8', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown']) });
const NAMES = { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
export const ULTRA_DESCRIPTION = 'DSCODE: max reasoning plus deliberate subagent collaboration; higher total token use.';

/**
 * Reasoning controls a model offers through this route.
 * @param model - OpenRouter model id.
 * @param entry - the model's listing entry, if any.
 * @returns `{ levels, defaultEffort?, wire }` with harness effort ids and their wire
 *   spelling, or undefined when the model has no reasoning control.
 */
export function modelReasoning(model, entry) {
  if (DEEPSEEK_V4.test(model)) return { levels: ['off', 'low', 'high', 'max', 'ultra'], defaultEffort: 'high', wire: DEEPSEEK_WIRE };
  const reasoning = entry?.reasoning;
  if (!reasoning) return undefined;
  // No allowlist means OpenRouter maps any standard level; offer the common three.
  const levels = reasoning.efforts ?? DEFAULT_LEVELS;
  const ultra = levels.includes('max');
  const wire = Object.fromEntries([...(reasoning.mandatory ? [] : [['off', 'none']]), ...levels.map(level => [level, level]), ...(ultra ? [['ultra', 'max']] : [])]);
  // Like the official route, requests default to high; a model without high keeps its own default.
  const defaultEffort = levels.includes('high') ? 'high' : levels.includes(reasoning.defaultEffort) ? reasoning.defaultEffort : undefined;
  return { levels: Object.keys(wire), ...(defaultEffort ? { defaultEffort } : {}), wire };
}

/** Display metadata for one harness effort id. */
export function effortInfo(id) {
  return { id, name: NAMES[id] ?? id, ...(id === 'ultra' ? { description: ULTRA_DESCRIPTION } : {}) };
}

/** A title needs no deliberation: reasoning off when the model allows it, else its lowest level. */
function titleEffort(reasoning) {
  return reasoning.wire.off !== undefined ? 'off' : reasoning.levels.find(level => level !== 'ultra');
}

const textOf = blocks => blocks.filter(block => block.type === 'text').map(block => block.text).join('');

function contentParts(blocks, images) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.length > 0) parts.push({ type: 'text', text: block.text });
    else if (block.type === 'image') {
      const version = images?.versions.get(block.attachment.attachmentId);
      if (version === undefined) { parts.push({ type: 'text', text: textOnlyImageText(block.attachment) }); continue; }
      parts.push({ type: 'text', text: requestImageHandleText(block.attachment, version, images.access?.(block.attachment)) });
      parts.push({ type: 'image_url', image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` } });
    }
  }
  return parts;
}

const collapse = parts => parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('') : parts;

/** Reasoning details this adapter (or the pi-ai adapter before it) stored for a same-model replay. */
function replayedDetails(message) {
  const blocks = message.source?.replayState?.blocks;
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) return [];
  const details = [];
  blocks.forEach((block, index) => {
    if (message.content[index]?.type !== 'reasoning') return;
    if (Array.isArray(block?.reasoningDetails)) details.push(...block.reasoningDetails);
    else if (typeof block?.thinkingSignature === 'string') {
      try {
        const parsed = JSON.parse(block.thinkingSignature);
        if (Array.isArray(parsed)) details.push(...parsed);
      } catch { /* a plain field-name signature carries no details */ }
    }
  });
  return details;
}

function serializeAssistant(message, model, dialect) {
  const text = textOf(message.content);
  const calls = message.content.filter(block => block.type === 'tool-call')
    .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }));
  // An empty assistant turn (reasoning only) has nothing a provider accepts.
  if (text.length === 0 && calls.length === 0) return undefined;
  // Reasoning replays only to the model that produced it.
  const sameModel = message.source?.provider === dialect.provider && message.source?.model === model;
  const reasoning = sameModel ? message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('') : '';
  if (dialect.reasoningContent !== undefined) {
    // A pass-through route speaks the upstream's own field: the reasoning text itself, or an
    // empty one for models that reject a tool-call turn without it.
    const field = reasoning.length > 0 ? reasoning : dialect.reasoningContent(model) ? '' : undefined;
    return { role: 'assistant', content: text, ...(calls.length > 0 ? { tool_calls: calls } : {}), ...(field !== undefined ? { reasoning_content: field } : {}) };
  }
  const details = sameModel ? replayedDetails(message) : [];
  return {
    role: 'assistant',
    content: text,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(details.length > 0 ? { reasoning_details: details } : reasoning.length > 0 ? { reasoning } : {}),
    ...(REASONING_CONTENT_MODELS.test(model) ? { reasoning_content: '' } : {}),
  };
}

/**
 * Harness history as OpenRouter chat messages. Each tool result becomes a `tool`
 * message; its images follow in one user message, which `tool` content cannot carry.
 * @param images - prepared request images (`versions` by attachment id, `access`), when the request has any.
 * @param dialect - another chat-completions route reusing this serializer: its `provider` id (whose
 *   reasoning replays), and `reasoningContent(model)` to replay reasoning as `reasoning_content`.
 */
export function serializeMessages(messages, { model, system, images, dialect = { provider: PROVIDER } } = {}) {
  const wire = [];
  if (system !== undefined && system.length > 0) wire.push({ role: 'system', content: system });
  let pendingImages = [];
  const flush = () => {
    if (pendingImages.length === 0) return;
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingImages] });
    pendingImages = [];
  };
  for (const message of messages) {
    if (message.role === 'system') {
      flush();
      const text = textOf(message.content);
      if (text.length > 0) wire.push({ role: 'system', content: text });
      continue;
    }
    if (message.role === 'assistant') {
      flush();
      const entry = serializeAssistant(message, model, dialect);
      if (entry) wire.push(entry);
      continue;
    }
    const results = message.content.filter(block => block.type === 'tool-result');
    const parts = contentParts(message.content.filter(block => block.type !== 'tool-result'), images);
    if (parts.length > 0 || results.length === 0) {
      flush();
      wire.push({ role: 'user', content: collapse(parts) });
    }
    for (const result of results) {
      const nested = contentParts(result.content, images);
      const text = nested.filter(part => part.type === 'text').map(part => part.text).join('');
      const attached = nested.filter(part => part.type !== 'text');
      wire.push({ role: 'tool', tool_call_id: result.toolCallId, content: text || (attached.length > 0 ? '(see attached image)' : '(no output)') });
      pendingImages.push(...attached);
    }
  }
  flush();
  return wire;
}

const cacheMarked = content => typeof content === 'string'
  ? [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }]
  : content.map((part, index) => index === content.findLastIndex(candidate => candidate.type === 'text') ? { ...part, cache_control: { type: 'ephemeral' } } : part);

/** Explicit cache breakpoints for models that cache only at them: the system prompt and the latest user turn. */
export function withCacheBreakpoints(messages, model) {
  if (!EXPLICIT_CACHE_MODELS.test(model)) return messages;
  const targets = new Set([messages.findIndex(message => message.role === 'system'), messages.findLastIndex(message => message.role === 'user')]);
  return messages.map((message, index) => targets.has(index) && message.content !== '' ? { ...message, content: cacheMarked(message.content) } : message);
}

/**
 * The chat-completions body for one harness request.
 * @param options - harness request (images already prepared into `images`).
 * @param context - `{ entry, images }`: the model's listing entry and prepared request images.
 */
export function requestBody(options, { entry, images } = {}) {
  const reasoning = modelReasoning(options.model, entry);
  const effort = options.purpose === 'session-title' && reasoning ? titleEffort(reasoning) : options.reasoningEffort;
  const wireEffort = effort === undefined ? undefined : reasoning?.wire[effort];
  if (effort !== undefined && reasoning !== undefined && wireEffort === undefined) {
    throw new LlmError(`OpenRouter model "${options.model}" does not offer reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT');
  }
  let messages = serializeMessages(options.messages, { model: options.model, system: options.system, images });
  messages = withCacheBreakpoints(ultraRequest(options, messages), options.model);
  // Delegation tools are offered at every effort; workflow and ralph never are.
  const tools = (options.tools ?? []).filter(tool => tool.name !== 'workflow' && tool.name !== 'ralph')
    .map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  return {
    model: options.model,
    messages,
    stream: true,
    ...(tools.length > 0 ? { tools } : {}),
    ...(wireEffort !== undefined ? { reasoning: { effort: wireEffort } } : {}),
    // Endpoints declare `max_tokens`; `max_completion_tokens` would fail `require_parameters` almost everywhere.
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
    // The sticky-routing key: one session keeps one upstream endpoint and its warm cache.
    ...(options.sessionId !== undefined ? { session_id: String(options.sessionId).slice(0, 256) } : {}),
    provider: { require_parameters: ROUTING.require_parameters, quantizations: [...ROUTING.quantizations] },
  };
}

// OpenRouter's typed `metadata.error_type`, which it asks clients to route on before the status.
const ERROR_TYPES = Object.freeze({
  context_length_exceeded: CONTEXT_WINDOW_EXCEEDED_CODE, token_limit_exceeded: CONTEXT_WINDOW_EXCEEDED_CODE,
  payment_required: QUOTA_EXCEEDED_CODE, authentication: 'AUTH', permission_denied: 'AUTH',
  rate_limit_exceeded: 'RATE_LIMIT', provider_overloaded: 'SERVER', provider_unavailable: 'SERVER', server: 'SERVER', unmapped: 'SERVER',
  timeout: 'TIMEOUT', content_policy_violation: 'CONTENT_POLICY', refusal: 'CONTENT_POLICY',
});

/**
 * Harness failure code for an OpenRouter error.
 * @param status - HTTP status of a rejected request, or undefined for an error inside a 200 stream.
 * @param error - the `error` object (`code`, `message`, `metadata`).
 */
export function errorCode(status, error) {
  const type = error?.metadata?.error_type;
  if (typeof type === 'string' && Object.hasOwn(ERROR_TYPES, type)) return ERROR_TYPES[type];
  const code = Number.isInteger(status) ? status : Number(error?.code);
  // A 402 names token counts ("fewer max_tokens"); its status decides before any wording does.
  if (code === 402) return QUOTA_EXCEEDED_CODE;
  // OpenRouter can reject a replay before generation without typed metadata.
  // Keep this narrow: an ordinary permission-denied 403 still means AUTH.
  if (code === 403 && typeof error?.message === 'string' && /^Request blocked by content filter\b/i.test(error.message)) return 'CONTENT_POLICY';
  const detail = [error?.message, error?.metadata?.raw].filter(value => typeof value === 'string').join(' ');
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (code === 401 || code === 403) return 'AUTH';
  if (code === 429) return 'RATE_LIMIT';
  if (code === 408 || code === 504) return 'TIMEOUT';
  if (code >= 500) return 'SERVER';
  if (code >= 400) return 'INVALID_REQUEST';
  // A stream that failed after its 200 without a numeric code is an upstream failure worth retrying.
  return 'SERVER';
}

/** Human-readable message for an OpenRouter error object. */
export function errorMessage(error, fallback) {
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : fallback;
  const provider = error?.metadata?.provider_name;
  return typeof provider === 'string' && provider.length > 0 ? `${message} (provider: ${provider})` : message;
}

/** Retry-After as milliseconds (seconds or an HTTP date), when valid. */
export function retryAfterMs(value) {
  if (value === null || value === undefined) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1e3 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/**
 * SSE `data:` payloads from a response body, skipping `:` keep-alive comments.
 * @param onActivity - called for every received chunk, comments included.
 */
export async function* sseData(body, onActivity) {
  const decoder = new TextDecoder();
  let buffer = '', data = [];
  const lines = function* (final) {
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0 || final && buffer.length > 0) {
      let line = newline >= 0 ? buffer.slice(0, newline) : buffer;
      buffer = newline >= 0 ? buffer.slice(newline + 1) : '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        // A bare `data:` line assembles to whitespace; the SSE spec reads it as a newline, but every consumer here parses JSON.
        const payload = data.join('\n');
        if (payload.trim() !== '') yield payload;
        data = [];
      } else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
    }
  };
  for await (const chunk of body) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });
    yield* lines(false);
  }
  buffer += decoder.decode();
  yield* lines(true);
  const tail = data.join('\n');
  if (tail.trim() !== '') yield tail;
}

/** Map OpenRouter usage to disjoint harness counts (`prompt_tokens` includes cache reads and writes). */
export function mapUsage(usage) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const prompt = usage?.prompt_tokens, completion = usage?.completion_tokens;
  if (!valid(prompt) || !valid(completion)) return undefined;
  const read = valid(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : 0;
  const write = valid(usage.prompt_tokens_details?.cache_write_tokens) ? usage.prompt_tokens_details.cache_write_tokens : 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Math.max(0, prompt - read - write),
    outputTokens: completion,
    ...(usage.total_tokens === undefined || usage.total_tokens === prompt + completion ? { totalTokens: prompt + completion } : {}),
    ...(read > 0 ? { cacheReadTokens: read } : {}),
    ...(write > 0 ? { cacheWriteTokens: write } : {}),
    ...(valid(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** Streamed reasoning details merged into the blocks a replay sends back unmodified. */
function mergeDetails(items) {
  const merged = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const last = merged.at(-1);
    if (last && last.type === item.type && item.type !== 'reasoning.encrypted' && (last.index ?? 0) === (item.index ?? 0)) {
      if (typeof item.text === 'string') last.text = (last.text ?? '') + item.text;
      if (typeof item.summary === 'string') last.summary = (last.summary ?? '') + item.summary;
      for (const key of ['id', 'format', 'signature']) if (item[key] !== undefined && item[key] !== null && item[key] !== '') last[key] = item[key];
    } else merged.push({ ...item });
  }
  return merged;
}

function closeBlock(block) {
  if (block.kind === 'tool-call') return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text };
  return { type: block.kind, text: block.text };
}

function finishReason(reason, blocks, label) {
  if (reason === 'length') return { kind: 'max-tokens' };
  if (reason === 'content_filter') return { kind: 'error', failure: { message: `${label} stopped the response for content filtering`, code: 'CONTENT_FILTER' } };
  if (reason === 'tool_calls' || blocks.some(block => block.kind === 'tool-call') && (reason === undefined || reason === 'stop')) return { kind: 'tool-calls' };
  if (reason === undefined || reason === null || reason === 'stop' || reason === 'end') {
    return blocks.length === 0 ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } } : { kind: 'stop' };
  }
  return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } };
}

/**
 * Translate SSE payloads into harness chunks. Block ends, usage and the finish are
 * held until `[DONE]`; the finish of a successful response carries the replay state:
 * reasoning details per block, the generation id, the serving provider and the billed cost.
 * An error inside the stream throws with its routed code.
 * @param kind - the replay kind stamped on the response; `label` names the route in errors.
 */
export async function* translate(payloads, { model, kind = REPLAY_KIND, label = 'OpenRouter' }) {
  let nextIndex = 0, textBlock, reasoningBlock, finish, usage, cost, id, provider;
  const tools = new Map();
  const order = [];
  const open = kind => {
    const block = { index: nextIndex++, kind, text: '', details: [] };
    order.push(block);
    return block;
  };
  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) };
      if (usage) yield { type: 'usage', usage };
      const reason = finishReason(finish, order, label);
      const succeeded = reason.kind === 'stop' || reason.kind === 'tool-calls' || reason.kind === 'max-tokens';
      yield {
        type: 'finish', reason,
        ...(succeeded ? { replayState: {
          response: { kind, version: 1, model, ...(id ? { id } : {}), ...(provider ? { provider } : {}), ...(cost !== undefined ? { cost } : {}) },
          blocks: order.map(block => block.kind === 'reasoning' && block.details.length > 0 ? { type: 'reasoning', reasoningDetails: mergeDetails(block.details) } : { type: block.kind }),
        } } : {}),
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed ${label} stream payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE');
    }
    if (chunk?.error) {
      const status = Number.isInteger(chunk.error.code) ? chunk.error.code : undefined;
      throw new LlmError(errorMessage(chunk.error, `${label} stream error`), errorCode(undefined, chunk.error), status === undefined ? {} : { status });
    }
    if (typeof chunk?.id === 'string') id ??= chunk.id;
    if (typeof chunk?.provider === 'string') provider ??= chunk.provider;
    for (const choice of chunk?.choices ?? []) {
      const delta = choice.delta ?? {};
      const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
      let reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (reasoning.length === 0) reasoning = details.map(detail => detail?.type === 'reasoning.text' ? detail.text : detail?.type === 'reasoning.summary' ? detail.summary : '').filter(text => typeof text === 'string').join('');
      if (reasoning.length > 0 || details.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.details.push(...details);
        if (reasoning.length > 0) {
          reasoningBlock.text += reasoning;
          yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
        }
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += delta.content;
        yield { type: 'text-delta', index: textBlock.index, text: delta.content };
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = call.index ?? call.id;
        let block = tools.get(key);
        if (!block) {
          block = open('tool-call');
          tools.set(key, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        // id and name arrive once; an empty or null repeat is no update.
        if (typeof call.id === 'string' && call.id.length > 0) block.callId = call.id;
        if (typeof call.function?.name === 'string' && call.function.name.length > 0) block.name = call.function.name;
        const fragment = typeof call.function?.arguments === 'string' ? call.function.arguments : '';
        block.text += fragment;
        yield { type: 'tool-call-delta', index: block.index, id: block.callId ?? '', ...(block.name !== undefined ? { name: block.name } : {}), argumentsDelta: fragment };
      }
      if (typeof choice.finish_reason === 'string') finish = choice.finish_reason;
    }
    if (chunk?.usage) {
      usage = mapUsage(chunk.usage) ?? usage;
      if (Number.isFinite(chunk.usage.cost) && chunk.usage.cost >= 0) cost = chunk.usage.cost;
    }
  }
  throw new LlmError(`${label} stream ended without [DONE]`, 'TRANSPORT');
}
