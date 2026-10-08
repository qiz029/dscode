import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const status = connected => ({ connected, message: connected ? 'Sharing with DSCODE.' : 'Sharing stopped.', shared: connected ? [{ title: 'Shared tab' }] : [] });
async function fixture(dispatch, query = async () => [{ id: 1 }]) {
  const timers = [];
  const elements = Object.fromEntries(['pairing', 'pair', 'share', 'stop', 'status', 'tabs'].map(id => [id, {
    value: 'pairing-link', hidden: ['share', 'stop'].includes(id), disabled: false, textContent: '',
    addEventListener(_event, handler) { this.handler = handler; },
    click() { if (!this.disabled && !this.hidden) return this.handler(); },
    replaceChildren(...children) { this.children = children; },
  }]));
  await runInNewContext('(async () => {\n' + readFileSync(new URL('../extensions/browser/popup.mjs', import.meta.url), 'utf8') + '\n})()', {
    document: { getElementById: id => elements[id], createElement: () => ({}) },
    chrome: { tabs: { query }, runtime: { sendMessage: dispatch } },
    setTimeout: fn => timers.push(fn),
  });
  elements.refresh = () => timers.shift()?.();
  return elements;
}

test('reopened popup exposes pending pairing and refreshes when it connects', async () => {
  let result = { ...status(false), pending: true, message: 'Pairing with DSCODE.' };
  const ui = await fixture(() => Promise.resolve(result));
  assert.equal(ui.stop.hidden, false);
  assert.equal(ui.stop.disabled, false);
  assert.equal(ui.pair.disabled, true);
  result = status(true);
  await ui.refresh();
  assert.equal(ui.share.hidden, false);
  assert.equal(ui.share.disabled, false);
  assert.equal(ui.status.textContent, 'Sharing with DSCODE.');
});

test('stopping a reopened pending pairing invalidates its scheduled refresh', async () => {
  const requests = [];
  const ui = await fixture(request => {
    requests.push(request.action);
    return Promise.resolve(request.action === 'status' ? { ...status(false), pending: true } : status(false));
  });
  assert.equal(ui.stop.hidden, false);
  await ui.stop.click();
  await ui.refresh();
  assert.deepEqual(requests, ['status', 'stop']);
  assert.equal(ui.stop.hidden, true);
  assert.equal(ui.pair.disabled, false);
});

test('open sharing popup follows changed tabs and a remote disconnect without reopening', async () => {
  let result = status(true);
  const ui = await fixture(() => Promise.resolve(result));
  assert.equal(ui.tabs.children.length, 1);
  result = { ...status(true), shared: [] };
  await ui.refresh();
  assert.equal(ui.tabs.children.length, 0, 'Closed shared tabs must leave the visible list');
  assert.equal(ui.share.hidden, false, 'A connection can remain available with no shared tabs');
  result = { ...status(false), message: 'DSCODE disconnected. Pair again to share.' };
  await ui.refresh();
  assert.equal(ui.pair.hidden, false);
  assert.equal(ui.share.hidden, true);
  assert.equal(ui.stop.hidden, true);
  assert.equal(ui.status.textContent, result.message);
});

for (const outcome of ['resolve', 'reject']) test(`background status does not disable sharing controls or overwrite stop on late ${outcome}`, async () => {
  let reads = 0;
  const pending = Promise.withResolvers();
  pending.promise.catch(() => {}); // A pre-fix popup never starts the second read.
  const ui = await fixture(request => {
    if (request.action === 'status' && ++reads > 1) return pending.promise;
    return Promise.resolve(status(request.action !== 'stop'));
  });
  const polling = ui.refresh();
  try {
    assert.equal(reads, 2, 'A connected popup must refresh status');
    assert.equal(ui.share.disabled, false);
    assert.equal(ui.stop.disabled, false);
    await ui.stop.click();
  } finally {
    if (outcome === 'resolve') pending.resolve(status(true)); else pending.reject(Error('Old status failed'));
    await polling;
  }
  assert.equal(ui.status.textContent, 'Sharing stopped.');
  assert.equal(ui.pair.hidden, false);
  assert.equal(ui.stop.hidden, true);
});

for (const outcome of ['resolve', 'reject']) test(`stop remains available during sharing and ignores its late ${outcome}`, async () => {
  const entered = Promise.withResolvers(), pending = Promise.withResolvers(), requests = [];
  const ui = await fixture(request => {
    requests.push(request.action);
    if (request.action === 'share') { entered.resolve(); return pending.promise; }
    return Promise.resolve(status(request.action === 'status'));
  });
  const sharing = ui.share.click(); await entered.promise;
  try {
    assert.equal(ui.stop.disabled, false, 'Revocation must not wait for a pending share');
    await ui.stop.click();
    assert.equal(ui.status.textContent, 'Sharing stopped.');
  } finally {
    if (outcome === 'resolve') pending.resolve(status(true)); else pending.reject(Error('Old share failed'));
    await sharing;
  }
  assert.deepEqual(requests, ['status', 'share', 'stop']);
  assert.equal(ui.stop.hidden, true); assert.equal(ui.pair.hidden, false);
  assert.equal(ui.status.textContent, 'Sharing stopped.');
  assert.equal(ui.pair.disabled, false);
});

test('stop cancels pairing before a delayed active-tab lookup can send it', async () => {
  const entered = Promise.withResolvers(), pending = Promise.withResolvers(), requests = [];
  const ui = await fixture(request => { requests.push(request.action); return Promise.resolve(status(false)); }, () => {
    entered.resolve(); return pending.promise;
  });
  const pairing = ui.pair.click(); await entered.promise;
  try {
    assert.equal(ui.stop.hidden, false, 'Pending pairing must expose a stop control');
    assert.equal(ui.stop.disabled, false);
    await ui.stop.click();
  } finally { pending.resolve([{ id: 1 }]); await pairing; }
  assert.deepEqual(requests, ['status', 'stop']);
  assert.equal(ui.pair.hidden, false); assert.equal(ui.stop.hidden, true);
  assert.equal(ui.status.textContent, 'Sharing stopped.');
});
