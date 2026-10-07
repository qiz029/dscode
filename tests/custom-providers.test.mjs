import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomStore, validateProfile, endpoint, keyRef, isCustomKey, PROTOCOLS } from '../plugins/custom/config.mjs';
import { CustomAdapter, authHeaders } from '../plugins/custom/adapter.mjs';
import { CustomProviders } from '../plugins/custom/index.mjs';
import { requestBody, REPLAY_KIND } from '../plugins/custom/wire.mjs';

test('native Harness tool messages retain their call identity in every custom protocol', () => {
  const messages = [{ role: 'tool', toolCallId: 'native-call', content: [{ type: 'text', text: 'native result' }] }];
  const chat = requestBody(profile(), model, { messages });
  assert.deepEqual(chat.messages, [{ role: 'tool', tool_call_id: 'native-call', content: 'native result' }]);
  const responses = requestBody(profile('responses'), model, { messages });
  assert.deepEqual(responses.input, [{ type: 'function_call_output', call_id: 'native-call', output: 'native result' }]);
  const anthropic = requestBody(profile('anthropic'), model, { messages });
  assert.deepEqual(anthropic.messages, [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-call', content: 'native result' }] }]);
});
import { effectiveContextWindow } from '../plugins/compaction/threshold.mjs';
import { providerArgument, providerOfLabel } from '../plugins/providers/catalog.mjs';
import { RoutedSearchProvider } from '../plugins/openrouter/search.mjs';

const model = { id: 'org/test', name: 'Test', contextWindow: 32768, maxTokens: 4096, thinking: 'default' };
const profile = (api = 'chat-completions', extra = {}) => validateProfile({ id: 'custom-fixture', name: 'Local fixture', baseURL: 'http://localhost:8000/v1/', api, auth: 'bearer', models: [model], ...extra });
const conversation = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
const collect = async iterable => { const values = []; for await (const value of iterable) values.push(value); return values; };

test('custom sessions do not silently use an available cloud search key', async () => {
  const route = new RoutedSearchProvider({ currentProvider: () => 'custom-fixture', deepseek: () => ({}), hasKey: () => { throw Error('must not inspect cloud keys'); } });
  await assert.rejects(route.pick(), /not configured for Custom/);
});
function sse(events) {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
function events(api, { text = '你好', call, reasoning = false } = {}) {
  if (api === 'chat-completions') return [
    ...(reasoning ? [{ choices: [{ delta: { reasoning_content: 'thought' } }] }] : []),
    ...(call ? [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: call.name, arguments: '{"name":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"studio"}' } }] }, finish_reason: 'tool_calls' }] },
    ] : [{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]),
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 5 } } }, '[DONE]',
  ];
  if (api === 'responses') {
    const item = call ? { type: 'function_call', id: 'fc1', call_id: 'c1', name: call.name, arguments: '{"name":"studio"}' }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
    return [
      { type: 'response.output_item.added', output_index: 0, item: call ? { ...item, arguments: '' } : item },
      ...(call ? [
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"name":' },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"studio"}' },
      ] : [{ type: 'response.output_text.delta', output_index: 0, delta: text }]),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 5 } } } },
    ];
  }
  return [
    { type: 'message_start', message: { id: 'a1', usage: { input_tokens: 15, cache_read_input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'c1', name: call.name, input: {} } : { type: 'text', text: '' } },
    ...(call ? [
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"studio"}' } },
    ] : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ];
}

test('custom config validates endpoints, budgets, auth and secrets without inventing context', () => {
  assert.equal(endpoint(profile()), 'http://localhost:8000/v1/chat/completions');
  assert.equal(profile('responses').baseURL, 'http://localhost:8000/v1');
  for (const baseURL of ['file:///tmp/model', 'https://user:secret@host/v1', 'http://host/v1?key=secret']) assert.throws(() => profile('responses', { baseURL }));
  assert.throws(() => profile('responses', { models: [{ ...model, maxTokens: 32768 }] }), /smaller/);
  assert.throws(() => profile('responses', { models: [model, model] }), /unique/);
  const draft = profile('responses', { models: [{ id: 'unknown' }], apiKey: 'secret' });
  assert.equal(draft.models[0].contextWindow, undefined);
  assert(!JSON.stringify(draft).includes('secret'));
  assert(isCustomKey(keyRef(draft.id)));
  assert.equal(providerArgument('custom'), 'custom');
  assert.equal(providerOfLabel('custom-fixture/org/test'), 'custom-fixture');
  assert.deepEqual(authHeaders(profile('anthropic', { auth: 'none' })), { 'anthropic-version': '2023-06-01' });
  assert.equal(authHeaders(profile('anthropic', { auth: 'x-api-key' }), 'synthetic')['x-api-key'], 'synthetic');
});

test('atomic store rejects stale editors, preserves multiple providers, and stays owner-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-store-'));
  try {
    const store = new CustomStore(join(dir, 'providers.yaml'));
    const first = await store.read();
    const saved = await store.update(first.revision, () => [profile()]);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
    await assert.rejects(store.update(first.revision, () => []), /changed/);
    await store.update(saved.revision, p => [...p, profile('anthropic', { id: 'custom-second' })]);
    assert.equal((await store.read()).providers.length, 2);
    assert(!/apiKey|synthetic/.test(await readFile(store.path, 'utf8')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('model discovery maps oMLX limits, tolerates optional metadata failure and never makes up limits', async () => {
  const paths = [];
  const service = new CustomProviders({ credentials: { resolve: async () => ({ value: 'synthetic' }) }, fetch: async (url, init) => {
    paths.push(url); assert.equal(init.headers.authorization, 'Bearer synthetic');
    return Response.json(url.endsWith('/status') ? { models: [{ id: 'qwen', max_context_window: 65536, max_tokens: 8192 }] }
      : { data: [{ id: 'qwen', owned_by: 'omlx', max_model_len: 262144 }, { id: 'unknown' }] });
  } });
  const result = await service.discover(profile());
  assert.equal(result.backend, 'omlx');
  assert.equal(result.models[0].contextWindow, 65536);
  assert.equal(result.models[0].maxTokens, 8192);
  assert.equal(result.models[1].contextWindow, undefined);
  assert.deepEqual(paths, ['http://localhost:8000/v1/models', 'http://localhost:8000/v1/models/status']);
});

test('an environment key does not prevent deleting a custom provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-env-remove-'));
  try {
    const store = new CustomStore(join(dir, 'providers.yaml'));
    await store.update((await store.read()).revision, () => [profile()]);
    const service = new CustomProviders({ store, credentials: { describe: async () => ({ configured: true, source: 'env', writable: false }), unset: async () => { throw Error('must not unset environment'); } } });
    const result = await service.remove('custom-fixture', (await service.list()).revision);
    assert.equal(result.providers.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const api of PROTOCOLS) {
  test(`${api}: streamed tools, Unicode, disjoint usage and native request format`, async () => {
    const p = profile(api), requests = [];
    const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => 'synthetic', fetch: async (url, init) => {
      requests.push({ url, ...init, body: JSON.parse(init.body) }); return sse(events(api, { call: { name: 'lookup_probe' } }));
    } });
    const chunks = await collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation, tools: [{ name: 'lookup_probe', parameters: { type: 'object' } }] }));
    assert.deepEqual(chunks.find(c => c.type === 'block-end').block, { type: 'tool-call', id: 'c1', name: 'lookup_probe', arguments: '{"name":"studio"}' });
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
    assert.equal(chunks.at(-1).replayState.response.api, api);
    assert.deepEqual(chunks.find(c => c.type === 'usage').usage, { inputTokens: 15, outputTokens: 4, totalTokens: 24, cacheReadTokens: 5 });
    assert.equal(requests[0].headers.authorization, 'Bearer synthetic');
    assert.equal(requests[0].body.provider, undefined);
    assert.equal(requests[0].redirect, 'error');
    const info = await adapter.resolveModel(p.id, model.id);
    assert.equal(effectiveContextWindow(info.context, info), 28672);
    adapter.fetch = async () => sse(events(api));
    assert.equal((await collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation }))).find(c => c.type === 'block-end').block.text, '你好');
  });
  test(`${api}: test action drives a complete simulated tool round trip without writes`, async () => {
    let count = 0;
    const service = new CustomProviders({ credentials: { resolve: async () => ({ value: 'synthetic' }) }, fetch: async (_url, init) => {
      const body = JSON.parse(init.body); count++;
      if (count === 3) assert(JSON.stringify(body).includes('CUSTOM_TOOL_OK'));
      return sse(events(api, count === 1 ? { text: 'CUSTOM_OK' } : count === 2 ? { call: { name: 'lookup_probe' } } : { text: 'CUSTOM_TOOL_OK' }));
    } });
    const stages = await service.test(profile(api), model.id);
    assert.deepEqual(stages.map(s => s.status), ['passed', 'passed', 'passed', 'not tested']);
    assert.equal(count, 3);
  });
  test(`${api}: interrupted streams fail instead of committing a partial assistant turn`, async () => {
    const p = profile(api);
    const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => 'synthetic', fetch: async () => sse(events(api).slice(0, 1)) });
    await assert.rejects(collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation })), e => e.code === 'TRANSPORT');
  });
}

test('native reasoning is replayed only to its originating provider, model and protocol', () => {
  for (const api of ['responses', 'anthropic']) {
    const p = profile(api), native = api === 'responses' ? [{ type: 'reasoning', id: 'r1', encrypted_content: 'opaque' }] : [{ type: 'thinking', thinking: 'thought', signature: 'opaque' }];
    const assistant = { role: 'assistant', source: { provider: p.id, model: model.id, replayState: { response: { kind: REPLAY_KIND, api, nativeReasoning: native } } }, content: [{ type: 'tool-call', id: 'c1', name: 'lookup_probe', arguments: '{}' }] };
    const options = { messages: [assistant, { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] }] };
    assert(JSON.stringify(requestBody(p, model, options)).includes('opaque'));
    assert(!JSON.stringify(requestBody({ ...p, id: 'custom-other' }, model, options)).includes('opaque'));
    assert(!JSON.stringify(requestBody(p, { ...model, id: 'other' }, options)).includes('opaque'));
  }
});

test('HTTP failures do not expose echoed secrets, and no-auth sends no placeholder key', async () => {
  const p = profile('chat-completions', { auth: 'none' });
  const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => undefined, fetch: async (_url, init) => {
    assert.equal(init.headers.authorization, undefined); return new Response('synthetic-secret', { status: 401 });
  } });
  await assert.rejects(collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation })), e => e.code === 'AUTH' && !JSON.stringify(e).includes('synthetic-secret'));
});

test('HTTP context overflow triggers compaction and Retry-After remains available without raw error text', async () => {
  const p = profile();
  const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => 'synthetic', fetch: async () => Response.json({ error: { message: 'maximum context length exceeded; synthetic-secret', metadata: { error_type: 'context_length_exceeded' } } }, { status: 400 }) });
  await assert.rejects(collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation })), e => e.code === 'CONTEXT_WINDOW_EXCEEDED' && !JSON.stringify(e).includes('synthetic-secret'));
  adapter.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': '2' } });
  await assert.rejects(collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation })), e => e.code === 'RATE_LIMIT' && e.failure.providerRetryAfterMs === 2000);
});

test('cancellation propagates and releases the per-provider queue', async () => {
  const p = profile(), controller = new AbortController(); let calls = 0;
  const adapter = new CustomAdapter({ profile: () => p, resolveKey: async () => 'synthetic', fetch: async (_url, init) => {
    calls++;
    if (calls > 1) return sse(events(p.api));
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  } });
  const first = collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation, signal: controller.signal }));
  await new Promise(resolve => setTimeout(resolve, 10));
  const second = collect(adapter.stream({ provider: p.id, model: model.id, messages: conversation }));
  controller.abort();
  await assert.rejects(first, e => e.code === 'ABORTED');
  assert.equal((await second).at(-1).reason.kind, 'stop');
});
