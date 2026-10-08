import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { createToolResultMessage } from '@deepseek-ai/dsh-llm';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import * as Custom from '../plugins/custom/index.mjs';
import { CustomAdapter } from '../plugins/custom/adapter.mjs';
import { validateProfile, PROTOCOLS } from '../plugins/custom/config.mjs';
import { BrowserPreview } from '../plugins/browser/preview.mjs';
import { OpenRouterAdapter } from '../plugins/openrouter/adapter.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==', 'base64');
const model = { id: 'vision-fixture', contextWindow: 32768, inputModalities: ['text', 'image'] };
const profile = (extra = {}) => validateProfile({ id: 'custom-image', name: 'Image fixture', baseURL: 'http://localhost/v1', api: 'chat-completions', auth: 'none', models: [model], ...extra });
const collect = async stream => { const chunks = []; for await (const c of stream) chunks.push(c); return chunks; };
const response = api => api === 'responses'
  ? [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'received' }] }] } }]
  : api === 'anthropic' ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'received' } }, { type: 'message_stop' }]
    : [{ choices: [{ delta: { content: 'received' }, finish_reason: 'stop' }] }, '[DONE]'];
const streamText = api => response(api).map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');

for (const api of PROTOCOLS) test(`${api}: preview annotation and tool screenshot reach HTTP with durable bytes after provider reload`, async () => {
  const home = await mkdtemp(join(tmpdir(), 'custom-images-'));
  const ctx = new Context(), requests = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(streamText(api));
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(LocalAttachmentStore, { dshHome: home });
    ctx.provide('credentials', { describe: async () => ({ configured: false }) });
    await ctx.plugin(Custom, { path: join(home, 'providers.yaml') });
    const service = Custom.getCustomProviders(ctx), p = profile({ api, baseURL: `http://127.0.0.1:${server.address().port}/v1` });
    await service.save(p, '', (await service.list()).revision);
    service.revision = undefined; await service.refresh();
    assert.deepEqual((await ctx.llm.resolveModelInfo(p.id, model.id)).inputModalities, ['text', 'image']);
    assert.deepEqual((await service.adapter.listModels(p.id))[0].inputModalities, ['text', 'image']);
    const messages = [];
    const browser = { pages: [{ id: 1, url: 'https://fixture.example/', documentId: 'fixture-document' }], generation: 1, owned: new Set(), assertAgentControl() {}, access: { async checkUrl() {} },
      async call(name) { return { content: name === 'take_screenshot' ? [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] : [] }; } };
    const preview = new BrowserPreview(browser), frame = await preview.capture(1);
    const agent = { options: { provider: p.id, model: model.id }, session: { requestHeader() {} }, followup: m => messages.push(m) };
    assert.equal((await preview.annotate({ token: frame.token, x: 0, y: 0, text: 'Inspect this pixel' }, ctx, agent)).imageInput, true);
    const image = messages[0].content[1];
    assert.equal(image.offloaded, undefined);
    const expected = await ctx.attachments.readImageRequest(image.attachment, { width: 2, height: 2, maxBytes: 1024 * 1024 });
    messages.push({ role: 'assistant', source: { provider: p.id, model: model.id }, content: [{ type: 'tool-call', id: 'screenshot-1', name: 'take_screenshot', arguments: '{}' }] },
      createToolResultMessage({ callId: 'screenshot-1', content: [{ type: 'text', text: 'Tool pixels' }, image], isError: false }));
    const chunks = await collect(ctx.llm.stream({ ...agent.options, messages }));
    assert.equal(chunks.at(-1).reason.kind, 'stop', JSON.stringify(chunks.at(-1)));
    assert.equal(requests.length, 1);
    const { body, url } = requests[0];
    assert.equal(url, '/v1/' + ({ responses: 'responses', anthropic: 'messages', 'chat-completions': 'chat/completions' })[api]);
    const wire = body.input ?? body.messages;
    const parts = wire.flatMap(m => Array.isArray(m.content) ? m.content : []);
    const images = parts.filter(p => ['input_image', 'image_url', 'image'].includes(p.type));
    assert.equal(images.length, 2, 'both the annotation and tool result retain pixels');
    for (const part of images) {
      const data = api === 'anthropic' ? part.source.data : (api === 'responses' ? part.image_url : part.image_url.url).split(',')[1];
      assert.deepEqual(Buffer.from(data, 'base64'), Buffer.from(expected.data));
      if (api === 'anthropic') assert.deepEqual(Object.keys(part.source).sort(), ['data', 'media_type', 'type']);
    }
    const text = parts.filter(p => ['text', 'input_text', 'output_text'].includes(p.type));
    for (const part of text) assert.equal(typeof part.text, 'string', 'no content array embedded in a text field');
    assert.match(JSON.stringify(wire), /Inspect this pixel/);
    assert.match(JSON.stringify(wire), /screenshot-1/);
    if (api === 'responses') assert(wire.some(m => m.type === 'function_call_output' && m.call_id === 'screenshot-1'));
    if (api === 'anthropic') assert(parts.some(p => p.type === 'tool_result' && p.tool_use_id === 'screenshot-1'));
    if (api === 'chat-completions') assert(wire.some(m => m.role === 'tool' && m.tool_call_id === 'screenshot-1'));
    // A text-only route projects an explicitly offloaded screenshot without reading bytes.
    await service.save({ ...p, models: [{ ...model, inputModalities: ['text'] }] }, '', (await service.list()).revision);
    const next = await preview.capture(1);
    assert.equal((await preview.annotate({ token: next.token, x: 0, y: 0, text: 'Text-only annotation' }, ctx, agent)).imageInput, false);
    const offloaded = messages.at(-1);
    assert.equal(offloaded.content[1].offloaded, true);
    await collect(ctx.llm.stream({ ...agent.options, messages: [offloaded] }));
    assert(!JSON.stringify(requests[1].body).includes('base64,'));
    assert.match(JSON.stringify(requests[1].body), /image omitted because this model accepts text only/);
    await service.save(p, '', (await service.list()).revision);
    await collect(ctx.llm.stream({ ...agent.options, messages: [offloaded] }));
    assert(!JSON.stringify(requests[2].body).includes('base64,'));
    assert.match(JSON.stringify(requests[2].body), /image omitted to fit request image limits/);
    await rm(ctx.attachments.imageHostPath(image.attachment));
    const failed = await collect(ctx.llm.stream({ ...agent.options, messages: [messages[0]] }));
    assert.equal(failed.at(-1).reason.failure.code, 'ATTACHMENT_NOT_FOUND');
    assert.equal(requests.length, 3, 'missing stored pixels must not trigger an HTTP request');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('OpenRouter prepares images against the installed durable attachment contract', async () => {
  const home = await mkdtemp(join(tmpdir(), 'openrouter-image-')), ctx = new Context();
  try {
    await ctx.plugin(LocalAttachmentStore, { dshHome: home });
    const attachment = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png' });
    const adapter = new OpenRouterAdapter({ resolveAttachments: () => ctx.attachments });
    const prepared = await adapter.prepareImages({ model: 'vision', messages: [{ role: 'user', content: [{ type: 'image', attachment }] }] }, model, { maxRequestImageBytes: 20 * 1024 * 1024 });
    const version = prepared.versions.get(attachment.attachmentId);
    assert.equal(version.width, 2); assert.equal(version.height, 2);
    assert(version.data.length > 0);
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('image capability is explicit, backward compatible and validated', () => {
  assert.deepEqual(profile({ models: [{ id: 'vision-named-model' }] }).models[0].inputModalities, ['text']);
  for (const inputModalities of [[], ['image'], ['text', 'audio'], ['text', 'text'], 'image']) {
    assert.throws(() => profile({ models: [{ ...model, inputModalities }] }), /Model input/);
  }
});

test('retained images require both an enabled model and an attachment store', async () => {
  for (const inputModalities of [['text'], ['text', 'image']]) {
    const p = profile({ models: [{ ...model, inputModalities }] });
    const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => undefined, fetch: () => assert.fail('must fail before HTTP') });
    await assert.rejects(collect(adapter.stream({ provider: p.id, model: model.id, messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'fixture' } }] }] })), e => e.code === 'UNSUPPORTED_CONTENT');
  }
});

test('image budget reports durable offload count, deduplicates reads and never mutates history', async () => {
  const p = profile(); let reads = 0;
  const image = { type: 'image', attachment: { attachmentId: 'fixture', mediaType: 'image/png', width: 1, height: 1, bytes: 1024 * 1024 } };
  const options = { provider: p.id, model: model.id, messages: [{ role: 'user', content: Array.from({ length: 16 }, () => structuredClone(image)) }] };
  const original = structuredClone(options);
  const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => undefined,
    resolveAttachments: () => ({ readImageRequest: async () => { reads++; return { ...image.attachment, data: Buffer.alloc(1024 * 1024) }; } }),
    fetch: async () => new Response(streamText(p.api), { headers: { 'content-type': 'text/event-stream' } }) });
  await assert.rejects(collect(adapter.stream(options)), e => e.code === 'IMAGE_OFFLOAD_REQUIRED' && e.failure.offloadImages === 2);
  assert.equal(reads, 1); assert.deepEqual(options, original);
  // The same provider queue is reusable after preparation failed.
  assert.equal((await collect(adapter.stream({ ...options, messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }] }))).at(-1).reason.kind, 'stop');
});

test('cancellation during attachment preparation sends no request and releases the queue', async () => {
  const p = profile(), controller = new AbortController(); let calls = 0;
  const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => undefined,
    resolveAttachments: () => ({ readImageRequest: async () => { controller.abort(); return { data: png, bytes: png.length }; } }),
    fetch: async () => { calls++; return new Response(streamText(p.api), { headers: { 'content-type': 'text/event-stream' } }); } });
  await assert.rejects(collect(adapter.stream({ provider: p.id, model: model.id, signal: controller.signal, messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'fixture', width: 1, height: 1 } }] }] })), e => e.code === 'ABORTED');
  assert.equal(calls, 0);
  await collect(adapter.stream({ provider: p.id, model: model.id, messages: [{ role: 'user', content: [{ type: 'text', text: 'continue' }] }] }));
  assert.equal(calls, 1);
});
