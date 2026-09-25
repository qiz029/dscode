import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { GO_MODELS, OTHER_PROTOCOL_MODELS, goModel } from '../plugins/opencode-go/models.mjs';
import { REPLAY_KIND, explainError, modelReasoning, requestBody } from '../plugins/opencode-go/wire.mjs';
import { OpenCodeGoAdapter } from '../plugins/opencode-go/adapter.mjs';
import { apply as applyGo, resolveOptions } from '../plugins/opencode-go/index.mjs';
import { pickModel, providerSpec } from '../plugins/providers/catalog.mjs';
import { EXA_MCP_URL, ExaSearchProvider, exaSources, mcpText } from '../plugins/opencode-go/search.mjs';
import { RoutedSearchProvider } from '../plugins/openrouter/search.mjs';
import { CLIENT_ID, GRANT_REF, GrantSession, REFRESH_MARGIN_MS, completeGrant, parseGrant, pollDeviceToken, refreshGrant, startDeviceLogin } from '../plugins/opencode-go/oauth.mjs';
import { OpenCodeLogin, openCodeCommand } from '../plugins/opencode-go/command.mjs';
import { clearGoUsage, currentGoUsage, fetchGoUsage, goUsageNow, parseGoUsage, setGoUsage, usageURL } from '../plugins/opencode-go/usage.mjs';
import { goFooterFact } from '../plugins/session-metrics/view.mjs';

const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const conversation = [{ role: 'system', content: [{ type: 'text', text: 'Rules.' }] }, { role: 'user', content: [{ type: 'text', text: 'Do work.' }] }];
const sse = (...events) => events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const collect = async iterable => { const out = []; for await (const item of iterable) out.push(item); return out; };
const body = (model, extra = {}) => requestBody({ model, messages: conversation, ...extra }, { entry: goModel(model) });
const streamed = events => new Response(sse(...events), { headers: { 'content-type': 'text/event-stream' } });
const ACCOUNT = Object.freeze({ apiKey: 'st_access', baseURL: 'https://opencode.ai/inference/go/openai/v1', headers: Object.freeze({ 'x-opencode-org-id': 'org-b' }) });
const adapter = ({ fetch, account = ACCOUNT } = {}) => new OpenCodeGoAdapter({ options: () => resolveOptions({}), resolveAccount: async () => account, version: '9.9.9', fetch });

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
  assert.equal(requests[0].url, 'https://opencode.ai/inference/go/openai/v1/chat/completions', 'requests go to the endpoint the login names');
  assert.equal(requests[0].init.headers.authorization, 'Bearer st_access');
  assert.equal(requests[0].init.headers['x-opencode-org-id'], 'org-b');
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
  const keyless = new OpenCodeGoAdapter({ options: () => resolveOptions({}), resolveAccount: async () => { throw new LlmError('not signed in', 'MISSING_CREDENTIAL'); } });
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
    effect: dispose => { registered.dispose = dispose(); },
  }, {});
  registered.dispose?.();
  assert.deepEqual(registered.directory, [{ provider: 'opencode-go', displayName: 'OpenCode Go', settingsNs: 'dscode-opencode-go', settingsPath: [] }]);
  assert.deepEqual(registered.routes, ['opencode-go']);
  assert(registered.adapter instanceof OpenCodeGoAdapter);
  assert.match(registered.adapter.config.version, /^\d+\.\d+\.\d+/, 'the version comes from the package manifest');
  assert.equal(providerSpec('opencode-go').credentialRef, GRANT_REF, 'the route has no key: its credential is the login');
  assert.equal(providerSpec('opencode-go').login, '/opencode login');
  assert.equal(resolveOptions({}).apiKeyEnv, GRANT_REF);
  await assert.rejects(collect(registered.adapter.stream({ provider: 'opencode-go', model: 'kimi-k3', messages: conversation })),
    error => error.code === 'MISSING_CREDENTIAL' && /run \/opencode login/.test(error.message), 'signed out, a request names the login command');
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

// A fake OpenCode console: device login, token polling with scripted answers, account, orgs, config and refresh.
function fakeConsole({ polls = [], orgs = [{ id: 'org-b', name: 'Beta' }, { id: 'org-a', name: 'Alpha' }], goOrg = 'org-b', refreshes = [] } = {}) {
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, body, headers: init.headers });
    if (path === '/console/auth/device/code') return json({ device_code: 'dev-1', user_code: 'ABCD-EFGH', verification_uri: '/console/device', verification_uri_complete: '/console/device?user_code=ABCD-EFGH&client_id=opencode-cli', expires_in: 600, interval: 5 });
    if (path === '/console/auth/device/token' && body.grant_type === 'refresh_token') { const next = refreshes.shift(); return next.status ? json(next.body, next.status) : json(next); }
    if (path === '/console/auth/device/token') { const next = polls.shift(); return next.status ? json(next.body, next.status) : json(next); }
    if (path === '/console/api/user') return json({ id: 'u1', email: 'dev@example.com' });
    if (path === '/console/api/orgs') return json(orgs);
    if (path === '/console/api/config') {
      const org = init.headers['x-org-id'];
      return json({ config: { provider: org === goOrg ? { 'opencode-go': { api: 'https://opencode.ai/inference/go/openai/v1/', options: { apiKey: '{env:OPENCODE_CONSOLE_TOKEN}' } } } : {} } });
    }
    return json({ error: 'not_found' }, 404);
  };
  return { fetch, calls };
}
const TOKEN = { access_token: 'st_access', refresh_token: 'rt_1', expires_in: 2592000 };
const noSleep = async () => {};

test('the device login polls through pending, slow-down and gateway errors, then keeps the Go organisation and its endpoint', async () => {
  const console_ = fakeConsole({ polls: [{ status: 400, body: { error: 'authorization_pending' } }, { status: 400, body: { error: 'slow_down' } }, { status: 502, body: {} }, TOKEN] });
  const device = await startDeviceLogin({ fetch: console_.fetch, now: 0 });
  assert.equal(device.url, 'https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli');
  assert.equal(device.userCode, 'ABCD-EFGH');
  assert.equal(console_.calls[0].body.client_id, CLIENT_ID);
  const waits = [];
  const token = await pollDeviceToken(device, { fetch: console_.fetch, sleep: async ms => { waits.push(ms); }, now: () => 0 });
  assert.equal(token.access_token, 'st_access');
  assert.deepEqual(waits, [5000, 5000, 10000, 10000], 'slow_down adds five seconds');
  const grant = await completeGrant(token, { fetch: console_.fetch, now: 1000 });
  assert.deepEqual({ ...grant }, { version: 1, access: 'st_access', refresh: 'rt_1', expires: 1000 + 2592000 * 1000, server: 'https://opencode.ai/console', api: 'https://opencode.ai/inference/go/openai/v1', orgID: 'org-b', orgName: 'Beta', email: 'dev@example.com' });
  assert.deepEqual(console_.calls.filter(call => call.path === '/console/api/config').map(call => call.headers['x-org-id']), ['org-a', 'org-b'], 'organisations are tried by name until one has Go');
  assert.deepEqual(parseGrant(JSON.stringify(grant)), grant);
  assert.equal(parseGrant('{"version":1}'), undefined);
  await assert.rejects(completeGrant(TOKEN, { fetch: fakeConsole({ goOrg: 'none' }).fetch }), /no organisation with an OpenCode Go subscription/);
  for (const [answer, message] of [['expired_token', /expired before it was approved/], ['access_denied', /declined/], ['invalid_client', /refused the login: invalid_client/]]) {
    await assert.rejects(pollDeviceToken(device, { fetch: fakeConsole({ polls: [{ status: 400, body: { error: answer } }] }).fetch, sleep: noSleep, now: () => 0 }), message);
  }
  await assert.rejects(pollDeviceToken({ ...device, expiresAt: 0 }, { fetch: console_.fetch, sleep: noSleep, now: () => 1 }), /expired/);
});

test('the grant session refreshes near expiry once, adopts a rotation by another process, and otherwise asks for a new login', async () => {
  let stored;
  const store = { read: async () => stored, write: async value => { stored = value; } };
  const grant = { version: 1, access: 'st_old', refresh: 'rt_1', expires: 10 * 60 * 1000, server: 'https://opencode.ai/console', api: 'https://opencode.ai/inference/go/openai/v1', orgID: 'org-b' };
  let clock = 0;
  const console_ = fakeConsole({ refreshes: [{ access_token: 'st_new', refresh_token: 'rt_2', expires_in: 3600 }] });
  const session = new GrantSession(store, { fetch: console_.fetch, now: () => clock });
  assert.equal(await session.auth(), undefined, 'no login, no account auth');
  stored = JSON.stringify(grant);
  assert.deepEqual(await session.auth(), { apiKey: 'st_old', baseURL: grant.api, headers: { 'x-opencode-org-id': 'org-b' } });
  clock = grant.expires - REFRESH_MARGIN_MS + 1;
  const [first, second] = await Promise.all([session.auth(), session.auth()]);
  assert.equal(first.apiKey, 'st_new');
  assert.equal(second.apiKey, 'st_new');
  assert.equal(console_.calls.filter(call => call.body?.grant_type === 'refresh_token').length, 1, 'concurrent requests share one refresh');
  assert.equal(JSON.parse(stored).refresh, 'rt_2', 'the rotated refresh token is written back');
  assert.equal((await refreshGrant(JSON.parse(stored), { fetch: fakeConsole({ refreshes: [{ access_token: 'a', expires_in: 1 }] }).fetch, now: 0 })).refresh, 'rt_2', 'a refresh without a new token keeps the old one');

  // Another process rotated first: the refused refresh re-reads the store and uses its grant.
  const rotated = { ...grant, access: 'st_other', refresh: 'rt_other', expires: clock + 3600 * 1000 };
  stored = JSON.stringify({ ...grant, expires: clock });
  const raced = new GrantSession({ read: async () => stored, write: async () => { throw new Error('not expected'); } }, { fetch: async (...args) => { stored = JSON.stringify(rotated); return fakeConsole({ refreshes: [{ status: 400, body: { error: 'invalid_grant' } }] }).fetch(...args); }, now: () => clock });
  assert.equal((await raced.auth()).apiKey, 'st_other');
  stored = JSON.stringify({ ...grant, expires: clock });
  const revoked = new GrantSession(store, { fetch: fakeConsole({ refreshes: [{ status: 400, body: { error: 'invalid_grant' } }] }).fetch, now: () => clock });
  await assert.rejects(revoked.auth(), error => error instanceof LlmError && error.code === 'AUTH' && /expired or was revoked; run \/opencode login/.test(error.message));
});

test('/opencode login answers with the code at once, signs in in the background, and reports, cancels and signs out', async () => {
  let stored, release;
  const gate = new Promise(resolve => { release = resolve; });
  const console_ = fakeConsole({ polls: [TOKEN] });
  const opened = [];
  const signals = [];
  const store = { write: async value => { stored = value; }, remove: async () => { stored = undefined; } };
  const login = new OpenCodeLogin({ store, grant: async () => parseGrant(stored), onSignedIn: () => signals.push('signed-in'), fetch: console_.fetch, open: async url => { opened.push(url); return true; }, sleep: () => gate, now: () => 0 });
  const command = openCodeCommand(login, () => 'en');
  const status = async () => (await command.handler({ rawInput: '' })).text;
  assert.match(await status(), /not signed in/);
  const started = await command.handler({ rawInput: 'login' });
  assert.equal(started.kind, 'success');
  assert.match(started.text, /Approve code ABCD-EFGH/);
  assert.match(started.text, /OpenCode CLI/, 'the consent page is named up front');
  assert.deepEqual(opened, ['https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli']);
  assert.match(await status(), /Waiting for approval of code ABCD-EFGH/);
  assert.match((await command.handler({ rawInput: 'login' })).text, /Waiting for approval/, 'a second login shows the one in flight');
  release();
  await login.attempt?.done;
  assert.deepEqual(signals, ['signed-in'], 'a finished login refreshes the usage');
  const signedIn = await status();
  assert.match(signedIn, /Signed in to OpenCode Go as dev@example.com · Beta/);
  assert.match(signedIn, /valid 30 more days/);
  assert.match((await command.handler({ rawInput: 'logout' })).text, /Removed the OpenCode Go login/);
  assert.equal(stored, undefined);
  assert.match((await command.handler({ rawInput: 'cancel' })).text, /No OpenCode Go sign-in is in progress/);
  const pending = new OpenCodeLogin({ store, grant: async () => undefined, fetch: fakeConsole().fetch, open: async () => false, sleep: () => new Promise(() => {}), now: () => 0 });
  assert.match((await pending.login('en')).lines.join('\n'), /Open this URL:/, 'a browser that did not open leaves the URL to open by hand');
  const attempt = pending.attempt;
  assert.match(pending.cancel('en'), /cancelled/);
  assert.equal(attempt.controller.signal.aborted, true, 'cancel stops the polling');
  assert.equal(pending.attempt, undefined);
  const refused = new OpenCodeLogin({ store, grant: async () => undefined, fetch: async () => new Response('{}', { status: 503 }) });
  assert.match((await refused.login('en')).lines[0], /did not start: OpenCode refused to start a login: HTTP 503/);
  assert.equal((await command.handler({ rawInput: 'bogus' })).kind, 'error');
});

test('Go usage comes from the account endpoint with the org header, is cached, and renders in the footer', async t => {
  t.after(() => setGoUsage(undefined, 0));
  assert.equal(usageURL('https://opencode.ai/inference/go/openai/v1'), 'https://opencode.ai/inference/go/v1/usage');
  assert.equal(usageURL('https://opencode.ai/inference/go/openai/v1/'), 'https://opencode.ai/inference/go/v1/usage');
  assert.equal(usageURL('https://example.com/other'), undefined);
  const body = { usage: {
    rolling: { status: 'rate-limited', percent: 100, resetsAt: '2030-01-01T02:00:00.000Z' },
    weekly: { status: 'ok', percent: 42.5, resetsAt: '2030-01-05T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 'n/a' },
    extra: { percent: 1 },
  } };
  assert.deepEqual(parseGoUsage(body), { rolling: { percent: 100, limited: true, resetsAt: '2030-01-01T02:00:00.000Z' }, weekly: { percent: 42.5, resetsAt: '2030-01-05T00:00:00.000Z' }, monthly: {} });
  assert.deepEqual(parseGoUsage({ unexpected: true }), {});
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, headers: init.headers }); return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); };
  const read = await fetchGoUsage(ACCOUNT, { fetch, now: 5 });
  assert.equal(calls[0].url, 'https://opencode.ai/inference/go/v1/usage');
  assert.equal(calls[0].headers.authorization, 'Bearer st_access');
  assert.equal(calls[0].headers['x-opencode-org-id'], 'org-b', 'the endpoint answers 403 without the org');
  assert.equal(read.fetchedAt, 5);
  assert.equal(await fetchGoUsage(ACCOUNT, { fetch: async () => new Response('denied', { status: 403 }) }), undefined);
  assert.equal(await fetchGoUsage(ACCOUNT, { fetch: async () => { throw new Error('offline'); } }), undefined);
  assert.equal(await fetchGoUsage(ACCOUNT, { fetch: async () => new Response('{"shape":"changed"}') }), undefined, 'a changed shape reads as unavailable');

  const home = mkdtempSync(join(tmpdir(), 'dscode-go-usage-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  setGoUsage(undefined, 0);
  calls.length = 0;
  assert.equal(await currentGoUsage({ home, resolveAuth: async () => undefined, fetch, now: 1000 }), undefined, 'signed out, nothing is read');
  assert.equal(calls.length, 0);
  const first = await currentGoUsage({ home, resolveAuth: async () => ACCOUNT, fetch, now: 1000 });
  await currentGoUsage({ home, resolveAuth: async () => ACCOUNT, fetch, now: 30_000 });
  assert.equal(calls.length, 1, 'one read per minute');
  assert.equal((await currentGoUsage({ home, resolveAuth: async () => ACCOUNT, fetch: async () => new Response('', { status: 502 }), now: 70_000 })).weekly.percent, 42.5, 'a failed read keeps the last snapshot');
  setGoUsage(undefined, 0);
  assert.deepEqual(goUsageNow(home, 0).weekly, first.weekly, 'another process reads the snapshot from DSH_HOME');
  clearGoUsage(home);
  assert.equal(goUsageNow(home, 0), undefined, 'signing out clears the snapshot');

  const now = Date.parse('2030-01-01T00:00:00.000Z');
  const fact = goFooterFact(parseGoUsage(body), 'en', now);
  assert.match(fact, /^Go · 5h 100%! · 7d 42\.5% · limited until \d\d-\d\d \d\d:\d\d$/);
  assert.equal(goFooterFact({ rolling: { percent: 12 }, weekly: { percent: 3 }, monthly: { percent: 1 } }, 'en', now), 'Go · 5h 12% · 7d 3% · 30d 1%');
  assert.equal(goFooterFact(undefined, 'en', now), 'Go', 'an unread snapshot shows the plan alone');
  assert.match(goFooterFact(parseGoUsage(body), 'zh-CN', now), /受限至/);
});
