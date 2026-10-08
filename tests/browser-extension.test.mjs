import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { SharedTabs } from '../extensions/browser/protocol.mjs';
import { createExtensionRelay, extensionId } from '../plugins/browser/extension-relay.mjs';

async function fixture(t) {
  const events = [], commands = [], detached = [], removed = [];
  const metadata = new Map([[1, { id: 1, url: 'https://shared.example/', title: 'Shared' }],
    [2, { id: 2, url: 'https://private.example/', title: 'Private' }]]);
  const api = { tabs: {
    get: async id => ({ ...metadata.get(id) }),
    create: async ({ url }) => { const tab = { id: 3, url }; metadata.set(3, tab); return tab; },
    remove: async id => { removed.push(id); }, update: async id => ({ ...metadata.get(id) }),
  }, debugger: {
    attach: async () => {}, detach: async ({ tabId }) => { detached.push(tabId); },
    sendCommand: async (source, method, params) => {
      commands.push({ source, method, params });
      return method === 'Target.getTargetInfo' ? { targetInfo: { targetId: `real-${source.tabId}` } } : { value: 'scoped' };
    },
  }, version: () => ({ product: 'Chrome/test' }) };
  const tabs = new SharedTabs(api, event => events.push(event));
  t.after(() => tabs.stop());
  await tabs.share(1);
  return { tabs, events, commands, detached, removed, api };
}

test('extension exposes only explicitly shared targets and scopes attachment/activation/close', async t => {
  const { tabs, events, commands, removed } = await fixture(t);
  const targets = await tabs.command({ method: 'Target.getTargets' });
  assert.equal(targets.targetInfos.length, 2);
  assert(targets.targetInfos.every(info => info.url === 'https://shared.example/'));
  for (const method of ['Target.attachToTarget', 'Target.activateTarget', 'Target.closeTarget']) {
    await assert.rejects(tabs.command({ method, params: { targetId: 'real-2', flatten: true } }), /not shared/);
  }
  assert.equal(removed.length, 0);
  await tabs.command({ method: 'Target.setAutoAttach', params: { flatten: true, autoAttach: true } });
  const parent = events.find(e => e.method === 'Target.attachedToTarget').params.sessionId;
  await tabs.command({ method: 'Target.setAutoAttach', sessionId: parent, params: { flatten: true, autoAttach: true } });
  const child = events.filter(e => e.method === 'Target.attachedToTarget').at(-1).params.sessionId;
  await tabs.command({ method: 'DOM.getDocument', sessionId: child });
  assert.deepEqual(commands.at(-1).source, { tabId: 1 });
  assert(commands.every(c => c.source.tabId === 1));
});

test('extension rejects browser-wide cookie and target commands rather than forwarding them', async t => {
  const { tabs, commands } = await fixture(t);
  const { sessionId } = await tabs.command({ method: 'Target.attachToTarget', params: { targetId: 'real-1', flatten: true } });
  const count = commands.length;
  for (const method of ['Browser.close', 'Storage.getCookies', 'Storage.clearDataForOrigin', 'Target.createBrowserContext', 'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie']) {
    await assert.rejects(tabs.command({ method, sessionId }), /outside shared-tab scope/);
  }
  assert.equal(commands.length, count);
});

test('extension routes flattened child frames without exposing events from unshared tabs', async t => {
  const { tabs, events, commands } = await fixture(t);
  const { sessionId } = await tabs.command({ method: 'Target.attachToTarget', params: { targetId: 'real-1', flatten: true } });
  const before = events.length;
  tabs.debuggerEvent({ tabId: 2 }, 'Runtime.consoleAPICalled', { secret: 'private' });
  assert.equal(events.length, before);
  tabs.debuggerEvent({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'frame', targetInfo: { targetId: 'iframe', type: 'iframe' } });
  const child = events.at(-1).params.sessionId;
  assert.equal(events.at(-1).sessionId, sessionId);
  await tabs.command({ method: 'DOM.getDocument', sessionId: child });
  assert.deepEqual(commands.at(-1).source, { tabId: 1, sessionId: 'frame' });
  await assert.rejects(tabs.command({ method: 'Target.getTargetInfo', params: { targetId: 'private' }, sessionId: child }), /not shared/);
  tabs.debuggerEvent({ tabId: 1, sessionId: 'frame' }, 'Page.frameNavigated', { frame: { url: 'https://frame.example/' } });
  assert.equal(events.at(-1).sessionId, child);
});

test('extension detachment removes descendants before their parent without disturbing other routes', async t => {
  for (const mode of ['native-child', 'client-root', 'tab-close']) await t.test(mode, async t => {
    const { tabs, events, commands } = await fixture(t);
    await tabs.share(2);
    const { sessionId: root } = await tabs.command({ method: 'Target.attachToTarget', params: { targetId: 'real-1', flatten: true } });
    const { sessionId: other } = await tabs.command({ method: 'Target.attachToTarget', params: { targetId: 'real-2', flatten: true } });
    tabs.debuggerEvent({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'frame', targetInfo: { targetId: 'frame-target', type: 'iframe' } });
    const child = events.at(-1).params.sessionId;
    tabs.debuggerEvent({ tabId: 1, sessionId: 'frame' }, 'Target.attachedToTarget', { sessionId: 'worker', targetInfo: { targetId: 'worker-target', type: 'worker' } });
    const nested = events.at(-1).params.sessionId;
    tabs.debuggerEvent({ tabId: 1 }, 'Target.attachedToTarget', { sessionId: 'sibling', targetInfo: { targetId: 'sibling-target', type: 'worker' } });
    const sibling = events.at(-1).params.sessionId, before = events.length;
    if (mode === 'native-child') tabs.debuggerEvent({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 'frame' });
    else if (mode === 'client-root') await tabs.command({ method: 'Target.detachFromTarget', params: { sessionId: root } });
    else tabs.remove(1);
    assert(!tabs.sessions.has(nested), 'A detached parent must not leave a nested worker route behind');
    assert(!tabs.sessions.has(child)); assert(tabs.sessions.has(other));
    assert.equal(tabs.sessions.has(root), mode === 'native-child');
    assert.equal(tabs.sessions.has(sibling), mode === 'native-child');
    const detached = events.slice(before).filter(event => event.method === 'Target.detachedFromTarget');
    assert.equal(detached[0].params.sessionId, nested);
    assert.equal(detached[0].sessionId, child);
    assert.equal(detached[1].params.sessionId, child);
    const count = commands.length;
    for (const sessionId of [child, nested]) await assert.rejects(tabs.command({ method: 'Runtime.evaluate', sessionId, params: { expression: '1' } }), /Unknown shared session/);
    assert.equal(commands.length, count, 'Stale commands must not reach Chrome');
    const after = events.length;
    tabs.debuggerEvent({ tabId: 1, sessionId: 'worker' }, 'Runtime.consoleAPICalled', { args: ['late'] });
    tabs.debuggerEvent({ tabId: 1 }, 'Target.detachedFromTarget', { sessionId: 'frame' });
    assert.equal(events.length, after, 'Late descendant events and repeated detachment must be ignored');
    await tabs.command({ method: 'DOM.getDocument', sessionId: other });
    assert.equal(commands.at(-1).source.tabId, 2);
  });
});

test('extension revocation detaches shared tabs and rejects all later commands', async t => {
  const { tabs, detached, commands } = await fixture(t);
  await tabs.stop();
  const count = commands.length;
  await assert.rejects(tabs.command({ method: 'Target.getTargets' }), /Sharing has ended/);
  await assert.rejects(tabs.share(2), /Sharing has ended/);
  assert.deepEqual(detached, [1]);
  assert.equal(commands.length, count);
});

test('extension detach race cannot retain a debugging attachment after stop', async t => {
  const { tabs, api, detached } = await fixture(t);
  let finish;
  api.debugger.attach = () => new Promise(resolve => { finish = resolve; });
  const sharing = tabs.share(2);
  await new Promise(resolve => setImmediate(resolve));
  await tabs.stop();
  finish();
  await assert.rejects(sharing, /Sharing has ended/);
  assert.deepEqual(detached, [1, 2]);
  assert.equal(tabs.tabs.size, 0);
});

function connect(url, options) {
  const socket = new WebSocket(url, options);
  return once(socket, 'open').then(() => socket);
}

test('revocation during target lookup cannot publish or retain a late attachment', async t => {
  const { tabs, api, detached, events } = await fixture(t);
  await tabs.command({ method: 'Target.setDiscoverTargets', params: { discover: true } });
  await tabs.command({ method: 'Target.setAutoAttach', params: { flatten: true, autoAttach: true } });
  const entered = Promise.withResolvers(), lookup = Promise.withResolvers();
  api.debugger.sendCommand = async (source, method) => {
    assert.equal(source.tabId, 2); assert.equal(method, 'Target.getTargetInfo');
    entered.resolve(); return lookup.promise;
  };
  const sharing = tabs.share(2);
  await entered.promise;
  await tabs.stop();
  assert.deepEqual(detached, [1, 2], 'Stopping must detach the in-flight connection before target lookup finishes');
  const count = events.length;
  lookup.resolve({ targetInfo: { targetId: 'late-target' } });
  await assert.rejects(sharing, /Sharing has ended/);
  assert.deepEqual(detached, [1, 2], 'The in-flight native attachment must be detached when lookup finishes');
  assert.equal(tabs.tabs.size, 0); assert.equal(tabs.sessions.size, 0);
  assert.equal(events.length, count, 'Cancelled sharing must not emit a discovered or attached target');
});

test('a tab closed during target lookup cannot reappear in shared targets', async t => {
  const { tabs, api, events } = await fixture(t);
  const entered = Promise.withResolvers(), lookup = Promise.withResolvers();
  api.debugger.sendCommand = async () => { entered.resolve(); return lookup.promise; };
  const sharing = tabs.share(2);
  await entered.promise;
  tabs.remove(2);
  const count = events.length;
  lookup.resolve({ targetInfo: { targetId: 'closed-target' } });
  await assert.rejects(sharing, /Sharing has ended/);
  assert.deepEqual([...tabs.tabs.keys()], [1]);
  assert.deepEqual([...tabs.attachedTabs], [1]);
  assert.equal(events.length, count);
});

test('relay authenticates each role and origin, rejects duplicate clients and revokes on loss', async t => {
  const relay = await createExtensionRelay();
  t.after(() => relay.close());
  await assert.rejects(connect(relay.endpoint), /403/);
  await assert.rejects(connect(relay.pairingUrl, { origin: 'https://attacker.example' }), /403/);
  await assert.rejects(connect(relay.pairingUrl, { origin: `chrome-extension://${extensionId}`, headers: { Host: 'attacker.example' } }), /403/);
  await assert.rejects(connect(relay.pairingUrl.replace(/token=./, 'token=x'), { origin: `chrome-extension://${extensionId}` }), /403/);
  const extension = await connect(relay.pairingUrl, { origin: `chrome-extension://${extensionId}` });
  extension.send(JSON.stringify({ type: 'ready' }));
  for (let i = 0; i < 50 && !relay.ready; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(relay.ready);
  await assert.rejects(connect(relay.endpoint, { origin: 'https://attacker.example' }), /403/);
  const client = await connect(relay.endpoint);
  await assert.rejects(connect(relay.endpoint), /403/);
  const request = once(extension, 'message');
  client.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }));
  assert.equal(JSON.parse((await request)[0]).method, 'Target.getTargets');
  const response = once(client, 'message');
  extension.send(JSON.stringify({ id: 1, result: { targetInfos: [] } }));
  assert.deepEqual(JSON.parse((await response)[0]).result.targetInfos, []);
  const ended = once(client, 'close');
  extension.close();
  await ended;
  assert(relay.closed);
  assert(!relay.ready);
});
