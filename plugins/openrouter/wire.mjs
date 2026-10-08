import { LlmError } from '@deepseek-ai/dsh-llm';
import { serializeMessages } from '../providers/chat-messages.mjs';
export { serializeMessages } from '../providers/chat-messages.mjs';
export { sseData, mapUsage, translate } from '../providers/chat-stream.mjs';
export { errorCode, errorMessage, retryAfterMs } from '../providers/http-errors.mjs';
import { OPENROUTER_EFFORTS } from '../providers/catalog.mjs';
import { ultraRequest } from '../ultra/policy.mjs';

// OpenRouter chat completions on the wire: request bodies, the SSE stream, and
// the translation into harness stream chunks. Pure functions; the adapter owns I/O.

export const PROVIDER = 'openrouter';
/** `replayState.response.kind` for responses this adapter produced. */
export const REPLAY_KIND = 'dscode-openrouter';
// OpenRouter serves DeepSeek V4 thinking as none/high/xhigh; the route keeps the
// official off/low/high/max detents (and Ultra on max) with the spelling it accepts.
const DEEPSEEK_WIRE = Object.freeze({ ...OPENROUTER_EFFORTS, ultra: OPENROUTER_EFFORTS.max });
const DEEPSEEK_V4 = /^deepseek\/deepseek-v4/;
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
  let messages = serializeMessages(options.messages, { model: options.model, system: options.system, images, dialect: { provider: options.provider ?? PROVIDER } });
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
