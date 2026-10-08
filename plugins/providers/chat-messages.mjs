import { requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm';

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:';
// Legacy OpenRouter defaults; other protocols supply an explicit dialect.
const REASONING_CONTENT_MODELS = /^(?:deepseek\/deepseek-v4|moonshotai\/kimi-k2\.6|xiaomi\/mimo-v2\.6)/;

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
export function serializeMessages(messages, { model, system, images, dialect = { provider: 'openrouter' } } = {}) {
  const wire = [];
  if (system !== undefined && system.length > 0) wire.push({ role: 'system', content: system });
  let pendingImages = [];
  const flush = () => {
    if (pendingImages.length === 0) return;
    wire.push({ role: 'user', content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingImages] });
    pendingImages = [];
  };
  const appendResult = (callId, content) => {
    const nested = contentParts(content, images);
    const text = nested.filter(part => part.type === 'text').map(part => part.text).join('');
    const attached = nested.filter(part => part.type !== 'text');
    wire.push({ role: 'tool', tool_call_id: callId, content: text || (attached.length > 0 ? '(see attached image)' : '(no output)') });
    pendingImages.push(...attached);
  };
  for (const message of messages) {
    if (message.role === 'system') {
      flush();
      const text = textOf(message.content);
      if (text.length > 0) wire.push({ role: 'system', content: text });
      continue;
    }
    if (message.role === 'tool') {
      appendResult(message.toolCallId, message.content);
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
      appendResult(result.toolCallId, result.content);
    }
  }
  flush();
  return wire;
}
