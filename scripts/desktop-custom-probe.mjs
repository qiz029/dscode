import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==', 'base64');
const protocols = ['chat-completions', 'responses', 'anthropic'];
const events = api => api === 'responses'
  ? [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'DESKTOP_IMAGE_OK' }] }] } }]
  : api === 'anthropic' ? [{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'DESKTOP_IMAGE_OK' } }, { type: 'message_stop' }]
    : [{ choices: [{ delta: { content: 'DESKTOP_IMAGE_OK' }, finish_reason: 'stop' }] }, '[DONE]'];

/** Exercise the packed production providers through a full native Agent. */
export async function verifyDesktopCustom(ctx, reload = false) {
  const service = ctx.get('dscodeCustom');
  assert(service, 'Packed Desktop bundle must mount its custom-provider service');
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie, 'Native Connection must establish a fixture cookie');
  const rpc = async (action, args = {}, headers = { Cookie: cookie, Origin: origin }) => fetch(`${origin}/api/dscode-custom`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-custom', payload: { action, ...args } }),
  });
  const request = async (action, args) => {
    const response = await rpc(action, args);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { result } = await response.json();
    assert.equal(result.ok, true, result.error?.message);
    return result.value;
  };
  assert([401, 403].includes((await rpc('list', {}, {})).status), 'Unauthenticated settings access must fail');
  assert([401, 403].includes((await rpc('list', {}, { Cookie: cookie, Origin: 'https://untrusted.example' })).status), 'Cross-origin settings access must fail');
  const snapshot = await request('list');
  const key = reload ? (await ctx.credentials.resolve('DSCODE_CUSTOM_CUSTOM_DESKTOP_CHAT_COMPLETIONS_API_KEY'))?.value : `synthetic-${randomUUID()}`;
  assert(key?.startsWith('synthetic-'), 'Persisted custom credential missing after restart');
  if (reload) {
    assert.deepEqual(snapshot.providers.map(profile => profile.api).sort(), [...protocols].sort());
    for (const profile of snapshot.providers) {
      assert.deepEqual((await ctx.llm.resolveModelInfo(profile.id, profile.models[0].id)).inputModalities, ['text', 'image']);
      assert.equal(profile.credentialStatus, 'Key saved');
    }
  }
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ path: req.url, headers: req.headers, body });
      const api = req.url.split('/')[1];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events(api).map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
    } catch {
      res.writeHead(500); res.end('Invalid fixture request');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const attachment = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png' });
    const expected = await ctx.attachments.readImageRequest(attachment, { width: 2, height: 2, maxBytes: 1024 * 1024 });
    for (const api of protocols) {
      const id = `custom-desktop-${api}`, model = `vision-${api}`;
      await request('save', { profile: { id, name: `Desktop ${api}`, api, auth: api === 'anthropic' ? 'x-api-key' : 'bearer',
        baseURL: `http://127.0.0.1:${server.address().port}/${api}/v1`,
        models: [{ id: model, contextWindow: 32768, inputModalities: ['text', 'image'] }],
      }, key: reload ? '' : key, revision: (await request('list')).revision });
      const ref = `DSCODE_CUSTOM_${id.replaceAll('-', '_').toUpperCase()}_API_KEY`;
      assert.equal((await ctx.credentials.resolve(ref))?.value === key, true, 'Shared credential resolution failed');
      assert.equal((await ctx.credentials.describe(ref)).source, 'file');
      // Reload the persisted catalog through the production service before use.
      service.revision = undefined;
      await service.refresh();
      assert.deepEqual((await ctx.llm.resolveModelInfo(id, model)).inputModalities, ['text', 'image']);
      assert(ctx.llm.listProviders().some(provider => provider.id === id), 'Custom route missing from native provider catalog');
      assert((await ctx.llm.listModels(id)).some(entry => entry.id === model), 'Custom model missing from native model catalog');
      const handle = await ctx.agents.create({ sessionId: `desktop-custom-${api}-${reload ? 'reloaded' : 'initial'}`, meta: { cwd: process.cwd(), agentPreset: 'dscode' },
        agentOptions: { provider: id, model },
        setup: async (scope, agent) => {
          await ctx.agentPresets.mount(scope, 'dscode');
          installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
        },
      });
      try {
        const before = requests.length;
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [
          { type: 'text', text: 'Inspect this stored screenshot and reply DESKTOP_IMAGE_OK.' }, { type: 'image', attachment },
        ] }));
        await handle.agent.whenIdle();
        const rows = requests.slice(before);
        assert.equal(rows.length, 1, `Expected one model request for ${api}`);
        const { body, path, headers } = rows[0];
        assert.equal(path, `/${api}/v1/` + ({ 'chat-completions': 'chat/completions', responses: 'responses', anthropic: 'messages' })[api]);
        assert.equal(body.model, model);
        assert.equal((api === 'anthropic' ? headers['x-api-key'] : headers.authorization) === (api === 'anthropic' ? key : `Bearer ${key}`), true, 'Credential missing from request');
        assert(!JSON.stringify(body).includes(key), 'Credential leaked into model context');
        const parts = (body.input ?? body.messages).flatMap(message => Array.isArray(message.content) ? message.content : []);
        const images = parts.filter(part => ['input_image', 'image_url', 'image'].includes(part.type));
        assert.equal(images.length, 1, `${api} must carry the durable screenshot`);
        const data = api === 'anthropic' ? images[0].source.data : (api === 'responses' ? images[0].image_url : images[0].image_url.url).split(',')[1];
        assert.deepEqual(Buffer.from(data, 'base64'), Buffer.from(expected.data));
        assert(handle.agent.session.snapshotEvents().some(event => event.type === 'assistant/message'
          && event.data.message.content.some(block => block.type === 'text' && block.text === 'DESKTOP_IMAGE_OK')), 'Native session did not record the assistant response');
      } finally { await handle.dispose(); }
    }
    const catalog = readFileSync(join(process.env.HOME, '.dscode/providers.yaml'), 'utf8');
    const sharedPath = join(process.env.HOME, '.dscode/credentials.yaml');
    assert(!catalog.includes(key), 'Provider catalog must not contain credentials');
    const nativePath = join(resolveDshHome(), '.credentials.yaml');
    assert(readFileSync(nativePath, 'utf8').includes(key), 'Desktop must persist provider keys in the native store');
    assert.equal(statSync(nativePath).mode & 0o777, 0o600);
    // Unrelated native credentials continue using the profile-owned store.
    const nativeKey = `native-${randomUUID()}`;
    await ctx.credentials.set('DESKTOP_FIXTURE_NATIVE_KEY', nativeKey);
    assert.equal((await ctx.credentials.resolve('DESKTOP_FIXTURE_NATIVE_KEY'))?.value === nativeKey, true);
    assert(readFileSync(join(resolveDshHome(), '.credentials.yaml'), 'utf8').includes(nativeKey));
    assert(!existsSync(sharedPath) || !readFileSync(sharedPath, 'utf8').includes(nativeKey));
    return { customImageProtocols: protocols, customCredentialStorage: true, nativeCredentialFallback: true, customHostRestart: reload, customSettingsRpc: true, customSettingsAuth: true };
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
