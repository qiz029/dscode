import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmError, QUOTA_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError, textOnlyImageText } from "@deepseek-ai/dsh-llm";
import { ultraRequest } from "../ultra/policy.mjs";
import { GROK_EFFORTS } from "./models.mjs";

// dscode: xAI chat completions on the wire. The subscription route speaks plain OpenAI
// chat completions — structured `tool_calls`, `reasoning_content` deltas and a usage block
// that reports cache reads and reasoning tokens — so this module is the small, pure half of
// the adapter: request bodies, SSE payloads and the translation into harness stream chunks.

export const PROVIDER = "grok";
/** `replayState.response.kind` for responses this adapter produced. */
export const REPLAY_KIND = "dscode-grok";
/** DeepSeek-style DSCODE detents, spelled the way xAI accepts them. */
const WIRE_EFFORT = Object.freeze({ off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh", ultra: "xhigh" });
const NAMES = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max", ultra: "Ultra" };
export const ULTRA_DESCRIPTION = "DSCODE: top reasoning plus deliberate subagent collaboration; higher total token use.";

/** Display metadata for one harness effort id. */
export function effortInfo(id) {
  return { id, name: NAMES[id] ?? id, ...id === "ultra" ? { description: ULTRA_DESCRIPTION } : {} };
}

/** The wire spelling for a harness effort, or undefined when the route cannot express it. */
export function wireEffort(id) {
  return WIRE_EFFORT[id];
}

/** A title needs no deliberation: the lowest detent the model offers. */
function titleEffort(entry) {
  const levels = entry?.efforts ?? GROK_EFFORTS;
  return GROK_EFFORTS.find(level => levels.includes(level)) ?? levels[0];
}

const textOf = blocks => blocks.filter(block => block.type === "text").map(block => block.text).join("");

/** Image blocks this route cannot send as images degrade to their text handle. */
function contentText(blocks) {
  const parts = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text.length > 0) parts.push(block.text);
    else if (block.type === "image") parts.push(textOnlyImageText(block.attachment));
  }
  return parts.join("\n");
}

function serializeAssistant(message) {
  const text = textOf(message.content);
  const calls = message.content.filter(block => block.type === "tool-call")
    .map(block => ({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } }));
  if (text.length === 0 && calls.length === 0) return undefined;
  return { role: "assistant", content: text, ...calls.length > 0 ? { tool_calls: calls } : {} };
}

/**
 * Harness history as chat messages: tool results become `tool` messages, everything else
 * keeps its role. Reasoning is deliberately not replayed — xAI takes the assistant text and
 * its tool calls, and replayed thinking buys nothing here.
 */
export function serializeMessages(messages, { system } = {}) {
  const wire = [];
  if (typeof system === "string" && system.length > 0) wire.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text.length > 0) wire.push({ role: "system", content: text });
      continue;
    }
    if (message.role === "assistant") {
      const entry = serializeAssistant(message);
      if (entry !== undefined) wire.push(entry);
      continue;
    }
    const results = message.content.filter(block => block.type === "tool-result");
    const parts = contentText(message.content.filter(block => block.type !== "tool-result"));
    if (parts.length > 0 || results.length === 0) wire.push({ role: "user", content: parts });
    for (const result of results) wire.push({ role: "tool", tool_call_id: result.toolCallId, content: contentText(result.content) || "(no output)" });
  }
  return wire;
}

/**
 * The chat-completions body for one harness request.
 * @param options - harness request; @param context - `{ entry }`, the model entry from the catalog.
 */
export function requestBody(options, { entry } = {}) {
  const effort = options.purpose === "session-title" ? titleEffort(entry) : options.reasoningEffort;
  const spell = effort === undefined ? undefined : wireEffort(effort);
  if (effort !== undefined && spell === undefined) throw new LlmError(`Grok does not offer reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
  const messages = ultraRequest(options, serializeMessages(options.messages, { system: options.system }));
  const tools = (options.tools ?? []).filter(tool => tool.name !== "workflow" && tool.name !== "ralph")
    .map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  return {
    model: options.model,
    messages,
    stream: true,
    // The usage block of a streamed response arrives on its own final chunk only when asked.
    stream_options: { include_usage: true },
    ...tools.length > 0 ? { tools } : {},
    ...spell === undefined ? {} : { reasoning_effort: spell },
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.stop === undefined ? {} : { stop: options.stop },
  };
}

/**
 * Harness failure code for an xAI error.
 * @param status - HTTP status of a rejected request; undefined for an error inside a 200 stream.
 * @param error - the provider `error` object (`message`, optional `code`).
 */
export function errorCode(status, error) {
  const code = Number.isInteger(status) ? status : Number(error?.code);
  const detail = typeof error?.message === "string" ? error.message : "";
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (code === 401 || code === 403) return "AUTH";
  if (code === 402) return QUOTA_EXCEEDED_CODE;
  if (code === 429) return "RATE_LIMIT";
  if (code === 408 || code === 504) return "TIMEOUT";
  if (code >= 500) return "SERVER";
  if (code >= 400) return "INVALID_REQUEST";
  return "SERVER";
}

/** Human-readable message for an xAI error object. */
export function errorMessage(error, fallback) {
  return typeof error?.message === "string" && error.message.length > 0 ? error.message : fallback;
}

/** Retry-After as milliseconds (seconds or an HTTP date), when valid. */
export function retryAfterMs(value) {
  if (value === null || value === undefined) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1e3 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/** SSE `data:` payloads from a response body, skipping `:` keep-alive comments. */
export async function* sseData(body, onActivity) {
  const decoder = new TextDecoder();
  let buffer = "", data = [];
  const lines = function* (final) {
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0 || final && buffer.length > 0) {
      let line = newline >= 0 ? buffer.slice(0, newline) : buffer;
      buffer = newline >= 0 ? buffer.slice(newline + 1) : "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        const payload = data.join("\n");
        if (payload.trim() !== "") yield payload;
        data = [];
      } else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
  };
  for await (const chunk of body) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });
    yield* lines(false);
  }
  buffer += decoder.decode();
  yield* lines(true);
  const tail = data.join("\n");
  if (tail.trim() !== "") yield tail;
}

/** Map xAI usage to disjoint harness counts (`prompt_tokens` includes the cache reads). */
export function mapUsage(usage) {
  const valid = value => Number.isSafeInteger(value) && value >= 0;
  const prompt = usage?.prompt_tokens, completion = usage?.completion_tokens;
  if (!valid(prompt) || !valid(completion)) return undefined;
  const read = valid(usage.prompt_tokens_details?.cached_tokens) ? usage.prompt_tokens_details.cached_tokens : 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Math.max(0, prompt - read),
    outputTokens: completion,
    totalTokens: prompt + completion,
    ...read > 0 ? { cacheReadTokens: read } : {},
    ...valid(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {},
  };
}

function closeBlock(block) {
  if (block.kind === "tool-call") return { type: "tool-call", id: block.callId ?? "", name: block.name ?? "", arguments: block.text };
  return { type: block.kind, text: block.text };
}

function finishReason(reason, blocks) {
  if (reason === "length") return { kind: "max-tokens" };
  if (reason === "content_filter") return { kind: "error", failure: { message: "xAI stopped the response for content filtering", code: "CONTENT_FILTER" } };
  if (reason === "tool_calls" || blocks.some(block => block.kind === "tool-call") && (reason === undefined || reason === "stop")) return { kind: "tool-calls" };
  if (reason === undefined || reason === null || reason === "stop") return blocks.length === 0 ? { kind: "error", failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE } } : { kind: "stop" };
  return { kind: "error", failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } };
}

/**
 * Translate SSE payloads into harness chunks. Block ends, usage and the finish are held
 * until `[DONE]`; an error inside the stream throws with its routed code.
 */
export async function* translate(payloads, { model }) {
  let nextIndex = 0, textBlock, reasoningBlock, finish, usage, id;
  const tools = new Map();
  const order = [];
  const open = kind => {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  };
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
      if (usage) yield { type: "usage", usage };
      const reason = finishReason(finish, order);
      const succeeded = reason.kind === "stop" || reason.kind === "tool-calls" || reason.kind === "max-tokens";
      yield {
        type: "finish", reason,
        ...succeeded ? { replayState: { response: { kind: REPLAY_KIND, version: 1, model, ...id === undefined ? {} : { id } }, blocks: order.map(block => ({ type: block.kind })) } } : {},
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed xAI stream payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    if (chunk?.error) {
      const status = Number.isInteger(chunk.error.code) ? chunk.error.code : undefined;
      throw new LlmError(errorMessage(chunk.error, "xAI stream error"), errorCode(undefined, chunk.error), status === undefined ? {} : { status });
    }
    if (typeof chunk?.id === "string") id ??= chunk.id;
    for (const choice of chunk?.choices ?? []) {
      const delta = choice.delta ?? {};
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += delta.content;
        yield { type: "text-delta", index: textBlock.index, text: delta.content };
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = call.index ?? call.id;
        let block = tools.get(key);
        if (!block) {
          block = open("tool-call");
          tools.set(key, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (typeof call.id === "string" && call.id.length > 0) block.callId = call.id;
        if (typeof call.function?.name === "string" && call.function.name.length > 0) block.name = call.function.name;
        const fragment = typeof call.function?.arguments === "string" ? call.function.arguments : "";
        block.text += fragment;
        yield { type: "tool-call-delta", index: block.index, id: block.callId ?? "", ...block.name === undefined ? {} : { name: block.name }, argumentsDelta: fragment };
      }
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    }
    if (chunk?.usage) usage = mapUsage(chunk.usage) ?? usage;
  }
  throw new LlmError("xAI stream ended without [DONE]", "TRANSPORT");
}
