import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { SharedTabs } from '../extensions/browser/protocol.mjs';

function fixture(t, { autoOpen = true } = {}) {
  let listener, badge = '';
  const sockets = [], attached = new Set(), timers = new Map();
  const event = () => ({ addListener() {} });
  const chrome = {
    runtime: { id: 'fixture-extension', getURL: path => `chrome-extension://fixture-extension/${path}`, onMessage: { addListener: fn => { listener = fn; } } },
    tabs: { get: async id => ({ id, title: `Tab ${id}`, url: `https://example.com/${id}` }), onUpdated: event(), onRemoved: event() },
    debugger: {
      attach: async ({ tabId }) => { attached.add(tabId); },
      detach: async ({ tabId }) => { attached.delete(tabId); },
      sendCommand: async ({ tabId }) => ({ targetInfo: { targetId: `target-${tabId}` } }),
      onEvent: event(), onDetach: event(),
    },
    action: { setBadgeText: async ({ text }) => { badge = text; }, setBadgeBackgroundColor: async () => {} },
  };
  class Socket {
    static OPEN = 1;
    constructor() { this.readyState = autoOpen ? 1 : 0; sockets.push(this); if (autoOpen) queueMicrotask(() => this.onopen?.()); }
    send() {}
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
  }
  const source = readFileSync(new URL('../extensions/browser/worker.mjs', import.meta.url), 'utf8');
  const importLine = "import { SharedTabs } from './protocol.mjs';";
  assert(source.includes(importLine));
  runInNewContext(source.replace(importLine, ''), { chrome, SharedTabs, WebSocket: Socket, URL,
    navigator: { userAgent: 'Chrome/150.0.0' }, setTimeout: fn => { const id = {}; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval() {} });
  const request = payload => new Promise(resolve => {
    assert.equal(listener(payload, { id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html') }, resolve), true);
  });
  const pair = tabId => request({ action: 'pair', tabId, url: `ws://127.0.0.1:12345/extension?token=${'a'.repeat(64)}` });
  t.after(() => request({ action: 'stop' }));
  return { chrome, request, pair, sockets, attached, timers, get badge() { return badge; } };
}

test('pending pairing is visible to a reopened popup and stop promptly releases the handshake', async t => {
  const f = fixture(t, { autoOpen: false });
  let settled;
  const pairing = f.pair(1).then(result => { settled = result; });
  await new Promise(setImmediate);
  const status = await f.request({ action: 'status' });
  try {
    assert.equal(status.pending, true);
    assert.match(status.message, /Pairing/);
    await f.request({ action: 'stop' });
    await new Promise(setImmediate);
    assert.match(settled?.error ?? '', /cancelled/i, 'Stop must settle pairing without waiting for its timeout');
    assert.equal(f.timers.size, 0);
    assert.equal(f.attached.size, 0);
    assert.equal((await f.request({ action: 'status' })).pending, false);
    const next = f.pair(2);
    await new Promise(setImmediate);
    f.sockets.at(-1).readyState = 1; f.sockets.at(-1).onopen();
    assert.equal((await next).connected, true);
  } finally {
    for (const fn of [...f.timers.values()]) fn();
    await pairing;
  }
});

for (const outcome of ['close', 'error', 'timeout']) test(`failed pairing releases its connection wait after ${outcome}`, async t => {
  const f = fixture(t, { autoOpen: false });
  const pairing = f.pair(1);
  await new Promise(setImmediate);
  if (outcome === 'close') f.sockets[0].close();
  else if (outcome === 'error') f.sockets[0].onerror();
  else [...f.timers.values()][0]();
  const result = await pairing;
  assert.match(result.error, /Could not connect/);
  assert.equal(f.timers.size, 0);
  assert.equal(f.attached.size, 0);
  assert.equal(f.sockets[0].readyState, 3);
  const status = await f.request({ action: 'status' });
  assert.equal(status.pending, false); assert.equal(status.connected, false);
  assert.match(status.message, /Could not connect/);
});

test('worker stop closes its socket, detaches its tabs and clears the sharing badge', async t => {
  const f = fixture(t);
  assert.equal((await f.pair(1)).connected, true);
  assert.equal(f.badge, 'ON');
  assert.equal((await f.request({ action: 'stop' })).connected, false);
  assert.equal(f.badge, ''); assert.equal(f.attached.size, 0); assert.equal(f.sockets[0].readyState, 3);
});

test('an old stop finishing after a new pairing cannot erase its active sharing badge', async t => {
  const f = fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  await f.pair(1);
  const detach = f.chrome.debugger.detach;
  f.chrome.debugger.detach = async args => {
    if (args.tabId === 1) { entered.resolve(); await release.promise; }
    return detach(args);
  };
  const stopping = f.request({ action: 'stop' });
  await entered.promise;
  try { assert.equal((await f.pair(2)).connected, true); }
  finally { release.resolve(); }
  await stopping;
  const status = await f.request({ action: 'status' });
  assert.equal(status.connected, true); assert.equal(status.shared.length, 1);
  assert.equal(status.shared[0].url, 'https://example.com/2');
  assert.equal(f.badge, 'ON', 'The badge must agree with the active sharing session');
  assert.deepEqual([...f.attached], [2]);
  assert.equal(f.sockets[0].readyState, 3); assert.equal(f.sockets[1].readyState, 1);
});
