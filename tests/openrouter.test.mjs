import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { ensureOpenRouterModels, openRouterModel, parseOpenRouterModels, setOpenRouterModels } from '../plugins/openrouter/models.mjs';
import { REPLAY_KIND, errorCode, mapUsage, modelReasoning, requestBody, retryAfterMs, serializeMessages, sseData, translate, withCacheBreakpoints } from '../plugins/openrouter/wire.mjs';
import { OpenRouterAdapter } from '../plugins/openrouter/adapter.mjs';
import { OpenRouterSearchProvider, RoutedSearchProvider } from '../plugins/openrouter/search.mjs';
import { apply as applyOpenRouter, resolveOptions } from '../plugins/openrouter/index.mjs';
import { apply as applyMetrics } from '../plugins/session-metrics/index.mjs';
import { readMetrics } from '../plugins/session-metrics/store.mjs';
import { LISTING } from './fixtures/openrouter-listing.mjs';

const MODELS = parseOpenRouterModels(LISTING);
const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const conversation = [{ role: 'system', content: [{ type: 'text', text: 'Rules.' }] }, { role: 'user', content: [{ type: 'text', text: 'Do work.' }] }];
const encoder = new TextEncoder();
async function* chunks(...parts) { for (const part of parts) yield encoder.encode(part); }
const sse = (...events) => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const collect = async iterable => { const out = []; for await (const item of iterable) out.push(item); return out; };
const stream = (model, ...events) => translate(sseData(chunks(sse(...events))), { model });
const withModels = t => { setOpenRouterModels(MODELS); t.after(() => setOpenRouterModels({}, 0)); };

test('the OpenRouter listing supplies context, modalities, tools and reasoning controls', () => {
  assert.equal(MODELS['deepseek/deepseek-v4-flash'].contextWindow, 1024000, 'the routed endpoint bounds the context');
  assert.equal(MODELS['z-ai/glm-5.3-flash'].maxOutput, 131072);
  assert.deepEqual(MODELS['z-ai/glm-5.3-flash'].inputModalities, ['text', 'image']);
  assert.deepEqual(MODELS['z-ai/glm-5.3-flash'].reasoning, { mandatory: true, efforts: ['low', 'high', 'max'], defaultEffort: 'max' });
  assert.deepEqual(MODELS['moonshotai/kimi-k2.6'].reasoning, { mandatory: false });
  assert.equal(MODELS['qwen/qwen3.7-plus'].reasoning, undefined);
  assert(Math.abs(MODELS['qwen/qwen3.7-plus'].cacheWrite - 0.4) < 1e-9, 'cache-write prices are kept per million tokens');
  assert.deepEqual(MODELS['xiaomi/mimo-v2.6-pro'].reasoning, { mandatory: false }, 'a listing without supported_efforts leaves the generic bands');
  assert.equal(MODELS['xiaomi/mimo-v2.6-flash'].contextWindow, 1048576);
  assert.equal(MODELS['black-forest-labs/flux'].textOutput, false);
});

test('a first model lookup waits for the listing, at most once per retry window, and a restart reads the cache', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-openrouter-models-'));
  t.after(() => { setOpenRouterModels({}, 0); rmSync(home, { recursive: true, force: true }); });
  setOpenRouterModels({}, 0);
  let release, calls = 0;
  const slow = () => { calls++; return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => LISTING }); }); };
  const waiting = ensureOpenRouterModels({ home, fetch: slow, timeoutMs: 5000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(openRouterModel('z-ai/glm-5.3-flash'), undefined);
  release();
  await waiting;
  assert.equal(calls, 1);
  assert.equal(openRouterModel('z-ai/glm-5.3-flash').contextWindow, 1048576, 'the lookup answers from the loaded listing');
  setOpenRouterModels({}, 0);
  await ensureOpenRouterModels({ home, fetch: async () => { throw new Error('offline'); } });
  assert.notEqual(openRouterModel('deepseek/deepseek-v4-flash'), undefined, 'a restart reads the cached listing without the network');
  setOpenRouterModels({}, 0);
  rmSync(join(home, 'openrouter-models.json'));
  const unreachable = () => new Promise((_, reject) => setTimeout(() => reject(new Error('unreachable')), 60));
  let started = Date.now();
  await ensureOpenRouterModels({ home, fetch: unreachable, timeoutMs: 20 });
  assert(Date.now() - started < 50, 'an unreachable listing stops waiting at the timeout');
  started = Date.now();
  await ensureOpenRouterModels({ home, fetch: unreachable, timeoutMs: 5000 });
  assert(Date.now() - started < 50, 'and does not stall the next lookup in the same retry window');
  await new Promise(resolve => setTimeout(resolve, 80));
});

test('each model offers its own effort levels, DeepSeek V4 keeps the official detents, and Ultra rides on max', () => {
  assert.deepEqual(modelReasoning('deepseek/deepseek-v4-flash', MODELS['deepseek/deepseek-v4-flash']),
    { levels: ['off', 'low', 'high', 'max', 'ultra'], defaultEffort: 'high', wire: { off: 'none', low: 'high', high: 'high', max: 'xhigh', ultra: 'xhigh' } });
  const glm = modelReasoning('z-ai/glm-5.3-flash', MODELS['z-ai/glm-5.3-flash']);
  assert.deepEqual(glm.levels, ['low', 'high', 'max', 'ultra'], 'mandatory reasoning cannot be turned off');
  assert.equal(glm.defaultEffort, 'high', 'requests default to high like the official route');
  assert.equal(glm.wire.ultra, 'max');
  assert.deepEqual(modelReasoning('moonshotai/kimi-k2.6', MODELS['moonshotai/kimi-k2.6']).levels, ['off', 'low', 'medium', 'high']);
  assert.equal(modelReasoning('qwen/qwen3.7-plus', MODELS['qwen/qwen3.7-plus']), undefined);
  assert.deepEqual(modelReasoning('xiaomi/mimo-v2.6-pro', MODELS['xiaomi/mimo-v2.6-pro']), { levels: ['off', 'low', 'medium', 'high'], defaultEffort: 'high', wire: { off: 'none', low: 'low', medium: 'medium', high: 'high' } });
});

test('request bodies carry the wire effort, the session id, the Ultra policy and only allowed tools', () => {
  const tools = ['bash', 'subagent', 'workflow', 'ralph'].map(tool);
  const before = JSON.stringify(conversation);
  const deepseek = { entry: MODELS['deepseek/deepseek-v4-flash'] }, glm = { entry: MODELS['z-ai/glm-5.3-flash'] };
  const ultra = requestBody({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'ultra', tools, messages: conversation, sessionId: 'session-1', maxTokens: 4096 }, deepseek);
  assert.deepEqual(ultra.reasoning, { effort: 'xhigh' });
  assert.equal(ultra.session_id, 'session-1', 'one session keeps one sticky upstream');
  assert.equal(ultra.max_tokens, 4096, 'endpoints declare max_tokens, so require_parameters keeps them');
  assert.equal(ultra.max_completion_tokens, undefined);
  assert.equal(ultra.provider.require_parameters, true);
  assert.deepEqual(ultra.provider.quantizations, ['int4', 'int8', 'fp6', 'fp8', 'mxfp8', 'fp16', 'bf16', 'fp32', 'unknown'], 'fp4 endpoints are excluded; native INT4 models stay routable');
  assert.deepEqual(ultra.tools.map(entry => entry.function.name), ['bash', 'subagent']);
  assert.match(ultra.messages[0].content, /^Rules\.\n\nDSCODE ULTRA/);
  const low = requestBody({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'low', tools, messages: conversation }, deepseek);
  assert.deepEqual(low.reasoning, { effort: 'high' });
  assert(!JSON.stringify(low.messages).includes('DSCODE ULTRA'));
  assert.equal(low.session_id, undefined);
  assert.equal(low.max_tokens, undefined);
  assert.equal(low.provider.require_parameters, true, 'every request narrows routing the same way');
  assert.deepEqual(requestBody({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'ultra', tools, messages: conversation }, glm).reasoning, { effort: 'max' });
  assert.deepEqual(requestBody({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'max', purpose: 'session-title', messages: conversation }, glm).reasoning, { effort: 'low' }, 'a title uses the lowest level when reasoning cannot be turned off');
  assert.deepEqual(requestBody({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'high', purpose: 'session-title', messages: conversation }, deepseek).reasoning, { effort: 'none' });
  assert.equal(requestBody({ provider: 'openrouter', model: 'qwen/qwen3.7-plus', reasoningEffort: 'high', messages: conversation }, { entry: MODELS['qwen/qwen3.7-plus'] }).reasoning, undefined);
  assert.throws(() => requestBody({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', reasoningEffort: 'off', messages: conversation }, glm), error => error instanceof LlmError && error.code === 'UNSUPPORTED_REASONING_EFFORT');
  assert.equal(JSON.stringify(conversation), before, 'shaping never mutates the logged request');
});

test('Qwen gets explicit cache breakpoints on the system prompt and the latest user turn; implicit-cache models get none', () => {
  const source = { kind: 'model', provider: 'openrouter', model: 'qwen/qwen3.7-plus' };
  const messages = serializeMessages([...conversation, { role: 'assistant', source, content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'More.' }] }], { model: 'qwen/qwen3.7-plus' });
  const marked = withCacheBreakpoints(messages, 'qwen/qwen3.7-plus');
  assert.deepEqual(marked[0].content, [{ type: 'text', text: 'Rules.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(marked[1].content, 'Do work.');
  assert.deepEqual(marked[3].content, [{ type: 'text', text: 'More.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(withCacheBreakpoints(messages, 'z-ai/glm-5.3-flash'), messages);
});

test('history replays reasoning only to the model that produced it, beside its tool calls and results', () => {
  const details = [{ type: 'reasoning.text', text: 'thinking', index: 0, format: 'unknown' }];
  const call = { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' };
  const assistant = (model, replayState) => ({ role: 'assistant', source: { kind: 'model', provider: 'openrouter', model, replayState }, content: [{ type: 'reasoning', text: 'thinking' }, call] });
  const history = [
    ...conversation,
    assistant('z-ai/glm-5.3-flash', { response: { kind: REPLAY_KIND, version: 1, model: 'z-ai/glm-5.3-flash' }, blocks: [{ type: 'reasoning', reasoningDetails: details }, { type: 'tool-call' }] }),
    { role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'a.txt' }] }] },
  ];
  const same = serializeMessages(history, { model: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(same.map(message => message.role), ['system', 'user', 'assistant', 'tool']);
  assert.deepEqual(same[2], { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }], reasoning_details: details });
  assert.deepEqual(same[3], { role: 'tool', tool_call_id: 'call-1', content: 'a.txt' });
  const piAi = serializeMessages([assistant('z-ai/glm-5.3-flash', { response: { kind: 'pi-ai' }, blocks: [{ type: 'reasoning', thinkingSignature: JSON.stringify(details) }, { type: 'tool-call' }] })], { model: 'z-ai/glm-5.3-flash' });
  assert.deepEqual(piAi[0].reasoning_details, details, 'history written through the pi-ai adapter still replays');
  const foreign = serializeMessages(history, { model: 'qwen/qwen3.7-plus' });
  assert.equal(foreign[2].reasoning_details, undefined);
  assert.equal(foreign[2].reasoning, undefined);
  assert.equal(serializeMessages(history, { model: 'deepseek/deepseek-v4-flash' })[2].reasoning_content, '', 'DeepSeek V4 requires reasoning_content on assistant turns');
  assert.equal(serializeMessages(history, { model: 'xiaomi/mimo-v2.6-pro' })[2].reasoning_content, '', 'MiMo needs reasoning_content back in thinking mode');
  assert.equal(serializeMessages(history, { model: 'xiaomi/mimo-v2.6-pro-ultraspeed' })[2].reasoning_content, '', 'the whole MiMo V2.6 family is covered, UltraSpeed included');
  assert.equal(serializeMessages([{ role: 'assistant', source: { kind: 'model', provider: 'openrouter', model: 'x' }, content: [{ type: 'reasoning', text: 'only thinking' }] }], { model: 'x' }).length, 0, 'a reasoning-only turn has nothing a provider accepts');
  assert.equal(serializeMessages([{ role: 'system', content: [] }], { model: 'x' }).length, 0, 'an empty system prompt sends no message');
});

test('the SSE reader skips keep-alive comments and reassembles split lines', async () => {
  let activity = 0;
  const payloads = await collect(sseData(chunks(': OPENROUTER PROCESSING\n\n', 'data: {"a"', ':1}\r\n\r\ndata: [DONE]\n\n'), () => activity++));
  assert.deepEqual(payloads, ['{"a":1}', '[DONE]']);
  assert.equal(activity, 3, 'comments keep the idle clock alive');
});

test('the SSE reader drops a bare data line instead of failing the stream on it', async () => {
  const payloads = await collect(sseData(chunks('data:\n\n', 'data: {"a":1}\n\n', 'data:\ndata:\n\n', 'data: [DONE]\n\n')));
  assert.deepEqual(payloads, ['{"a":1}', '[DONE]']);
});

test('a stream becomes reasoning, text and tool-call blocks, and its finish carries the billed cost and the reasoning details', async () => {
  const out = await collect(stream('z-ai/glm-5.3-flash',
    { id: 'gen-1', provider: 'Z.AI', choices: [{ index: 0, delta: { reasoning: 'Let me ', reasoning_details: [{ type: 'reasoning.text', text: 'Let me ', index: 0, format: 'unknown' }] } }] },
    { id: 'gen-1', choices: [{ index: 0, delta: { reasoning: 'look.', reasoning_details: [{ type: 'reasoning.text', text: 'look.', index: 0 }] } }] },
    { id: 'gen-1', choices: [{ index: 0, delta: { content: 'Listing.' } }] },
    { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command"' } }] } }] },
    { id: 'gen-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { arguments: ':"ls"}' } }] }, finish_reason: 'tool_calls' }] },
    { id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, cost: 0.00042, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 20 } } },
    '[DONE]'));
  assert.deepEqual(out.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block), [
    { type: 'reasoning', text: 'Let me look.' }, { type: 'text', text: 'Listing.' }, { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }]);
  assert.deepEqual(out.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text), ['Let me ', 'look.']);
  assert.deepEqual(out.find(chunk => chunk.type === 'usage').usage, { inputTokens: 200, outputTokens: 50, totalTokens: 1050, cacheReadTokens: 800, reasoningTokens: 20 });
  const finish = out.at(-1);
  assert.deepEqual(finish.reason, { kind: 'tool-calls' });
  assert.deepEqual(finish.replayState, {
    response: { kind: REPLAY_KIND, version: 1, model: 'z-ai/glm-5.3-flash', id: 'gen-1', provider: 'Z.AI', cost: 0.00042 },
    blocks: [{ type: 'reasoning', reasoningDetails: [{ type: 'reasoning.text', text: 'Let me look.', index: 0, format: 'unknown' }] }, { type: 'text' }, { type: 'tool-call' }],
  });
});

test('errors route on OpenRouter codes: upstream stream failures retry as SERVER, credits and context do not', async () => {
  const fail = async error => {
    try {
      await collect(stream('m', { id: 'gen', choices: [{ index: 0, delta: { content: 'part' } }] }, { error, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }));
    } catch (caught) { return caught; }
    return assert.fail('the stream should fail');
  };
  const upstream = await fail({ code: 502, message: 'Provider returned error', metadata: { provider_name: 'Alibaba' } });
  assert(upstream instanceof LlmError);
  assert.equal(upstream.code, 'SERVER');
  assert.equal(upstream.failure.status, 502);
  assert.match(upstream.message, /Provider returned error \(provider: Alibaba\)/);
  assert.equal((await fail({ code: 'server_error', message: 'boom' })).code, 'SERVER');
  assert.equal((await fail({ code: 400, message: 'too long', metadata: { error_type: 'context_length_exceeded' } })).code, 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(errorCode(402, { code: 402, message: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 512.' }), 'QUOTA', 'the status decides, never the numbers in the message');
  assert.equal(errorCode(429, {}), 'RATE_LIMIT');
  assert.equal(errorCode(503, { metadata: { error_type: 'provider_overloaded' } }), 'SERVER');
  assert.equal(errorCode(403, { metadata: { error_type: 'content_policy_violation' } }), 'CONTENT_POLICY');
  assert.equal(errorCode(400, { message: 'bad' }), 'INVALID_REQUEST');
  assert.equal(errorCode(408, {}), 'TIMEOUT');
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs('0'), undefined);
  await assert.rejects(collect(stream('m', { choices: [{ index: 0, delta: { content: 'cut' } }] })), error => error.code === 'TRANSPORT', 'a stream cut before [DONE] is retried');
  const empty = await collect(stream('m', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]'));
  assert.equal(empty.at(-1).reason.failure.code, 'EMPTY_RESPONSE');
  assert.equal(empty.at(-1).replayState, undefined);
  assert.equal(mapUsage({ prompt_tokens: 'x' }), undefined);
});

const adapter = ({ fetch, key = 'sk-or-test' } = {}) => new OpenRouterAdapter({ options: () => resolveOptions({}), resolveApiKey: async () => key, ensureModels: async () => {}, fetch });

test('the adapter resolves models from the listing and sends OpenRouter headers and attribution', async t => {
  withModels(t);
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(sse({ id: 'gen-2', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1, cost: 0.000001 } }, '[DONE]'), { headers: { 'content-type': 'text/event-stream' } });
  };
  const route = adapter({ fetch });
  const glm = await route.resolveModel('openrouter', 'z-ai/glm-5.3-flash');
  assert.deepEqual(glm.context, { contextWindow: 1048576 });
  assert.equal(glm.defaultMaxTokens, 131072);
  assert.deepEqual(glm.inputModalities, ['text', 'image']);
  assert.deepEqual(glm.reasoning.efforts.map(effort => effort.id), ['low', 'high', 'max', 'ultra']);
  assert.equal(glm.reasoning.defaultEffort, 'high');
  const unknown = await route.resolveModel('openrouter', 'vendor/new-model');
  assert.deepEqual(unknown.context, { contextWindow: 262144 });
  assert.equal(unknown.reasoning, undefined);
  assert.deepEqual((await route.listModels('openrouter')).map(model => model.id), ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.6', 'qwen/qwen3.7-plus', 'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro-ultraspeed', 'anthropic/claude-opus-5'], 'the picker lists the curated models that can drive an agent');
  assert.equal((await route.resolveModel('openrouter', 'openai/gpt-4o')).name, 'OpenAI: GPT-4o', 'a model off the list still resolves, so an existing session keeps running');
  const out = await collect(route.stream({ provider: 'openrouter', model: 'moonshotai/kimi-k2.6', reasoningEffort: 'medium', messages: conversation, sessionId: 's-9' }));
  assert.equal(out.at(-1).replayState.response.cost, 0.000001);
  const [request] = requests;
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.init.headers.authorization, 'Bearer sk-or-test');
  assert.equal(request.init.headers['X-OpenRouter-Title'], 'DSCODE');
  assert.equal(request.init.headers['HTTP-Referer'], 'https://github.com/qiz029/dscode');
  assert.deepEqual(request.body.reasoning, { effort: 'medium' });
  assert.equal(request.body.session_id, 's-9');
});

test('rejected requests carry the routed code, the status and Retry-After', async t => {
  withModels(t);
  const reply = (status, body, headers = {}) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const request = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', messages: conversation };
  const failure = async route => {
    try { await collect(route.stream(request)); } catch (error) { return error; }
    return assert.fail('the request should fail');
  };
  const limited = await failure(adapter({ fetch: reply(429, { error: { code: 429, message: 'Rate limited' } }, { 'retry-after': '2' }) }));
  assert.equal(limited.code, 'RATE_LIMIT');
  assert.equal(limited.failure.status, 429);
  assert.equal(limited.failure.providerRetryAfterMs, 2000);
  assert.equal((await failure(adapter({ fetch: reply(402, { error: { code: 402, message: 'requires more credits' } }) }))).code, 'QUOTA');
  const hidden = await failure(adapter({ fetch: reply(200, { error: { code: 503, message: 'No provider', metadata: { error_type: 'provider_unavailable' } } }) }));
  assert.equal(hidden.code, 'SERVER', 'a 200 whose JSON body is only an error is still a failure');
  assert.equal((await failure(adapter({ fetch: async () => { throw new TypeError('fetch failed'); } }))).code, 'TRANSPORT');
  const keyless = new OpenRouterAdapter({ options: () => resolveOptions({}), ensureModels: async () => {}, resolveApiKey: async () => { throw new LlmError('no key', 'MISSING_CREDENTIAL'); } });
  assert.equal((await failure(keyless)).code, 'MISSING_CREDENTIAL');
});

test('web search follows the session route and reads OpenRouter citations', async () => {
  const bodies = [];
  const openrouter = new OpenRouterSearchProvider(() => ({
    baseURL: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-v4-flash', resolveApiKey: async () => 'sk-or-test',
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'x', annotations: [
        { type: 'url_citation', url_citation: { url: 'https://a.example', title: 'A', content: 'alpha' } },
        { type: 'url_citation', url_citation: { url: 'https://a.example', title: 'duplicate' } },
        { type: 'url_citation', url_citation: { url: '' } },
      ] } }] }), { headers: { 'content-type': 'application/json' } });
    },
  }));
  assert.deepEqual(await openrouter.search({ query: 'dscode', maxResults: 3 }), { sources: [{ url: 'https://a.example', title: 'A', snippet: 'alpha' }], truncated: false });
  assert.deepEqual(bodies[0].plugins, [{ id: 'web', engine: 'exa', max_results: 3 }]);
  assert.equal(bodies[0].messages[0].content, 'Search the web for: dscode');
  const keyless = new OpenRouterSearchProvider(() => ({ baseURL: 'https://openrouter.ai/api/v1', model: 'm', resolveApiKey: async () => undefined }));
  await assert.rejects(keyless.search({ query: 'q' }), error => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING');
  const deepseek = { id: 'deepseek-official', available: () => true, search: async () => ({ sources: [], truncated: false }) };
  let route, keys = new Set();
  const router = new RoutedSearchProvider({ openrouter, deepseek: () => deepseek, currentProvider: () => route, hasKey: async ref => keys.has(ref) });
  route = 'openrouter';
  assert.equal(await router.pick(), openrouter);
  route = 'deepseek-official';
  assert.equal(await router.pick(), deepseek);
  route = undefined;
  assert.equal(await router.pick(), deepseek, 'with no key anywhere, DeepSeek reports its own credential error');
  keys = new Set(['OPENROUTER_API_KEY']);
  assert.equal(await router.pick(), openrouter, 'an OpenRouter-only user searches through OpenRouter');
  keys = new Set(['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']);
  assert.equal(await router.pick(), deepseek);
  assert.equal(router.available(), true);
});

test('the plugin registers the configurable route, its adapter and both search providers', async () => {
  const registered = {}, searches = [], injected = {};
  applyOpenRouter({
    logger: { error() {} }, get: () => undefined,
    llm: {
      registerConfigurableProviders: entries => { registered.directory = entries; },
      registerAdapter: (routes, route) => { registered.routes = routes; registered.adapter = route; return Object.assign(() => {}, { replace() {} }); },
    },
    inject: (names, fn) => { injected[names[0]] = fn; },
  }, {});
  assert.deepEqual(registered.directory, [{ provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'llm-openrouter', settingsPath: [] }]);
  assert.deepEqual(registered.routes, ['openrouter']);
  assert(registered.adapter instanceof OpenRouterAdapter);
  injected.web({ web: { registerSearchProvider: provider => searches.push(provider.id), searchProviders: new Map() } });
  assert.deepEqual(searches, ['openrouter', 'dscode-web']);
  assert.throws(() => resolveOptions({ baseURL: 'not a url' }), /baseURL/);
  assert.equal(resolveOptions({ baseURL: 'https://proxy.example/api/v1/' }).baseURL, 'https://proxy.example/api/v1');
});

test('the session ledger records what OpenRouter billed, and estimates only when it reported nothing', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-openrouter-billed-'));
  const old = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old; rmSync(home, { recursive: true, force: true }); });
  let wrapper;
  applyMetrics({ effect() {}, logger: { warn() {} }, on: (_name, fn) => { wrapper = fn; }, agents: { get: () => ({ session: { header: {} } }) } });
  const run = async chunksOut => { for await (const _chunk of wrapper({ provider: 'openrouter', model: 'z-ai/glm-5.3-flash', sessionId: 'root' }, async function* () { yield* chunksOut; })) { /* drain */ } };
  await run([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'stop' }, replayState: { response: { kind: REPLAY_KIND, cost: 0.0123 } } }]);
  await run([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }, { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream', code: 'SERVER' } } }]);
  const ends = readMetrics(home, 'root').rows.filter(row => row.kind === 'end');
  assert.equal(ends[0].cost, 0.0123);
  assert.equal(ends[0].priceVersion, 'openrouter-billed');
  assert.notEqual(ends[1].priceVersion, 'openrouter-billed');
});
