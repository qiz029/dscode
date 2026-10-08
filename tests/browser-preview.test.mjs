import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserPreview } from '../plugins/browser/preview.mjs';
import { apply as applyDesktop } from '../plugins/browser/desktop-host.mjs';
import { registerBrowserReview } from '../plugins/browser/review.mjs';
import { BrowserConnection } from '../plugins/browser/connection.mjs';

function fixture() {
  const bytes = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(100, 16); bytes.writeUInt32BE(50, 20);
  let now = 1000, allowed = true, image = true;
  const messages = [], writes = [];
  const browser = { pages: [{ id: 1, url: 'https://example.com/', documentId: 'document-1' }], generation: 0, owned: new Set([1]), keep() {}, assertAgentControl: BrowserConnection.prototype.assertAgentControl,
    access: { async checkUrl() { if (!allowed) throw Error('permission denied'); } },
    async call(name) { this.assertAgentControl(); await this.access.checkUrl(); return { content: name === 'take_screenshot' ? [{ type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] : [] }; },
  };
  const ctx = { get: name => name === 'attachments' ? { saveImage: async data => { writes.push(data); return { id: 'saved-image' }; } } : { resolveModelInfo: async () => ({ inputModalities: image ? ['text', 'image'] : ['text'] }) } };
  const agent = { session: { requestHeader: () => undefined }, options: { provider: 'test', model: 'test' }, followup: message => messages.push(message) };
  const preview = new BrowserPreview(browser, () => now);
  return { browser, preview, ctx, agent, messages, writes, setTime: value => { now = value; }, revoke: () => { allowed = false; }, textOnly: () => { image = false; } };
}

test('annotations carry captured pixels, dimensions and coordinates exactly once under concurrent sends', async () => {
  const f = fixture(), frame = await f.preview.capture(1);
  const input = { token: frame.token, x: 1, y: 0.5, text: 'Change this button' };
  const results = await Promise.allSettled([f.preview.annotate(input, f.ctx, f.agent), f.preview.annotate(input, f.ctx, f.agent)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.messages.length, 1); assert.equal(f.writes.length, 1);
  assert.match(f.messages[0].content[0].text, /Point: \(99, 25\)/);
  assert.equal(f.messages[0].content[1].type, 'image');
  await assert.rejects(f.preview.annotate(input, f.ctx, f.agent), /expired|replaced/);
});

for (const during of ['attachment', 'model', 'final-permission']) test(`extension revocation during ${during} prevents annotation admission`, async () => {
  const f = fixture(), frame = await f.preview.capture(1);
  const get = f.ctx.get;
  f.ctx.get = name => {
    const service = get(name);
    if (name === 'attachments' && during === 'attachment') return { saveImage: async data => {
      const attachment = await service.saveImage(data); f.browser.failure = 'Extension sharing was revoked.'; return attachment;
    } };
    if (name === 'llm' && during === 'model') return { resolveModelInfo: async () => {
      f.browser.failure = 'Extension sharing was revoked.'; return { inputModalities: ['text', 'image'] };
    } };
    return service;
  };
  let checks = 0;
  const check = f.browser.access.checkUrl;
  if (during === 'final-permission') f.browser.access.checkUrl = async () => {
    await check(); if (++checks === 3) f.browser.failure = 'Extension sharing was revoked.';
  };
  await assert.rejects(f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Do not send after revoke' }, f.ctx, f.agent), /revoked/);
  assert.equal(f.messages.length, 0);
});

test('expired, replaced, navigated, reconnected, handed-off and revoked previews cannot enqueue annotations', async () => {
  for (const invalidate of [f => f.setTime(62000), f => { f.preview.frame = undefined; }, f => { f.browser.pages[0].url = 'https://elsewhere.example/'; }, f => { f.browser.generation++; }, f => { f.browser.handoff = true; }, f => f.revoke()]) {
    const f = fixture(), frame = await f.preview.capture(1);
    invalidate(f);
    await assert.rejects(f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'hello' }, f.ctx, f.agent));
    assert.equal(f.messages.length, 0); assert.equal(f.writes.length, 0);
  }
});

test('annotation input is bounded and text-only routes retain the screenshot with an offloaded projection', async () => {
  const f = fixture(), frame = await f.preview.capture(1);
  for (const input of [{ x: -1, y: 0, text: 'hello' }, { x: 0, y: NaN, text: 'hello' }, { x: 0, y: 0, text: ' ' }, { x: 0, y: 0, text: 'a'.repeat(4001) }]) await assert.rejects(f.preview.annotate({ token: frame.token, ...input }, f.ctx, f.agent));
  f.textOnly();
  const result = await f.preview.annotate({ token: frame.token, x: 0, y: 0, text: 'hello' }, f.ctx, f.agent);
  assert.equal(result.imageInput, false); assert.equal(f.messages[0].content[1].offloaded, true);
  assert.match(result.message, /model will receive text only/);
  assert.match(result.message, /screenshot is saved in the conversation/);
});

test('model metadata failure preserves the screenshot and reports text-only delivery', async () => {
  const f = fixture(), frame = await f.preview.capture(1), get = f.ctx.get;
  f.ctx.get = name => name === 'llm' ? { resolveModelInfo: async () => { throw Error('Metadata unavailable'); } } : get(name);
  const result = await f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Inspect this point' }, f.ctx, f.agent);
  assert.equal(result.sent, true); assert.equal(result.imageInput, false);
  assert.equal(f.writes.length, 1); assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].content[1].offloaded, true);
  assert.match(result.message, /model will receive text only/);
  assert.match(result.message, /screenshot is saved in the conversation/);
});

for (const revoke of [false, true]) test(`capture RPC refreshes permissions${revoke ? ' and refuses revocation during the read' : ''}`, async t => {
  const f = fixture(); let route;
  const permissions = { developerMode: false, sites: {}, sessionSites: ['https://example.com'] };
  f.browser.access.status = async () => { if (revoke) f.revoke(); return permissions; };
  t.after(registerBrowserReview(f.agent, f.browser));
  applyDesktop({ agents: { get: id => id === 'fixture' ? f.agent : undefined }, logger: { error: assert.fail },
    inject: async (_names, callback) => callback({ effect: fn => fn(), connection: { fetch: { register: options => { route = options; return () => {}; } } } }),
  });
  const response = await route.fetch(new Request('http://localhost/api/dscode-browser', { method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'capture-fixture', method: 'dscode-browser', payload: { sessionId: 'fixture', action: 'capture', pageId: 1 } }),
  }));
  const result = (await response.json()).result;
  if (revoke) { assert.equal(result.ok, false); assert.match(result.error.message, /permission denied/); }
  else { assert.equal(result.ok, true); assert.deepEqual(result.value.permissions, permissions); assert.equal(result.value.url, 'https://example.com/'); }
});


for (const [change, during] of [['navigation', 'attachment'], ['closed', 'attachment'], ['reconnect', 'model'], ['expiry', 'final-permission'], ['abort', 'final-permission']]) {
  test(`${change} during annotation ${during} prevents the final enqueue`, async () => {
    const f = fixture(), frame = await f.preview.capture(1), controller = new AbortController();
    let metadataReady = false, inBrowserCall = false;
    const invalidate = () => {
      if (change === 'navigation') f.browser.pages[0].url = 'https://example.com/new-page';
      if (change === 'closed') f.browser.pages = [];
      if (change === 'reconnect') f.browser.generation++;
      if (change === 'expiry') f.setTime(frame.capturedAt + 60000);
      if (change === 'abort') controller.abort();
    };
    const get = f.ctx.get;
    f.ctx.get = name => {
      const service = get(name);
      if (name === 'attachments') return { saveImage: async data => {
        const result = await service.saveImage(data);
        if (during === 'attachment') invalidate();
        return result;
      } };
      return { resolveModelInfo: async (...args) => {
        const result = await service.resolveModelInfo(...args);
        metadataReady = true;
        if (during === 'model') invalidate();
        return result;
      } };
    };
    const call = f.browser.call.bind(f.browser), check = f.browser.access.checkUrl;
    f.browser.call = async (...args) => { inBrowserCall = true; try { return await call(...args); } finally { inBrowserCall = false; } };
    f.browser.access.checkUrl = async () => {
      await check();
      if (during === 'final-permission' && metadataReady && !inBrowserCall) invalidate();
    };
    await assert.rejects(f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Do not enqueue stale pixels' }, f.ctx, f.agent, controller.signal), /changed|expired|abort/i);
    assert.equal(f.messages.length, 0);
    assert.equal(f.writes.length, 1);
  });
}

test('annotation refreshes observed pages after storing its image', async () => {
  const f = fixture(), frame = await f.preview.capture(1);
  let externalNavigation = false;
  const get = f.ctx.get, call = f.browser.call.bind(f.browser);
  f.ctx.get = name => name === 'attachments' ? { saveImage: async data => {
    const result = await get(name).saveImage(data); externalNavigation = true; return result;
  } } : get(name);
  f.browser.call = async (...args) => {
    if (args[0] === 'list_pages' && externalNavigation) f.browser.pages[0].url = 'https://example.com/externally-navigated';
    return call(...args);
  };
  await assert.rejects(f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Old page' }, f.ctx, f.agent), /changed/);
  assert.equal(f.messages.length, 0);
});

test('a preview expires at exactly sixty seconds before any attachment is written', async () => {
  const f = fixture(), frame = await f.preview.capture(1);
  f.setTime(frame.capturedAt + 60000);
  await assert.rejects(f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Expired' }, f.ctx, f.agent), /expired/);
  assert.equal(f.writes.length, 0); assert.equal(f.messages.length, 0);
});

test('capture age includes screenshot delivery time but starts after listing pages', async () => {
  const f = fixture(), call = f.browser.call.bind(f.browser);
  f.browser.call = async (...args) => {
    const result = await call(...args);
    f.setTime(args[0] === 'take_screenshot' ? 52000 : 2000);
    return result;
  };
  const frame = await f.preview.capture(1);
  assert.equal(frame.capturedAt, 2000);
  f.browser.call = call;
  f.setTime(62000);
  await assert.rejects(f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Expired while returning pixels' }, f.ctx, f.agent), /expired/);
  assert.equal(f.writes.length, 0); assert.equal(f.messages.length, 0);
});

for (const elapsed of [60000, 60001]) test(`capture delayed ${elapsed}ms cannot create a fresh annotation receipt`, async () => {
  const f = fixture(), call = f.browser.call.bind(f.browser);
  let kept = false;
  f.browser.keep = () => { kept = true; };
  f.browser.call = async (...args) => {
    const result = await call(...args);
    if (args[0] === 'take_screenshot') f.setTime(1000 + elapsed);
    return result;
  };
  await assert.rejects(f.preview.capture(1), /expired/);
  assert.equal(f.preview.frame, undefined); assert.equal(kept, false);
  f.browser.call = call;
  const fresh = await f.preview.capture(1);
  assert.equal(fresh.capturedAt, 1000 + elapsed);
  await f.preview.annotate({ token: fresh.token, x: 0.5, y: 0.5, text: 'Fresh pixels' }, f.ctx, f.agent);
  assert.equal(f.messages.length, 1);
});

for (const during of ['before-send', 'attachment', 'capture']) test(`same-URL reload ${during} invalidates the captured document`, async () => {
  const f = fixture(), call = f.browser.call.bind(f.browser), get = f.ctx.get;
  if (during === 'capture') f.browser.call = async (...args) => {
    const result = await call(...args);
    if (args[0] === 'take_screenshot') f.browser.pages[0].documentId = 'document-2';
    return result;
  };
  if (during === 'capture') {
    await assert.rejects(f.preview.capture(1), /changed|navigated/);
    assert.equal(f.preview.frame, undefined);
    return;
  }
  const frame = await f.preview.capture(1);
  if (during === 'before-send') f.browser.pages[0].documentId = 'document-2';
  else f.ctx.get = name => name === 'attachments' ? { saveImage: async data => {
    const result = await get(name).saveImage(data);
    f.browser.pages[0].documentId = 'document-2';
    return result;
  } } : get(name);
  await assert.rejects(f.preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Old document' }, f.ctx, f.agent), /changed/);
  assert.equal(f.messages.length, 0);
  assert.equal(f.writes.length, during === 'attachment' ? 1 : 0);
});

test('capture requires a verifiable document identity', async () => {
  const f = fixture(); delete f.browser.pages[0].documentId;
  await assert.rejects(f.preview.capture(1), /document/);
  assert.equal(f.preview.frame, undefined);
});

for (const kind of ['success', 'error']) test(`resume RPC uses the user command and invalidates old capture on ${kind}`, async t => {
  const f = fixture(), commands = []; let route;
  f.browser.access.status = async () => ({ sites: {}, sessionSites: [] });
  t.after(registerBrowserReview(f.agent, f.browser));
  applyDesktop({ agents: { get: () => f.agent }, logger: { error: assert.fail },
    commands: { execute: async (agent, command, args, signal) => {
      assert.equal(agent, f.agent); assert.deepEqual(args, []); assert(signal instanceof AbortSignal);
      commands.push(command); return { result: { kind, text: kind === 'success' ? 'Browser control resumed.' : 'Handoff remains paused.' } };
    } },
    inject: async (_names, callback) => callback({ effect: fn => fn(), connection: { fetch: { register: options => { route = options; return () => {}; } } } }),
  });
  const rpc = async payload => (await (await route.fetch(new Request('http://localhost/api/dscode-browser', { method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'resume-fixture', method: 'dscode-browser', payload: { sessionId: 'fixture', ...payload } }),
  }))).json()).result;
  const captured = await rpc({ action: 'capture', pageId: 1 }); assert(captured.ok);
  const resumed = await rpc({ action: 'resume' });
  assert.equal(resumed.ok, kind === 'success'); assert.deepEqual(commands, ['/browser resume']);
  const old = await rpc({ action: 'annotate', annotation: { token: captured.value.token, x: 0.5, y: 0.5, text: 'Old capture' } });
  assert.equal(old.ok, false); assert.match(old.error.message, /expired|replaced/);
  assert.equal(f.messages.length, 0);
});

test('idle observation reads current grants and Host state without Chrome or commands', async t => {
  const agent = {}, handoff = { pageId: 7, reason: 'Finish the manual step', focusError: null };
  let route, state = handoff, connected = true, reads = 0, disconnectOnRead = false;
  let permissions = { developerMode: false, sites: {}, sessionSites: ['https://example.com'] };
  const unregister = registerBrowserReview(agent, {
    status: () => ({ connected, handoff: state }), call: assert.fail,
    access: { status: async () => { reads++; if (disconnectOnRead) connected = false; return permissions; } },
  });
  t.after(unregister);
  applyDesktop({ agents: { get: () => agent }, commands: { execute: assert.fail }, logger: { error: assert.fail },
    inject: async (_names, callback) => callback({ effect: fn => fn(), connection: { fetch: { register: options => { route = options; return () => {}; } } } }),
  });
  const observe = async () => (await (await route.fetch(new Request('http://localhost/api/dscode-browser', { method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'handoff-fixture', method: 'dscode-browser', payload: { sessionId: 'fixture', action: 'handoff' } }),
  }))).json()).result;
  assert.deepEqual(await observe(), { ok: true, value: { connected: true, handoff, permissions } });
  permissions = { developerMode: false, sites: { 'https://example.com': { access: 'block', developer: false } }, sessionSites: [] };
  state = null; assert.deepEqual(await observe(), { ok: true, value: { connected: true, handoff: null, permissions } });
  disconnectOnRead = true; state = handoff;
  assert.deepEqual(await observe(), { ok: true, value: { connected: false, handoff: null } });
  assert.equal(reads, 3);
  assert.deepEqual(await observe(), { ok: true, value: { connected: false, handoff: null } });
  unregister();
  assert.deepEqual(await observe(), { ok: true, value: { connected: false, handoff: null } });
  assert.equal(reads, 3, 'Disconnected and missing browsers do not read grants');
});

test('tab RPC can observe transport closure after receiving historical pages and handoff', async t => {
  const agent = {}, pages = [{ id: 1, url: 'https://example.com/', documentId: 'old-document', selected: true }];
  let route, calls = 0;
  const client = {
    listTools: async () => ({ tools: [{ name: 'list_pages' }] }),
    callTool: async () => {
      if (++calls === 2) client.onclose();
      return { content: [], structuredContent: { pages } };
    },
    close: async () => {},
  };
  const browser = new BrowserConnection({ home: '/unused', sessionId: 'refresh-disconnect', config: { mode: 'isolated', headless: true },
    connect: async () => ({ client }), access: { check: async () => {}, status: async () => ({ sites: {}, sessionSites: [] }) },
  });
  t.after(() => browser.close());
  await browser.start();
  browser.handoff = { pageId: 1, reason: 'Manual step' };
  t.after(registerBrowserReview(agent, browser));
  applyDesktop({ agents: { get: () => agent }, commands: { execute: assert.fail }, logger: { error: assert.fail },
    inject: async (_names, callback) => callback({ effect: fn => fn(), connection: { fetch: { register: options => { route = options; return () => {}; } } } }),
  });
  const response = await route.fetch(new Request('http://localhost/api/dscode-browser', { method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'refresh-disconnect', method: 'dscode-browser', payload: { sessionId: 'fixture', action: 'tabs' } }),
  }));
  const result = (await response.json()).result;
  assert.equal(result.ok, true);
  assert.equal(result.value.connected, false);
  assert.equal(result.value.pages[0].id, 1);
  assert.equal(result.value.handoff.pageId, 1);
  assert.equal(calls, 2);
});
