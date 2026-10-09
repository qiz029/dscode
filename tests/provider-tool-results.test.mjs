import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { serializeMessages } from '../plugins/providers/chat-messages.mjs';
import { requestBody } from '../plugins/custom/wire.mjs';

const attachment = { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: 3, width: 2, height: 2 };
const messages = [
  createAssistantMessage({ source: { provider: 'custom-fixture', model: 'vision' }, content: [
    { type: 'tool-call', id: 'shot', name: 'screenshot', arguments: '{}' },
    { type: 'tool-call', id: 'inspect', name: 'inspect', arguments: '{}' },
  ] }),
  createToolResultMessage({ callId: 'shot', content: [{ type: 'text', text: 'Captured' }, { type: 'image', attachment }], isError: false }),
  createToolResultMessage({ callId: 'inspect', content: [{ type: 'text', text: 'Page closed' }], isError: true }),
];
const images = { versions: new Map([[attachment.attachmentId, { ...attachment, data: Buffer.from([1, 2, 3]) }]]) };

test('native tool messages keep all call IDs and precede their screenshots in shared chat serialization', () => {
  const wire = serializeMessages(messages, { model: 'vision', images });
  assert.deepEqual(wire.map(m => m.role), ['assistant', 'tool', 'tool', 'user']);
  assert.deepEqual(wire.slice(1, 3).map(m => m.tool_call_id), ['shot', 'inspect']);
  assert.match(wire[1].content, /Captured/); assert.equal(wire[2].content, 'Page closed');
  assert(wire[3].content.some(p => p.type === 'image_url'));
});

test('parallel native results preserve IDs and Anthropic errors before supplementary image content', () => {
  for (const api of ['responses', 'anthropic']) {
    const body = requestBody({ id: 'custom-fixture', api, backend: 'generic' }, { id: 'vision', contextWindow: 32768 }, { messages }, images);
    if (api === 'responses') {
      assert.deepEqual(body.input.filter(p => p.type === 'function_call_output').map(p => p.call_id), ['shot', 'inspect']);
      assert(body.input.some(p => p.content?.some(b => b.type === 'input_image')));
    } else {
      assert.equal(body.messages.length, 2);
      const content = body.messages[1].content;
      assert.deepEqual(content.slice(0, 2).map(p => [p.type, p.tool_use_id]), [['tool_result', 'shot'], ['tool_result', 'inspect']]);
      assert.equal(content[1].is_error, true);
      assert(content.slice(2).some(p => p.type === 'image'));
    }
  }
});
