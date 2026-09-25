import test from 'node:test';
import assert from 'node:assert/strict';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { GO_MODELS, OTHER_PROTOCOL_MODELS, goModel } from '../plugins/opencode-go/models.mjs';
import { REPLAY_KIND, explainError, modelReasoning, requestBody } from '../plugins/opencode-go/wire.mjs';
import { OpenCodeGoAdapter } from '../plugins/opencode-go/adapter.mjs';
import { API_KEY_REF, apply as applyGo, resolveOptions } from '../plugins/opencode-go/index.mjs';
import { pickModel, providerSpec } from '../plugins/providers/catalog.mjs';
import { EXA_MCP_URL, ExaSearchProvider, exaSources, mcpText } from '../plugins/opencode-go/search.mjs';
import { RoutedSearchProvider } from '../plugins/openrouter/search.mjs';

const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const conversation = [{ role: 'system', content: [{ type: 'text', text: 'Rules.' }] }, { role: 'user', content: [{ type: 'text', text: 'Do work.' }] }];
const sse = (...events) => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const collect = async iterable => { const out = []; for await (const item of iterable) out.push(item); return out; };
const body = (model, extra = {}) => requestBody({ model, messages: conversation, ...extra }, { entry: goModel(model) });
const streamed = events => new Response(sse(...events), { headers: { 'content-type': 'text/event-stream' } });
const adapter = ({ fetch, key = 'sk-go-test' } = {}) => new OpenCodeGoAdapter({ options: () => resolveOptions({}), resolveApiKey: async () => key, version: '9.9.9', fetch });

test('the catalog offers the reasoning each model accepted on the live gateway', () => {
  assert.deepEqual(modelReasoning(goModel('kimi-k3')), { levels: ['off', 'low', 'high', 'max', 'ultra'], defaultEffort: 'high', wire: { off: 'none', low: 'low', high: 'high', max: 'max', ultra: 'max' } });
  assert.deepEqual(modelReasoning(goModel('glm-5.3')).levels, ['low', 'high', 'max', 'ultra'], 'GLM is thinking-only');
  assert.deepEqual(modelReasoning(goModel('mimo-v2.6-pro')).levels, ['off', 'low', 'high'], 'MiMo V2.6 refuses max, so it offers no Ultra either');
  assert.deepEqual(modelReasoning(goModel('deepseek-v4-pro')).levels, ['high', 'max', 'ultra']);
  assert.equal(modelReasoning(undefined), undefined);
  assert.deepEqual(goModel('glm-5.3').inputModalities, ['text'], 'GLM-5.3 refuses images');
  assert.deepEqual(goModel('glm-5.3-flash').inputModalities, ['text', 'image']);
  for (const [id, entry] of GO_MODELS) {
    assert(!OTHER_PROTOCOL_MODELS.has(id), `${id} is listed under one protocol only`);
    assert(entry.contextWindow > 0 && entry.efforts.length > 0, `${id} is sized and has reasoning`);
  }
});

test('the request keeps to fields every Go upstream accepts', () => {
  const request = body('kimi-k3', { reasoningEffort: 'max', maxTokens: 100, sessionId: 's-1', tools: [tool('read'), tool('workflow')] });
  assert.equal(request.reasoning_effort, 'max');
  assert.deepEqual(request.stream_options, { include_usage: true });
  assert.deepEqual(request.tools.map(entry => entry.function.name), ['read']);
  assert.equal(request.max_tokens, 100);
  for (const field of ['reasoning', 'provider', 'session_id']) assert.equal(request[field], undefined, `${field} is an OpenRouter extension Go upstreams reject`);
  assert.equal(body('kimi-k3', { reasoningEffort: 'off' }).reasoning_effort, 'none');
  assert.equal(body('kimi-k3', { reasoningEffort: 'ultra' }).reasoning_effort, 'max');
  assert.equal(body('glm-5.3', { purpose: 'session-title', reasoningEffort: 'max' }).reasoning_effort, 'low', 'a title takes the lowest level a thinking-only model has');
  assert.equal(body('kimi-k3', { purpose: 'session-title' }).reasoning_effort, 'none');
  assert.throws(() => body('glm-5.3', { reasoningEffort: 'off' }), error => error.code === 'UNSUPPORTED_REASONING_EFFORT');
  assert.equal(body('unlisted-model', { reasoningEffort: 'high' }).reasoning_effort, undefined, 'an uncatalogued model gets no reasoning field');
  const ultra = body('kimi-k3', { reasoningEffort: 'ultra', tools: [tool('subagent')] });
  assert.match(ultra.messages[0].content, /Rules\.\n\n/, 'Ultra appends its policy to the system prompt');
});

test('reasoning replays as reasoning_content only to the model that produced it', () => {
  const turn = (provider, model) => [
    { role: 'user', content: [{ type: 'text', text: 'time?' }] },
    { role: 'assistant', source: { provider, model }, content: [{ type: 'reasoning', text: 'call the tool' }, { type: 'tool-call', id: 'c1', name: 'get_time', arguments: '{}' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '12:34' }] }] },
  ];
  const assistant = (model, provider = 'opencode-go', source = model) => requestBody({ model, messages: turn(provider, source) }, { entry: goModel(model) }).messages.find(message => message.role === 'assistant');
  assert.equal(assistant('kimi-k3').reasoning_content, 'call the tool');
  assert.equal(assistant('kimi-k3').reasoning, undefined);
  assert.equal(assistant('kimi-k3', 'opencode-go', 'glm-5.3').reasoning_content, undefined, 'another model never sees it');
  assert.equal(assistant('kimi-k3', 'openrouter', 'kimi-k3').reasoning_content, undefined, 'another route never sees it');
  assert.equal(assistant('deepseek-v4-pro', 'openrouter').reasoning_content, '', 'DeepSeek still gets the empty field it requires');
});

test('the adapter sends Go headers, translates the stream and stamps its replay kind', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return streamed([
      { id: 'g-1', choices: [{ index: 0, delta: { reasoning: 'think' } }] },
      { id: 'g-1', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } },
      '[DONE]',
    ]);
  };
  const chunks = await collect(adapter({ fetch }).stream({ provider: 'opencode-go', model: 'kimi-k3', messages: conversation, sessionId: 'session-42', reasoningEffort: 'high' }));
  assert.equal(requests[0].url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.equal(requests[0].init.headers.authorization, 'Bearer sk-go-test');
  assert.equal(requests[0].init.headers['x-opencode-session'], 'session-42');
  assert.match(requests[0].init.headers['user-agent'], /^dscode\/9\.9\.9 /, 'Go asks clients to name themselves');
  assert.equal(requests[0].init.headers['X-OpenRouter-Title'], undefined);
  assert.deepEqual(chunks.filter(chunk => chunk.type.endsWith('-delta')).map(chunk => chunk.text), ['think', 'ok']);
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 6, outputTokens: 3, totalTokens: 13, cacheReadTokens: 4 });
  assert.equal(chunks.at(-1).replayState.response.kind, REPLAY_KIND);
});

test('models, refusals and errors name the route', async () => {
  const route = adapter({ fetch: async () => { throw new Error('no request expected'); } });
  const listed = await route.listModels('opencode-go');
  assert.equal(listed.length, GO_MODELS.size);
  const kimi = await route.resolveModel('opencode-go', 'kimi-k3');
  assert.equal(kimi.context.contextWindow, 1048576);
  assert.equal(kimi.reasoning.defaultEffort, 'high');
  assert.equal((await route.resolveModel('opencode-go', 'unlisted')).reasoning, undefined);
  await assert.rejects(collect(route.stream({ provider: 'opencode-go', model: 'qwen3.8-max', messages: conversation })),
    error => error.code === 'INVALID_REQUEST' && /messages endpoint/.test(error.message), 'a messages-protocol model fails before any request');
  const image = [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a1' } }] }];
  await assert.rejects(collect(route.stream({ provider: 'opencode-go', model: 'glm-5.3', messages: image })), /OpenCode Go model "glm-5\.3" does not accept image input/);
  const region = 'Upstream request failed: This Go model requires Global regions. Select Global in your workspace\'s Privacy settings to use it.';
  const refused = adapter({ fetch: async () => new Response(JSON.stringify({ error: { type: 'server_error', message: region } }), { status: 400, headers: { 'content-type': 'application/json' } }) });
  await assert.rejects(collect(refused.stream({ provider: 'opencode-go', model: 'deepseek-v4-flash', messages: conversation })),
    error => error.code === 'INVALID_REQUEST' && error.failure.status === 400 && /Privacy → select Global/.test(error.message));
  assert.equal(explainError('other'), 'other');
  const keyless = new OpenCodeGoAdapter({ options: () => resolveOptions({}), resolveApiKey: async () => { throw new LlmError('no key', 'MISSING_CREDENTIAL'); } });
  await assert.rejects(collect(keyless.stream({ provider: 'opencode-go', model: 'kimi-k3', messages: conversation })), error => error.code === 'MISSING_CREDENTIAL');
});

test('the plugin registers the route, and a provider switch lands on a Go model', async () => {
  const registered = {};
  applyGo({
    logger: { error() {}, warn() {} }, get: () => undefined,
    fiber: { entry: { options: { id: 'dscode-opencode-go' } } },
    on: () => {},
    llm: {
      registerConfigurableProviders: entries => { registered.directory = entries; },
      registerAdapter: (routes, route) => { registered.routes = routes; registered.adapter = route; return Object.assign(() => {}, { replace() {} }); },
    },
    inject: () => {},
  }, {});
  assert.deepEqual(registered.directory, [{ provider: 'opencode-go', displayName: 'OpenCode Go', settingsNs: 'dscode-opencode-go', settingsPath: [] }]);
  assert.deepEqual(registered.routes, ['opencode-go']);
  assert(registered.adapter instanceof OpenCodeGoAdapter);
  assert.match(registered.adapter.config.version, /^\d+\.\d+\.\d+/, 'the version comes from the package manifest');
  assert.equal(providerSpec('opencode-go').credentialRef, API_KEY_REF);
  assert.equal(resolveOptions({ baseURL: 'https://proxy.example/v1/' }).baseURL, 'https://proxy.example/v1');
  const rows = [...GO_MODELS].map(([model, entry]) => ({ provider: 'opencode-go', model, reasoning: { efforts: modelReasoning(entry).levels.map(id => ({ id })) } }));
  const pick = (label, effort) => { const result = pickModel(rows, 'opencode-go', label, effort); return `${result.row.model}@${result.effort}`; };
  assert.equal(pick('deepseek-official/deepseek-flash', 'max'), 'deepseek-v4-flash@max');
  assert.equal(pick('openrouter/z-ai/glm-5.3', 'off'), 'glm-5.3@undefined', 'an effort the target refuses falls back to its default');
  assert.equal(pick('openrouter/moonshotai/kimi-k2.6', 'low'), 'kimi-k2.6@low');
  assert.equal(pick('grok/grok-4.6', 'high'), 'kimi-k3@high', 'no counterpart lands on the default');
});

const EXA_TEXT = [
  'Title: Go\nURL: https://opencode.ai/docs/go/\nPublished: N/A\nAuthor: N/A\nHighlights:\nThe current list of models\n...\nincludes Kimi K3.',
  'Title: Duplicate\nURL: https://opencode.ai/docs/go/\nHighlights:\nignored',
  'Title: No link\nHighlights:\nnothing to cite',
  'Title: Go home\nURL: https://opencode.ai/go\nPublished: N/A',
].join('\n\n---\n\n');
const mcp = text => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } });

test('Exa answers parse from JSON or SSE into de-duplicated, citeable sources', () => {
  assert.equal(mcpText(JSON.stringify(mcp('plain'))), 'plain');
  assert.equal(mcpText(`event: message\ndata: ${JSON.stringify(mcp('streamed'))}\n\n`), 'streamed');
  assert.equal(mcpText('not json'), undefined);
  assert.throws(() => mcpText(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } })), error => error.code === 'WEB_PROVIDER_ERROR' && /rate limited/.test(error.message));
  assert.deepEqual(exaSources(EXA_TEXT), [
    { url: 'https://opencode.ai/docs/go/', title: 'Go', snippet: 'The current list of models\nincludes Kimi K3.' },
    { url: 'https://opencode.ai/go', title: 'Go home' },
  ]);
});

test('Exa search calls the hosted MCP tool, keyless unless EXA_API_KEY is set, and fails as a web error', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url: String(url), init, body: JSON.parse(init.body) }); return new Response(`data: ${JSON.stringify(mcp(EXA_TEXT))}\n\n`, { headers: { 'content-type': 'text/event-stream' } }); };
  let key;
  const exa = new ExaSearchProvider(() => ({ resolveApiKey: async () => key, userAgent: 'dscode/9.9.9', fetch }));
  assert.equal(exa.available(), true);
  const result = await exa.search({ query: 'go models', maxResults: 3 });
  assert.equal(result.sources.length, 2);
  assert.equal(calls[0].url, EXA_MCP_URL);
  assert.equal(calls[0].init.headers['user-agent'], 'dscode/9.9.9');
  assert.deepEqual(calls[0].body.params, { name: 'web_search_exa', arguments: { query: 'go models', type: 'auto', numResults: 3, livecrawl: 'fallback', contextMaxCharacters: 10000 } });
  key = 'exa-key';
  await exa.search({ query: 'q' });
  assert.equal(new URL(calls[1].url).searchParams.get('exaApiKey'), 'exa-key');
  assert.equal(calls[1].body.params.arguments.numResults, 8);
  const broken = new ExaSearchProvider(() => ({ resolveApiKey: async () => { throw new Error('store locked'); }, fetch }));
  await broken.search({ query: 'q' });
  assert.equal(calls[2].url, EXA_MCP_URL, 'an unreadable key store falls back to the keyless endpoint');
  const refused = new ExaSearchProvider(() => ({ fetch: async () => new Response('busy', { status: 429 }) }));
  await assert.rejects(refused.search({ query: 'q' }), error => error.code === 'WEB_PROVIDER_ERROR' && /HTTP 429/.test(error.message));
  const cancelled = new AbortController();
  cancelled.abort();
  const hanging = new ExaSearchProvider(() => ({ fetch: async (_url, init) => { init.signal.throwIfAborted(); } }));
  await assert.rejects(hanging.search({ query: 'q' }, cancelled.signal), error => error.code === 'WEB_ABORTED');
});

test('an OpenCode Go session searches through Exa; other routes keep theirs', async () => {
  const provider = id => ({ id, available: () => true });
  const exa = provider('exa'), openrouter = provider('openrouter'), deepseek = provider('deepseek-official');
  let route;
  const router = new RoutedSearchProvider({ openrouter, deepseek: () => deepseek, exa, currentProvider: () => route, hasKey: async () => true });
  route = 'opencode-go';
  assert.equal(await router.pick(), exa);
  route = 'openrouter';
  assert.equal(await router.pick(), openrouter);
  route = 'deepseek-official';
  assert.equal(await router.pick(), deepseek);
  route = 'grok';
  assert.equal(await router.pick(), deepseek, 'Exa is not a fallback for other routes');
});
