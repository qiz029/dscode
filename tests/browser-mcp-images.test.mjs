import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpToolDefinition, patchMcpImageValidation } from '../plugins/browser/mcp-tools.mjs';

async function projection(data, { imageModel = true, cancelled = false } = {}) {
  const saved = [];
  const ctx = { get: name => name === 'llm' ? { resolveModelInfo: async () => ({ inputModalities: imageModel ? ['text', 'image'] : ['text'] }) } :
    name === 'attachments' ? { saveImages: async inputs => { saved.push(...inputs); return inputs.map(() => ({ attachmentId: 'fixture-image' })); } } : undefined };
  const content = [{ type: 'image', mimeType: 'image/png', data }];
  const tool = createMcpToolDefinition(ctx, { name: 'mcp__browser__take_screenshot', rawName: 'take_screenshot', inputSchema: { type: 'object' }, call: async () => ({ content }) });
  const controller = new AbortController(); if (cancelled) controller.abort();
  const exec = { signal: controller.signal, agent: { options: { provider: 'test', model: 'test' }, session: { requestHeader: () => undefined } } };
  let value;
  try { value = await tool.execute({}, exec); } catch (error) { return { saved, error }; }
  const result = { value, content: tool.output.render({}, value) };
  return { saved, value, content: tool.projectContent(exec, result), takeAgain: () => tool.projectContent(exec, result) };
}

test('large canonical MCP images reach durable projection without overflowing base64 validation', async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024, 123);
  const result = await projection(bytes.toString('base64'));
  assert.equal(result.content[0].type, 'image', JSON.stringify(result.content));
  assert.deepEqual(result.saved[0].data, bytes);
  assert.equal(result.value.content[0].data, bytes.toString('base64'));
  assert.equal(result.takeAgain(), undefined, 'Projection remains single-use');
});

test('noncanonical base64 remains refused before durable image storage', async () => {
  for (const data of ['YW Jj', 'YWJj\n', 'YQ', 'YR==', 'YQ===', '-w==', 'a=b=']) {
    const result = await projection(data);
    assert.equal(result.saved.length, 0, data);
    if (result.error) { assert.match(result.error.message, /invalid.*base64/i); continue; }
    assert.equal(result.content[0].type, 'text', data);
    assert.match(result.content[0].text, /canonical base64/);
  }
});

test('large-image projection preserves model capability and cancellation admission', async () => {
  for (const options of [{ imageModel: false }, { cancelled: true }]) {
    const result = await projection('YWJj', options);
    assert.equal(result.saved.length, 0);
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /image unavailable/);
  }
});

test('the validation adaptation refuses an unrecognized source shape', () => {
  assert.throws(() => patchMcpImageValidation('unrecognized'), /Unsupported/);
});
