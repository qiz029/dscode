import { LlmError } from '@deepseek-ai/dsh-llm';
import { serializeMessages } from '../openrouter/wire.mjs';
import { ultraRequest } from '../ultra/policy.mjs';

// OpenCode Go chat completions on the wire. Go forwards request fields to each model's
// upstream, which rejects OpenRouter's extensions (`reasoning: {effort}`, `provider`,
// `session_id`), so the body keeps to the OpenAI fields every upstream accepts. The SSE
// stream is OpenAI's too, so the OpenRouter translation reads it unchanged.

export const PROVIDER = 'opencode-go';
/** `replayState.response.kind` for responses this adapter produced. */
export const REPLAY_KIND = 'dscode-opencode-go';
export const LABEL = 'OpenCode Go';
const WIRE = Object.freeze({ off: 'none', low: 'low', high: 'high', max: 'max', ultra: 'max' });
// DeepSeek rejects a thinking-mode tool-call turn replayed without `reasoning_content`.
const REASONING_CONTENT_MODELS = /^deepseek-/;
const DIALECT = Object.freeze({ provider: PROVIDER, reasoningContent: model => REASONING_CONTENT_MODELS.test(model) });

/**
 * Reasoning controls a model offers through this route.
 * @param entry - the model's catalog entry, if any.
 * @returns `{ levels, defaultEffort, wire }`, or undefined when the catalog does not describe the model.
 */
export function modelReasoning(entry) {
  if (!entry?.efforts?.length) return undefined;
  const levels = [...entry.efforts];
  return { levels, defaultEffort: levels.includes('high') ? 'high' : levels[0], wire: Object.fromEntries(levels.map(level => [level, WIRE[level]])) };
}

/** A title needs no deliberation: reasoning off when the model allows it, else its lowest level. */
function titleEffort(reasoning) {
  return reasoning.levels[0];
}

/**
 * The chat-completions body for one harness request.
 * @param options - harness request (images already prepared into `images`).
 * @param context - `{ entry, images }`: the model's catalog entry and prepared request images.
 */
export function requestBody(options, { entry, images } = {}) {
  const reasoning = modelReasoning(entry);
  const effort = options.purpose === 'session-title' && reasoning ? titleEffort(reasoning) : options.reasoningEffort;
  const wireEffort = effort === undefined ? undefined : reasoning?.wire[effort];
  if (effort !== undefined && reasoning !== undefined && wireEffort === undefined) {
    throw new LlmError(`${LABEL} model "${options.model}" does not offer reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT');
  }
  const messages = ultraRequest(options, serializeMessages(options.messages, { model: options.model, system: options.system, images, dialect: DIALECT }));
  // Delegation tools are offered at every effort; workflow and ralph never are.
  const tools = (options.tools ?? []).filter(tool => tool.name !== 'workflow' && tool.name !== 'ralph')
    .map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length > 0 ? { tools } : {}),
    ...(wireEffort !== undefined ? { reasoning_effort: wireEffort } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
  };
}

/**
 * A clearer message for Go's account-side refusals, or the gateway's own text.
 * The DeepSeek rows need the workspace's Global region, a setting only the user can change.
 */
export function explainError(message) {
  if (typeof message === 'string' && /requires Global regions/i.test(message)) {
    return `${message} (OpenCode console → your workspace → Privacy → select Global)`;
  }
  return message;
}
