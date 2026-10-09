import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

export const inject = ['agents', 'agentPresets', 'llm', 'credentials', 'connection', 'webServer', 'settings'];
export function apply(ctx) { void run(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function run(ctx) {
  await ctx.get('loader').await();
  const reload = process.env.DSCODE_PROVIDER_RELOAD === '1', base = process.env.DSCODE_PROVIDER_URL;
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const auth = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const rpc = async (payload, headers = { Cookie: cookie, Origin: origin }) => fetch(origin + '/api/dscode-accounts', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-accounts', payload }),
  });
  const request = async payload => {
    const response = await rpc(payload); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(body.result.ok, true, body.result.error?.message); return body.result.value;
  };
  assert([401, 403].includes((await rpc({ action: 'status' }, {})).status));
  assert([401, 403].includes((await rpc({ action: 'status' }, { Cookie: cookie, Origin: 'https://untrusted.example' })).status));
  const providers = ctx.llm.listProviders().map(row => row.id);
  for (const id of ['deepseek-official', 'openrouter', 'dscode-openrouter', 'grok', 'dscode-opencode-go', 'native-fixture']) assert(providers.includes(id), `Missing ${id}`);
  const directory = ctx.llm.listConfigurableProviders();
  assert.equal(directory.find(row => row.provider === 'openrouter').settingsNs, 'llm-pi-ai');
  assert.equal(directory.find(row => row.provider === 'dscode-openrouter').settingsNs, 'dscode-openrouter');
  const before = await request({ action: 'status' });
  const authPath = join(process.env.HOME, '.grok/auth.json');
  if (!reload) {
    assert.equal(before.openrouter.configured, false);
    assert.equal(before.grok.configured, false);
    assert.equal(before.opencode.configured, false);
    await request({ action: 'save-openrouter', key: 'desktop-provider-fixture-key' });
    await ctx.credentials.set('NATIVE_FIXTURE_KEY', 'native-fixture-key');
    mkdirSync(join(process.env.HOME, '.grok'));
    writeFileSync(authPath, JSON.stringify({ 'https://auth.x.ai::fixture': { key: 'grok-fixture-token', refresh_token: 'unchanged-refresh', expires_at: new Date(Date.now() + 86400000).toISOString() } }));
    await ctx.credentials.set('OPENCODE_OAUTH', JSON.stringify({ version: 1, access: 'go-fixture-token', refresh: 'go-fixture-refresh',
      expires: Date.now() + 86400000, server: base + '/console', api: base + '/go/v1', orgID: 'fixture-org' }));
  } else {
    assert(before.openrouter.configured && before.grok.configured && before.opencode.configured);
  }
  const grokBytes = readFileSync(authPath, 'utf8');
  const snapshot = await request({ action: 'status' });
  assert.equal(snapshot.grok.writable, false); assert.equal(snapshot.opencode.writable, false);
  assert(!JSON.stringify(snapshot).includes('fixture-token'));
  assert(!JSON.stringify(snapshot).includes('desktop-provider-fixture-key'));
  assert.equal((await ctx.credentials.resolve('OPENROUTER_API_KEY')).value, 'desktop-provider-fixture-key');
  const model = await ctx.llm.resolveModelInfo('dscode-openrouter', 'deepseek/deepseek-v4-flash');
  assert(model.reasoning.efforts.some(effort => effort.id === 'ultra'));
  for (const [provider, model, reasoningEffort] of [
    ['openrouter', 'native-fixture'], ['native-fixture', 'native-fixture'],
    ['dscode-openrouter', 'deepseek/deepseek-v4-flash', 'ultra'], ['grok', 'grok-4.6', 'high'], ['dscode-opencode-go', 'kimi-k3', 'high'],
  ]) {
    const handle = await ctx.agents.create({ sessionId: `provider-${provider}-${reload}`, meta: { cwd: process.cwd(), agentPreset: 'dscode' },
      agentOptions: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
      setup: async (scope, agent) => { await ctx.agentPresets.mount(scope, 'dscode'); installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }); },
    });
    try {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Answer PROVIDER_ROUTE_OK.' }] }));
      await handle.agent.whenIdle();
      assert(handle.agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === 'PROVIDER_ROUTE_OK')), `${provider} did not complete the native Agent turn`);
    } finally { await handle.dispose(); }
  }
  assert.equal(readFileSync(authPath, 'utf8'), grokBytes, 'Grok login must remain untouched');
  if (reload) {
    await request({ action: 'logout-opencode' });
    assert.equal((await request({ action: 'status' })).opencode.configured, false);
    const chunks = [];
    for await (const chunk of ctx.llm.stream({ provider: 'dscode-opencode-go', model: 'kimi-k3', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Signed out probe' }] })] })) chunks.push(chunk);
    assert.match(JSON.stringify(chunks), /opencode login/);
  }
  console.log('DESKTOP_PROVIDERS_PASSED ' + JSON.stringify({ reload, nativeProvidersPreserved: true, openrouterUltra: true,
    grokLoginReadOnly: true, goGrantAndLogout: true, accountRpcAuth: true, credentialRedaction: true, liveModelInference: false }));
  ctx.get('appExit')(0);
}
