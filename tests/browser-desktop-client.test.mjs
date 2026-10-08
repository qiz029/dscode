import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const deferred = () => Promise.withResolvers();
const pages = (id = 1, url = 'https://example.com/') => ({ pages: [{ id, url, documentId: 'document-1', selected: true }] });
const frame = (token, pageId = 1, url = 'https://example.com/') => ({ token, pageId, url, documentId: 'document-1', capturedAt: Date.now(), width: 100, height: 100, image: { data: token, mimeType: 'image/png' } });
async function fixture(t, dispatch, timers = { setInterval, clearInterval }) {
  let module, Component, specification, definition;
  // An extracted package client exercises the same interactions after all
  // Desktop components have been composed into one native registration.
  const source = process.env.DSCODE_TEST_BROWSER_CLIENT_FILE ?? new URL('../plugins/browser/desktop-client.mjs', import.meta.url);
  runInNewContext(readFileSync(source, 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { assert.equal(module, undefined); module = value; } } }, URL, setTimeout, clearTimeout, ...timers,
  });
  module.factory(name => { assert.equal(name, 'react'); return React; }).apply({
    effect: fn => fn(), sidebarRightTabs: { register: value => { if (value.kind === 'dscode-browser') definition = value; return () => {}; } },
    slots: { inject: (_, fn) => fn(), register: (options, component) => {
      if (options.key === '@toddzheng024/dscode-browser-desktop') { assert.equal(Component, undefined); specification = options; Component = component; }
      return () => {};
    } },
    connection: { rpc: { call: async (path, method, request) => {
      assert.equal(path, '/api'); assert.equal(method, 'dscode-browser');
      return { ok: true, value: await dispatch(request) };
    } } },
  });
  assert(Component, 'The client must register the browser preview component.');
  let visible = true, renderer;
  const tabInfo = () => ({ tab: { visible } });
  const props = new Map();
  const show = async (id, shown = true, switchedTab = false) => {
    visible = shown;
    if (!props.has(id)) props.set(id, { ...specification.inject(id), useTabInfo: tabInfo });
    await act(async () => {
      // The native dock unmounts inactive tab bodies unless they opt into retention.
      if (switchedTab && !shown && !definition.keepMounted) { renderer.unmount(); renderer = undefined; return; }
      const tree = React.createElement(Component, props.get(id));
      if (renderer) renderer.update(tree); else renderer = TestRenderer.create(tree);
    });
  };
  t.after(async () => { if (renderer) await act(async () => renderer.unmount()); });
  const control = label => renderer.root.findByProps({ 'aria-label': label });
  const button = label => renderer.root.findAllByType('button').find(b => b.children.includes(label));
  const click = async label => { await act(async () => { void button(label).props.onClick(); }); };
  const annotate = async text => {
    await act(async () => {
      renderer.root.findByType('img').props.onClick({ clientX: 20, clientY: 30, currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } });
    });
    await act(async () => { control('Browser annotation').props.onChange({ target: { value: text } }); });
  };
  return { show, control, button, click, annotate, get root() { return renderer.root; } };
}

test('a new session lists its tabs immediately and ignores a late list from the old session', async t => {
  const old = deferred(), calls = [];
  const f = await fixture(t, r => { calls.push(r); return r.sessionId === 'old' ? old.promise : pages(2, 'https://new.example/'); });
  await f.show('old'); await f.show('new');
  assert.deepEqual(calls.map(r => r.sessionId), ['old', 'new']);
  await act(async () => { old.resolve(pages(9, 'https://old.example/')); });
  assert.equal(f.control('Browser tab').props.value, '2');
  assert.equal(f.button('Refresh preview').props.disabled, false);
});

for (const outcome of ['resolve', 'reject']) test(`a late capture ${outcome} cannot change a different session's preview or error state`, async t => {
  const old = deferred();
  const f = await fixture(t, r => r.action === 'tabs' ? pages() : r.sessionId === 'old' ? old.promise : frame('new-image'));
  await f.show('old'); await f.click('Refresh preview'); await f.show('new'); await f.click('Refresh preview');
  await act(async () => { if (outcome === 'resolve') old.resolve(frame('old-image')); else old.reject(Error('old session error')); });
  assert.match(f.root.findByType('img').props.src, /new-image$/);
  assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0);
  assert.equal(f.button('Refresh preview').props.disabled, false);
});

test('an acknowledged send stays in its original session and cannot clear a new session draft', async t => {
  const sent = deferred(), annotations = [];
  const f = await fixture(t, r => {
    if (r.action === 'tabs') return pages();
    if (r.action === 'capture') return frame(r.sessionId);
    annotations.push(r); return sent.promise;
  });
  await f.show('old'); await f.click('Refresh preview'); await f.annotate('old request'); await f.click('Send annotation');
  await f.show('new'); await f.click('Refresh preview'); await f.annotate('new draft');
  await act(async () => { sent.resolve({ message: 'old sent' }); });
  assert.equal(annotations.length, 1); assert.equal(annotations[0].sessionId, 'old');
  assert.equal(f.control('Browser annotation').props.value, 'new draft');
  assert.match(f.root.findByType('img').props.src, /new$/);
  assert.equal(f.root.findAllByProps({ role: 'status' }).length, 0);
  assert.equal(f.button('Send annotation').props.disabled, false);
});

test('hiding a busy pane releases its UI state and showing it can load immediately', async t => {
  const old = deferred(); let captures = 0, lists = 0;
  const f = await fixture(t, r => r.action === 'tabs' ? (lists++, pages()) : ++captures === 1 ? old.promise : frame('fresh'));
  await f.show('session'); await f.click('Refresh preview'); await f.show('session', false); await f.show('session');
  assert.equal(lists, 2);
  await f.click('Refresh preview');
  await act(async () => { old.resolve(frame('hidden-image')); });
  assert.match(f.root.findByType('img').props.src, /fresh$/);
});

test('reopening the sidebar keeps its selected tab and draft but requires fresh pixels and a point', async t => {
  const f = await fixture(t, r => r.action === 'tabs' ? { pages: [...pages().pages, ...pages(2).pages] } : frame('image', r.pageId));
  await f.show('session');
  await act(async () => f.control('Browser tab').props.onChange({ target: { value: '2' } }));
  await f.click('Refresh preview'); await f.annotate('Keep while inspecting another sidebar');
  await f.show('session', false, true); await f.show('session');
  assert.equal(f.control('Browser tab').props.value, '2');
  assert.equal(f.control('Browser annotation').props.value, 'Keep while inspecting another sidebar');
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.equal(f.button('Send annotation').props.disabled, true);
  await f.click('Refresh preview');
  assert.equal(f.button('Send annotation').props.disabled, true);
  await f.show('another-session');
  assert.equal(f.control('Browser annotation').props.value, '');
});

for (const initial of ['not-started', 'empty']) test(`first tab selection preserves an unassigned annotation draft after ${initial}`, async t => {
  let available = false;
  const annotations = [];
  const f = await fixture(t, request => {
    if (request.action === 'start') { available = true; return {}; }
    if (request.action === 'tabs') {
      if (!available && initial === 'not-started') throw Error('Start this session’s browser first.');
      return available ? pages() : { pages: [] };
    }
    if (request.action === 'capture') return frame('first-preview');
    annotations.push(request.annotation); return { message: 'Annotation sent.' };
  });
  await f.show('session');
  await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Keep the comment written before opening a tab' } }));
  if (initial === 'not-started') await f.click('Start browser');
  else { available = true; await f.click('Refresh tabs'); }
  assert.equal(f.control('Browser tab').props.value, '1');
  assert.equal(f.control('Browser annotation').props.value, 'Keep the comment written before opening a tab');
  assert.equal(f.button('Send annotation').props.disabled, true);
  await f.click('Refresh preview');
  assert.equal(f.button('Send annotation').props.disabled, true);
  await act(async () => f.root.findByType('img').props.onKeyDown({ key: 'Enter', preventDefault() {} }));
  await f.click('Send annotation');
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].text, 'Keep the comment written before opening a tab');
  assert.equal(annotations[0].token, 'first-preview');
  assert.equal(f.control('Browser annotation').props.value, '');
});

for (const edit of [false, true]) test(`send acknowledgement after reopening ${edit ? 'preserves a newer draft' : 'clears the untouched draft'}`, async t => {
  const sent = deferred();
  const f = await fixture(t, r => r.action === 'tabs' ? pages() : r.action === 'capture' ? frame('image') : sent.promise);
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Pending annotation'); await f.click('Send annotation');
  await f.show('session', false); await f.show('session');
  assert.equal(f.control('Browser annotation').props.value, 'Pending annotation');
  if (edit) await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'New draft' } }));
  await act(async () => sent.resolve({ message: 'Sent' }));
  assert.equal(f.control('Browser annotation').props.value, edit ? 'New draft' : '');
});

test('a tab-list response from a hidden pane cannot replace the reopened draft or selection', async t => {
  const old = deferred(); let lists = 0;
  const f = await fixture(t, r => r.action === 'tabs' ? (++lists === 2 ? old.promise : pages()) : frame('image'));
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep this draft');
  await f.click('Refresh tabs'); await f.show('session', false); await f.show('session');
  await act(async () => old.resolve(pages(9)));
  assert.equal(f.control('Browser tab').props.value, '1');
  assert.equal(f.control('Browser annotation').props.value, 'Keep this draft');
});

for (const changed of [pages(2), pages(1, 'https://elsewhere.example/')]) test(`closing or navigating an annotated tab clears its sendable point (${changed.pages[0].id})`, async t => {
  let tabs = pages();
  const f = await fixture(t, r => r.action === 'tabs' ? tabs : frame('image'));
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('draft');
  tabs = changed; await f.click('Refresh tabs');
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.equal(f.button('Send annotation').props.disabled, true);
  assert.equal(f.control('Browser annotation').props.value, changed.pages[0].id === 1 ? 'draft' : '',
    'Only navigation within the same selected tab retains its existing draft');
});

test('refreshing tabs after a same-URL reload removes old pixels and keeps the draft', async t => {
  let tabs = pages();
  const f = await fixture(t, r => r.action === 'tabs' ? tabs : frame('image'));
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep this comment');
  tabs = pages(); tabs.pages[0].documentId = 'document-2';
  await f.click('Refresh tabs');
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.equal(f.button('Send annotation').props.disabled, true);
  assert.equal(f.root.findByType('textarea').props.value, 'Keep this comment');
});

for (const url of ['https://example.com/next', 'https://example.com/#section', 'https://elsewhere.example/']) {
  test(`refreshing tabs after navigation keeps the draft and requires a fresh point: ${url}`, async t => {
    let tabs = pages(), captures = 0;
    const sent = [];
    const f = await fixture(t, r => {
      if (r.action === 'tabs') return tabs;
      if (r.action === 'capture') return frame(`capture-${++captures}`, 1, tabs.pages[0].url);
      sent.push(r.annotation); return { message: 'Annotation sent.' };
    });
    await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep this navigation draft');
    tabs = pages(1, url);
    await f.click('Refresh tabs');
    assert.equal(f.root.findAllByType('img').length, 0);
    assert.equal(f.button('Send annotation').props.disabled, true);
    assert.equal(f.control('Browser annotation').props.value, 'Keep this navigation draft');
    assert.match(f.root.findByProps({ role: 'status' }).children.join(''), /page changed.*draft is kept/i);
    assert.equal(sent.length, 0);
    await f.click('Refresh preview');
    assert.equal(f.button('Send annotation').props.disabled, true, 'A new capture still needs a fresh point');
    await act(async () => f.root.findByType('img').props.onKeyDown({ key: 'Enter', preventDefault() {} }));
    await f.click('Send annotation');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].token, 'capture-2');
    assert.equal(sent[0].text, 'Keep this navigation draft');
    assert.equal(f.control('Browser annotation').props.value, '');
  });
}

for (const action of ['start', 'capture', 'tabs', 'annotate']) for (const outcome of ['resolve', 'reject']) {
  test(`sidebar stop interrupts pending ${action} and ignores its late ${outcome}`, async t => {
    const held = deferred(); let hold = false, stops = 0, captures = 0;
    const sent = [];
    const f = await fixture(t, r => {
      if (r.action === 'stop') { stops++; return { message: 'Stopped' }; }
      if (hold && r.action === action) return held.promise;
      if (r.action === 'tabs') return pages();
      if (r.action === 'capture') return frame(`capture-${++captures}`);
      if (r.action === 'annotate') { sent.push(r.annotation); return { message: 'Sent' }; }
      return {};
    });
    await f.show('session'); await f.click('Refresh preview'); await f.annotate('Preserve when stopping');
    hold = true;
    await f.click({ start: 'Start browser', capture: 'Refresh preview', tabs: 'Refresh tabs', annotate: 'Send annotation' }[action]);
    assert.equal(f.button('Stop browser')?.props.disabled, false);
    await f.click('Stop browser');
    assert.equal(stops, 1);
    assert.equal(f.control('Browser tab').props.value, '');
    assert.equal(f.button('Start browser').props.disabled, false);
    assert.equal(f.button('Send annotation').props.disabled, true);
    assert.equal(f.root.findAllByType('img').length, 0);
    assert.equal(f.control('Browser annotation').props.value, 'Preserve when stopping');
    await act(async () => {
      if (outcome === 'reject') held.reject(Error('Stopped request'));
      else held.resolve(action === 'tabs' ? pages(9) : action === 'capture' ? frame('obsolete') : { message: 'Old operation finished' });
    });
    assert.equal(f.control('Browser tab').props.value, '');
    assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0);
    assert.match(f.root.findByProps({ role: 'status' }).children.join(''), /stopped.*draft is kept/i);
    hold = false;
    await f.click('Start browser');
    assert.equal(f.root.findAllByProps({ role: 'status' }).length, 0, 'Restart must remove the obsolete stopped notice before another capture');
    await f.click('Refresh preview');
    assert.equal(f.button('Send annotation').props.disabled, true);
    await act(async () => f.root.findByType('img').props.onKeyDown({ key: 'Enter', preventDefault() {} }));
    await f.click('Send annotation');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Preserve when stopping');
    assert.equal(sent[0].token, 'capture-2');
  });
}

test('pending stop serializes controls and a failed stop permits retry without losing the draft', async t => {
  const stopped = deferred(); let stops = 0;
  const f = await fixture(t, r => {
    if (r.action === 'stop') { stops++; return stopped.promise; }
    return r.action === 'tabs' ? pages() : frame('image');
  });
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Retry draft');
  await f.click('Stop browser');
  assert.equal(f.button('Stop browser').props.disabled, true);
  assert.equal(f.button('Start browser').props.disabled, true);
  await f.click('Stop browser'); assert.equal(stops, 1);
  await act(async () => stopped.reject(Error('Stop transport failed')));
  assert.equal(f.button('Stop browser').props.disabled, false);
  assert.equal(f.control('Browser annotation').props.value, 'Retry draft');
  assert.match(f.root.findByProps({ role: 'alert' }).children.join(''), /Stop transport failed/);
  await f.click('Refresh tabs');
  assert.equal(f.control('Browser annotation').props.value, 'Retry draft');
});

test('a disconnected preview stops polling and removes stale pixels', async t => {
  const timers = new Map(); let captures = 0, serial = 0;
  const f = await fixture(t, r => {
    if (r.action === 'tabs') return pages();
    if (++captures === 1) return frame('before-disconnect');
    throw Error('Extension sharing was revoked.');
  }, { setInterval: callback => { timers.set(++serial, callback); return serial; }, clearInterval: id => timers.delete(id) });
  await f.show('session'); await f.click('Refresh preview');
  await act(async () => f.root.findByType('input').props.onChange({ target: { checked: true } }));
  assert.equal(timers.size, 2);
  await act(async () => { [...timers.values()].at(-1)(); });
  assert.equal(timers.size, 1, 'Only lightweight Host handoff observation remains');
  assert.equal(f.root.findByType('input').props.checked, false);
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.match(f.root.findByProps({ role: 'alert' }).children.join(''), /revoked/);
});

for (const action of ['Refresh tabs', 'Send annotation']) test(`a failed ${action} invalidates the annotation point and preserves the draft`, async t => {
  let revoked = false;
  const f = await fixture(t, r => {
    if (revoked) throw Error('Extension sharing was revoked.');
    return r.action === 'tabs' ? pages() : frame('image');
  });
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep this draft');
  revoked = true; await f.click(action);
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.equal(f.button('Send annotation').props.disabled, true);
  assert.equal(f.control('Browser annotation').props.value, 'Keep this draft');
});

test('site controls display exact-origin grants and mutate only after an explicit click', async t => {
  const calls = [];
  let permissions = { developerMode: false, sites: {}, sessionSites: [] };
  const f = await fixture(t, r => {
    calls.push(r);
    if (r.action === 'tabs') return { ...pages(1, 'https://example.com:8443/path'), permissions };
    assert.equal(r.action, 'permission');
    if (r.change === 'once') permissions = { ...permissions, sessionSites: [r.value] };
    if (r.change === 'developer-mode') permissions = { ...permissions, developerMode: r.value === 'on' };
    if (r.change === 'developer-allow') permissions = { ...permissions, sites: { [r.value]: { access: 'ask', developer: true } } };
    return { permissions };
  });
  await f.show('session');
  assert.deepEqual(calls.map(r => r.action), ['tabs']);
  assert.equal(f.control('Site access status').children.join(''), 'Permission required');
  await f.click('Allow this session');
  assert.equal(calls.at(-1).value, 'https://example.com:8443');
  assert.equal(f.control('Site access status').children.join(''), 'Allowed until browser stops');
  await f.click('Enable Developer mode');
  assert.equal(calls.at(-1).value, 'on');
  assert.match(f.control('Developer access status').children.join(''), /on globally.*not granted/);
  await f.click('Grant site Developer access');
  assert.equal(calls.at(-1).value, 'https://example.com:8443');
  assert.match(f.control('Developer access status').children.join(''), /This site: granted/);
});

test('blocking from preview clears captured pixels but preserves the typed annotation', async t => {
  let permissions = { developerMode: false, sites: { 'https://example.com': { access: 'allow', developer: false } }, sessionSites: [] };
  const f = await fixture(t, r => {
    if (r.action === 'tabs') return { ...pages(), permissions };
    if (r.action === 'capture') return frame('old');
    assert.equal(r.change, 'block');
    permissions = { ...permissions, sites: { [r.value]: { access: 'block', developer: false } } };
    return { permissions };
  });
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep this draft');
  await f.click('Block site');
  assert.equal(f.control('Site access status').children.join(''), 'Blocked');
  assert.equal(f.button('Allow this session').props.disabled, true);
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.equal(f.control('Browser annotation').props.value, 'Keep this draft');
  assert.equal(f.button('Send annotation').props.disabled, true);
});

test('late permission updates cannot change another session and blank tabs have no grant controls', async t => {
  const old = deferred();
  const f = await fixture(t, r => r.action === 'permission' ? old.promise : {
    ...pages(1, r.sessionId === 'blank' ? 'about:blank' : 'https://example.com/'),
    permissions: { developerMode: false, sites: {}, sessionSites: [] },
  });
  await f.show('old'); await f.click('Always allow'); await f.show('new');
  await act(async () => old.resolve({ permissions: { developerMode: true, sites: {}, sessionSites: ['https://example.com'] } }));
  assert.equal(f.control('Site access status').children.join(''), 'Permission required');
  await f.show('blank');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser site permissions' }).length, 0);
});

for (const action of ['capture', 'tabs', 'annotate']) for (const outcome of ['resolve', 'reject']) {
  test(`site revocation stays responsive during ${action} and ignores its late ${outcome}`, async t => {
    const held = deferred(); let hold = false, writes = 0;
    const allowed = { developerMode: false, sites: { 'https://example.com': { access: 'allow' } }, sessionSites: [] };
    const blocked = { ...allowed, sites: { 'https://example.com': { access: 'block' } } };
    const f = await fixture(t, r => {
      if (r.action === 'permission') { writes++; return { permissions: blocked }; }
      if (hold && r.action === action) return held.promise;
      return r.action === 'tabs' ? { ...pages(), permissions: allowed } : frame('initial');
    });
    await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep draft');
    hold = true;
    await f.click({ capture: 'Refresh preview', tabs: 'Refresh tabs', annotate: 'Send annotation' }[action]);
    assert.equal(f.button('Block site').props.disabled, false, 'revocation must remain clickable');
    await f.click('Block site');
    assert.equal(writes, 1, 'revocation must reach the host before the held operation returns');
    await act(async () => {
      if (outcome === 'reject') held.reject(Error('stale operation failed'));
      else held.resolve(action === 'tabs' ? { ...pages(2, 'https://stale.example/'), permissions: allowed } : action === 'capture' ? frame('late') : { message: 'late annotation acknowledgement' });
    });
    assert.equal(f.control('Site access status').children.join(''), 'Blocked');
    assert.equal(f.control('Browser tab').props.value, '1');
    assert.equal(f.root.findAllByType('img').length, 0);
    assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0);
    assert.equal(f.control('Browser annotation').props.value, 'Keep draft');
    assert.match(f.root.findByProps({ role: 'status' }).children.join(''), /Permissions updated/);
  });
}

for (const action of ['capture', 'tabs', 'annotate']) for (const outcome of ['resolve', 'reject']) {
  test(`permission recovery can refresh before a held ${action} ${outcome}s without releasing the new request lock`, async t => {
    const held = deferred(), fresh = deferred(); let hold = false, refreshing = false, refreshes = 0;
    const blocked = { developerMode: false, sites: { 'https://example.com': { access: 'block' } }, sessionSites: [] };
    const f = await fixture(t, r => {
      if (r.action === 'permission') return { permissions: blocked };
      if (refreshing && r.action === 'tabs') { refreshes++; return fresh.promise; }
      if (hold && r.action === action) return held.promise;
      return r.action === 'tabs' ? pages() : frame('initial');
    });
    await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep recovery draft');
    hold = true;
    await f.click({ capture: 'Refresh preview', tabs: 'Refresh tabs', annotate: 'Send annotation' }[action]);
    await f.click('Block site');
    assert.equal(f.button('Refresh tabs').props.disabled, false, 'Permission completion must not wait for the obsolete request');
    refreshing = true;
    await f.click('Refresh tabs');
    assert.equal(refreshes, 1);
    await act(async () => {
      if (outcome === 'reject') held.reject(Error('Old request failed'));
      else held.resolve(action === 'tabs' ? pages(2) : action === 'capture' ? frame('obsolete') : { message: 'Old send completed' });
    });
    assert.equal(f.button('Refresh tabs').props.disabled, true, 'Old cleanup must not release the new request lock');
    await f.click('Refresh tabs');
    assert.equal(refreshes, 1, 'A queued handler cannot duplicate the new request');
    await act(async () => fresh.resolve({ ...pages(), permissions: blocked }));
    assert.equal(f.button('Refresh tabs').props.disabled, false);
    assert.equal(f.control('Site access status').children.join(''), 'Blocked');
    assert.equal(f.control('Browser annotation').props.value, 'Keep recovery draft');
    assert.equal(f.root.findAllByType('img').length, 0);
    assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0);
  });
}

test('permission writes serialize and a failed write cannot revive a held screenshot', async t => {
  const capture = deferred(), permission = deferred(); const calls = [];
  const f = await fixture(t, r => {
    calls.push(r.action);
    if (r.action === 'tabs') return { ...pages(), permissions: { sites: {}, sessionSites: [] } };
    return r.action === 'capture' ? capture.promise : permission.promise;
  });
  await f.show('session'); await f.click('Refresh preview'); await f.click('Block site');
  assert.equal(f.button('Always allow').props.disabled, true);
  await f.click('Always allow'); // Even a queued handler cannot start a second write.
  await f.click('Refresh tabs');
  assert.deepEqual(calls, ['tabs', 'capture', 'permission']);
  await act(async () => permission.reject(Error('Could not save permission')));
  assert.equal(f.button('Refresh tabs').props.disabled, false, 'A failed permission write must also permit recovery before the old capture settles');
  await act(async () => capture.resolve(frame('late')));
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.match(f.root.findByProps({ role: 'alert' }).children.join(''), /Could not save permission/);
  assert.equal(f.control('Site access status').children.join(''), 'Refresh tabs to load permissions');
  assert.equal(f.button('Block site').props.disabled, false);
});

for (const action of ['annotate', 'tabs']) for (const edit of ['A new draft written while waiting', 'Original draft']) {
  test(`${action} completion preserves intervening edits, even when text returns to ${JSON.stringify(edit)}`, async t => {
    const response = deferred(); let hold = false;
    const sent = [];
    const f = await fixture(t, r => {
      if (hold && r.action === action) { sent.push(r); return response.promise; }
      return r.action === 'tabs' ? pages() : frame('captured');
    });
    await f.show('session'); await f.click('Refresh preview'); await f.annotate('Original draft');
    hold = true;
    await f.click(action === 'annotate' ? 'Send annotation' : 'Refresh tabs');
    await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Intermediate edit' } }));
    await act(async () => f.control('Browser annotation').props.onChange({ target: { value: edit } }));
    await act(async () => response.resolve(action === 'annotate' ? { message: 'Annotation sent' } : pages(1, 'https://navigated.example/')));
    assert.equal(f.control('Browser annotation').props.value, edit);
    assert.equal(f.root.findAllByType('img').length, 0);
    assert.equal(f.button('Send annotation').props.disabled, true);
    if (action === 'annotate') assert.equal(sent[0].annotation.text, 'Original draft');
  });
}

test('an acknowledged annotation clears an untouched draft and fresh capture can send a preserved edit', async t => {
  const acknowledgement = deferred(), sent = []; let captures = 0;
  const f = await fixture(t, r => {
    if (r.action === 'tabs') return pages();
    if (r.action === 'capture') return frame(`image-${++captures}`);
    sent.push(r.annotation);
    return sent.length === 1 ? acknowledgement.promise : { message: 'Sent again' };
  });
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('First annotation'); await f.click('Send annotation');
  await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Second annotation' } }));
  await act(async () => acknowledgement.resolve({ message: 'First sent' }));
  assert.equal(f.control('Browser annotation').props.value, 'Second annotation');
  await f.click('Refresh preview'); await f.annotate('Second annotation'); await f.click('Send annotation');
  assert.deepEqual(sent.map(a => [a.token, a.text]), [['image-1', 'First annotation'], ['image-2', 'Second annotation']]);
  assert.equal(f.control('Browser annotation').props.value, '');
});

function expiryClock() {
  let now = 100000, serial = 0;
  const timers = new Map();
  return { timers, get now() { return now; }, advance: ms => { now += ms; },
    runtime: { setInterval, clearInterval, Date: class extends Date { static now() { return now; } },
      setTimeout: (callback, ms) => { timers.set(++serial, { callback, ms }); return serial; }, clearTimeout: id => timers.delete(id) } };
}

test('preview expiry disables sending, removes the point and retains the draft without a permission error', async t => {
  const clock = expiryClock(), calls = [];
  const f = await fixture(t, r => {
    calls.push(r.action);
    return r.action === 'tabs' ? { ...pages(), permissions: { sites: {}, sessionSites: ['https://example.com'] } }
      : { ...frame('expiring'), capturedAt: clock.now - 50000, permissions: { sites: {}, sessionSites: ['https://example.com'] } };
  }, clock.runtime);
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep this expired draft');
  assert.equal(f.button('Send annotation').props.disabled, false);
  const timer = [...clock.timers.values()][0]; assert.equal(timer?.ms, 10000);
  clock.advance(10000); await act(async () => timer.callback());
  assert.equal(f.button('Send annotation').props.disabled, true);
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Selected annotation point' }).length, 0);
  assert.equal(f.control('Browser annotation').props.value, 'Keep this expired draft');
  assert.match(f.root.findByProps({ 'aria-label': 'Preview freshness' }).children.join(''), /expired.*Refresh preview/i);
  assert.equal(f.control('Site access status').children.join(''), 'Allowed until browser stops');
  assert.deepEqual(calls, ['tabs', 'capture']);
});

test('a delayed expiry callback cannot expire a replacement capture and hiding cancels its timer', async t => {
  const clock = expiryClock(); let token = 0;
  const f = await fixture(t, r => r.action === 'tabs' ? pages() : { ...frame(`frame-${++token}`), capturedAt: clock.now }, clock.runtime);
  await f.show('session'); await f.click('Refresh preview');
  const old = [...clock.timers.values()][0]?.callback;
  clock.advance(50000); await f.click('Refresh preview'); await f.annotate('Fresh draft');
  assert.equal(clock.timers.size, 1);
  clock.advance(10000); await act(async () => old());
  assert.equal(f.button('Send annotation').props.disabled, false);
  assert.match(f.root.findByType('img').props.src, /frame-2$/);
  await f.show('session', false); assert.equal(clock.timers.size, 0);
});

test('expired captures arriving late cannot select a point', async t => {
  const clock = expiryClock();
  const f = await fixture(t, r => r.action === 'tabs' ? pages() : { ...frame('old'), capturedAt: clock.now - 60001 }, clock.runtime);
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Retained text');
  assert.equal(f.button('Send annotation').props.disabled, true);
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Selected annotation point' }).length, 0);
  assert.equal(f.control('Browser annotation').props.value, 'Retained text');
});

test('a throttled expiry timer cannot submit an expired receipt, and refreshing preserves its draft', async t => {
  const clock = expiryClock(), sent = [];
  const f = await fixture(t, r => {
    if (r.action === 'tabs') return pages();
    if (r.action === 'capture') return { ...frame(String(clock.now)), capturedAt: clock.now };
    sent.push(r.annotation); return { message: 'Sent' };
  }, clock.runtime);
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Draft while waiting');
  clock.advance(60001); await f.click('Send annotation');
  assert.equal(sent.length, 0);
  assert.equal(f.control('Browser annotation').props.value, 'Draft while waiting');
  await f.click('Refresh preview');
  assert.equal(f.control('Browser annotation').props.value, 'Draft while waiting');
  await f.annotate('Draft while waiting'); await f.click('Send annotation');
  assert.equal(sent.length, 1); assert.equal(sent[0].token, String(clock.now));
});

async function previewKey(f, key, modifiers = {}) {
  let prevented = false;
  await act(async () => f.root.findByType('img').props.onKeyDown({ key, ...modifiers, preventDefault: () => { prevented = true; } }));
  return prevented;
}

test('keyboard selection sends exact screenshot coordinates and pauses live refresh', async t => {
  const sent = [];
  const f = await fixture(t, r => {
    if (r.action === 'tabs') return pages();
    if (r.action === 'capture') return { ...frame('keyboard'), width: 201, height: 101 };
    sent.push(r.annotation); return { message: 'Sent' };
  });
  await f.show('session'); await f.click('Refresh preview');
  const img = f.root.findByType('img');
  assert.equal(img.props.tabIndex, 0); assert.equal(img.props.role, 'button');
  await act(async () => f.root.findByType('input').props.onChange({ target: { checked: true } }));
  assert.equal(await previewKey(f, 'Enter'), true);
  assert.equal(f.root.findByType('input').props.checked, false);
  await previewKey(f, 'ArrowRight'); await previewKey(f, 'ArrowDown', { shiftKey: true });
  assert.match(f.control('Annotation coordinates').children.join(''), /101, 60/);
  await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Keyboard draft' } }));
  await f.click('Send annotation');
  assert.equal(sent.length, 1); assert.equal(Math.round(sent[0].x * 200), 101); assert.equal(Math.round(sent[0].y * 100), 60);
  assert.equal(sent[0].text, 'Keyboard draft');
});

test('keyboard points stay inside pixels and Escape clears only the point', async t => {
  const f = await fixture(t, r => r.action === 'tabs' ? pages() : { ...frame('small'), width: 3, height: 1 });
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep draft');
  await previewKey(f, 'ArrowRight', { shiftKey: true }); await previewKey(f, 'ArrowDown');
  assert.match(f.control('Annotation coordinates').children.join(''), /2, 0/);
  await previewKey(f, 'ArrowLeft', { shiftKey: true }); await previewKey(f, 'ArrowUp');
  assert.match(f.control('Annotation coordinates').children.join(''), /0, 0/);
  assert.equal(await previewKey(f, 'Tab'), false);
  assert.equal(await previewKey(f, 'ArrowRight', { metaKey: true }), false);
  assert.equal(await previewKey(f, 'Escape'), true);
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Selected annotation point' }).length, 0);
  assert.equal(f.control('Browser annotation').props.value, 'Keep draft');
  assert.equal(f.button('Send annotation').props.disabled, true);
  await previewKey(f, ' ');
  assert.match(f.control('Annotation coordinates').children.join(''), /1, 0/);
});

test('keyboard selection rechecks expiry even before its timer fires', async t => {
  const clock = expiryClock();
  const f = await fixture(t, r => r.action === 'tabs' ? pages() : { ...frame('expires'), capturedAt: clock.now }, clock.runtime);
  await f.show('session'); await f.click('Refresh preview');
  clock.advance(60001); await previewKey(f, 'Enter');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Selected annotation point' }).length, 0);
  assert.equal(f.root.findByType('img').props['aria-disabled'], true);
  assert.match(f.control('Preview freshness').children.join(''), /expired/);
});

test('keyboard selection cannot annotate an image during replacement capture', async t => {
  const held = deferred(); let count = 0;
  const f = await fixture(t, r => r.action === 'tabs' ? pages() : ++count === 1 ? frame('old') : held.promise);
  await f.show('session'); await f.click('Refresh preview'); await f.click('Refresh preview');
  assert.equal(f.root.findByType('img').props['aria-disabled'], true);
  await previewKey(f, 'Enter');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Selected annotation point' }).length, 0);
  await act(async () => held.resolve(frame('fresh')));
  await previewKey(f, 'Enter');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Selected annotation point' }).length, 1);
});


for (const url of ['https://next.example/path', 'https://example.com:9443/path']) {
  test(`preview refresh follows navigation for permission display and actions: ${url}`, async t => {
    const nextOrigin = new URL(url).origin, calls = [];
    const oldPermissions = { developerMode: true, sites: { 'https://example.com': { access: 'allow', developer: true } }, sessionSites: [] };
    let captures = 0;
    const f = await fixture(t, r => {
      calls.push(r);
      if (r.action === 'tabs') return { ...pages(), permissions: oldPermissions };
      if (r.action === 'capture') return ++captures === 1 ? { ...frame('old'), permissions: oldPermissions }
        : { ...frame('new', 1, url), permissions: { ...oldPermissions, sessionSites: [nextOrigin] } };
      assert.equal(r.action, 'permission');
      return { permissions: { ...oldPermissions, sites: { ...oldPermissions.sites, [r.value]: { access: 'block', developer: false } }, sessionSites: [] } };
    });
    await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep this draft');
    await f.click('Refresh preview');
    assert.match(f.root.findByType('img').props.src, /new$/);
    assert.equal(f.root.findAllByType('option').find(node => node.props.value === '1').children.join(''), `1 · ${url}`);
    assert.equal(f.control('Site access status').children.join(''), 'Allowed until browser stops');
    assert.match(f.control('Developer access status').children.join(''), /This site: not granted/);
    assert.equal(f.control('Browser annotation').props.value, 'Keep this draft');
    assert.equal(f.button('Send annotation').props.disabled, true);
    await f.click('Block site');
    assert.equal(calls.at(-1).value, nextOrigin);
    assert.equal(f.control('Site access status').children.join(''), 'Blocked');
    assert.equal(f.root.findAllByType('img').length, 0);
  });
}

test('handoff clears stale pixels and resumes with a fresh page list while preserving the draft', async t => {
  let paused = false, resumed = false; const actions = [];
  const f = await fixture(t, request => {
    actions.push(request.action);
    if (request.action === 'tabs') return { ...pages(resumed ? 2 : 1), handoff: paused ? { pageId: 1, reason: 'Finish signing in', invalidated: true } : null };
    if (request.action === 'resume') { paused = false; resumed = true; return { message: 'Resumed' }; }
    return frame('fresh', resumed ? 2 : 1);
  });
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep my request');
  paused = true; await f.click('Refresh tabs');
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.match(f.control('Browser handoff').findAllByType('p').map(p => p.children.join(' ')).join(' '), /Finish signing in/);
  assert.equal(f.button('Refresh preview').props.disabled, true);
  assert.equal(f.button('Send annotation').props.disabled, true);
  assert.equal(f.button('Resume browser control').props.disabled, false);
  await f.click('Resume browser control');
  assert.deepEqual(actions.slice(-2), ['resume', 'tabs']);
  assert.equal(f.control('Browser tab').props.value, '2');
  assert.equal(f.control('Browser annotation').props.value, 'Keep my request');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 0);
  assert.equal(f.button('Send annotation').props.disabled, true);
  await f.click('Refresh preview'); await f.annotate('Keep my request');
  assert.equal(f.button('Send annotation').props.disabled, false);
});

test('failed resume keeps the handoff and draft available for explicit retry', async t => {
  let resumes = 0;
  const f = await fixture(t, request => {
    if (request.action === 'tabs') return { ...pages(), handoff: { pageId: 1, reason: 'Complete a manual step' } };
    if (request.action === 'resume') { resumes++; throw Error('Cannot refresh browser pages; handoff remains paused.'); }
  });
  await f.show('session');
  await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Keep this draft' } }));
  await f.click('Resume browser control');
  assert.equal(resumes, 1);
  assert.equal(f.control('Browser annotation').props.value, 'Keep this draft');
  assert.equal(f.button('Resume browser control').props.disabled, false);
  assert.equal(f.button('Refresh preview').props.disabled, true);
  assert.match(f.root.findByProps({ role: 'alert' }).children.join(''), /handoff remains paused/);
});

for (const outcome of ['resolve', 'reject']) test(`stopping supersedes a pending resume ${outcome}`, async t => {
  const resume = deferred(); const actions = [];
  const f = await fixture(t, request => {
    actions.push(request.action);
    if (request.action === 'tabs') return { ...pages(), handoff: { pageId: 1, reason: 'Manual step' } };
    if (request.action === 'resume') return resume.promise;
    return { message: 'Stopped' };
  });
  await f.show('session'); await f.click('Resume browser control'); await f.click('Stop browser');
  await act(async () => { if (outcome === 'resolve') resume.resolve({ message: 'Resumed' }); else resume.reject(Error('Old resume failed')); });
  assert.deepEqual(actions, ['tabs', 'resume', 'stop']);
  assert.equal(f.control('Browser tab').props.value, '');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 0);
  assert.equal(f.root.findAllByProps({ role: 'alert' }).length, 0);
  assert.match(f.root.findByProps({ role: 'status' }).children.join(''), /Browser stopped/);
});

function intervalClock() {
  let serial = 0;
  const callbacks = new Map();
  return { callbacks, runtime: { setInterval: callback => { callbacks.set(++serial, callback); return serial; }, clearInterval: id => callbacks.delete(id) },
    tick: async () => { await act(async () => { for (const callback of [...callbacks.values()]) callback(); }); } };
}

for (const change of ['block', 'forget-temporary', 'developer', 'other-site']) {
  test(`visible preview synchronizes external permission change: ${change}`, async t => {
    const clock = intervalClock(), actions = [];
    let permissions = { developerMode: false, sites: { 'https://example.com': { access: 'allow', developer: false } }, sessionSites: [] };
    if (change === 'forget-temporary') permissions = { ...permissions, sites: {}, sessionSites: ['https://example.com'] };
    const f = await fixture(t, request => {
      actions.push(request.action);
      if (request.action === 'tabs') return { ...pages(), permissions };
      if (request.action === 'handoff') return { connected: true, handoff: null, permissions };
      return { ...frame('retained'), permissions };
    }, clock.runtime);
    await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep the permission-change draft');
    if (change === 'block') permissions = { ...permissions, sites: { 'https://example.com': { access: 'block', developer: false } } };
    if (change === 'forget-temporary') permissions = { ...permissions, sessionSites: [] };
    if (change === 'developer') permissions = { ...permissions, developerMode: true };
    if (change === 'other-site') permissions = { ...permissions, sites: { ...permissions.sites, 'https://elsewhere.example': { access: 'block', developer: false } } };
    await clock.tick();
    assert.equal(f.control('Browser annotation').props.value, 'Keep the permission-change draft');
    assert.deepEqual(actions, ['tabs', 'capture', 'handoff']);
    assert.equal(f.root.findAllByType('img').length, change === 'other-site' ? 1 : 0);
    assert.equal(f.button('Send annotation').props.disabled, change !== 'other-site');
    if (change === 'block') assert.equal(f.control('Site access status').children.join(''), 'Blocked');
    if (change === 'forget-temporary') assert.equal(f.control('Site access status').children.join(''), 'Permission required');
    if (change === 'developer') assert.match(f.control('Developer access status').children.join(''), /on globally/);
  });
}

test('late external permission observation cannot replace a newer explicit grant', async t => {
  const clock = intervalClock(), old = deferred();
  const allowed = { developerMode: false, sites: { 'https://example.com': { access: 'allow', developer: false } }, sessionSites: [] };
  const blocked = { ...allowed, sites: { 'https://example.com': { access: 'block', developer: false } } };
  const f = await fixture(t, r => r.action === 'handoff' ? old.promise : r.action === 'tabs' ? { ...pages(), permissions: allowed } : { permissions: allowed }, clock.runtime);
  await f.show('session'); await clock.tick(); await f.click('Always allow');
  await act(async () => old.resolve({ connected: true, handoff: null, permissions: blocked }));
  assert.equal(f.control('Site access status').children.join(''), 'Always allowed');
});

test('visible sidebar observes manual handoff without a page request and preserves the draft', async t => {
  const clock = intervalClock(), actions = []; let handoff = null;
  const f = await fixture(t, r => {
    actions.push(r.action);
    if (r.action === 'tabs') return { ...pages(), handoff };
    if (r.action === 'handoff') return { handoff };
    return frame('before-manual-step');
  }, clock.runtime);
  await f.show('session'); await f.click('Refresh preview'); await f.annotate('Keep the typed request');
  handoff = { pageId: 1, reason: 'Complete login in Chrome' };
  await clock.tick();
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 1);
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.equal(f.control('Browser annotation').props.value, 'Keep the typed request');
  assert.deepEqual(actions, ['tabs', 'capture', 'handoff']);
  handoff = null; await clock.tick();
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 0);
  assert.equal(f.button('Send annotation').props.disabled, true);
  await f.show('session', false); assert.equal(clock.callbacks.size, 0);
});

for (const interruption of ['Stop browser', 'Refresh tabs', 'hide']) test(`late handoff status cannot overwrite ${interruption}`, async t => {
  const clock = intervalClock(), held = deferred(); let reads = 0;
  const f = await fixture(t, r => {
    if (r.action === 'handoff') { reads++; return held.promise; }
    return { ...pages(), handoff: null };
  }, clock.runtime);
  await f.show('session'); await clock.tick(); await clock.tick();
  assert.equal(reads, 1, 'Status requests do not overlap');
  if (interruption === 'hide') { await f.show('session', false); await f.show('session'); }
  else await f.click(interruption);
  await act(async () => held.resolve({ handoff: { pageId: 1, reason: 'Stale pause' } }));
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 0);
});

test('failed handoff observation retries without discarding an editable draft', async t => {
  const clock = intervalClock(); let reads = 0;
  const f = await fixture(t, r => {
    if (r.action === 'tabs') return pages();
    if (++reads === 1) throw Error('Temporary Host disconnect');
    return { handoff: { pageId: 1, reason: 'Manual step' } };
  }, clock.runtime);
  await f.show('session');
  await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Keep after retry' } }));
  await clock.tick(); await clock.tick();
  assert.equal(reads, 2);
  assert.equal(f.control('Browser annotation').props.value, 'Keep after retry');
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 1);
});

for (const paused of [false, true]) test(`external browser disconnect clears the ${paused ? 'handoff' : 'preview'} and keeps its draft`, async t => {
  const clock = intervalClock(); let connected = true, id = 1;
  const f = await fixture(t, r => {
    if (r.action === 'handoff') return { connected, handoff: connected && paused ? { pageId: id, reason: 'Manual step' } : null };
    if (r.action === 'start') { connected = true; id = 2; return {}; }
    if (r.action === 'tabs') return { ...pages(id), connected, handoff: paused && id === 1 ? { pageId: id, reason: 'Manual step' } : null };
    return frame('current-image', id);
  }, clock.runtime);
  await f.show('session');
  if (!paused) { await f.click('Refresh preview'); await f.annotate('Keep on disconnect'); }
  else await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Keep on disconnect' } }));
  connected = false; await clock.tick();
  assert.equal(f.control('Browser tab').props.value, '');
  assert.equal(f.root.findAllByType('img').length, 0);
  assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 0);
  assert.equal(f.control('Browser annotation').props.value, 'Keep on disconnect');
  assert.equal(f.button('Refresh preview').props.disabled, true);
  assert.equal(f.button('Send annotation').props.disabled, true);
  assert.match(f.root.findByProps({ role: 'status' }).children.join(''), /disconnected/);
  await f.click('Start browser');
  assert.equal(f.control('Browser tab').props.value, '2');
  assert.equal(f.control('Browser annotation').props.value, 'Keep on disconnect');
  assert.equal(f.button('Send annotation').props.disabled, true);
});

test('a late disconnected observation cannot erase a newer capture', async t => {
  const clock = intervalClock(), old = deferred();
  const f = await fixture(t, r => r.action === 'handoff' ? old.promise : r.action === 'tabs' ? pages() : frame('new-capture'), clock.runtime);
  await f.show('session'); await clock.tick(); await f.click('Refresh preview');
  await act(async () => old.resolve({ connected: false, handoff: null }));
  assert.match(f.root.findByType('img').props.src, /new-capture$/);
  assert.equal(f.control('Browser tab').props.value, '1');
});

for (const retainedPages of [false, true]) for (const paused of [false, true]) {
  test(`tab refresh that observes disconnection keeps the draft (cached pages: ${retainedPages}, handoff: ${paused})`, async t => {
    const clock = intervalClock(); let connected = true;
    const handoff = paused ? { pageId: 1, reason: 'Manual step' } : null;
    const f = await fixture(t, r => {
      if (r.action === 'tabs') return { connected, pages: connected || retainedPages ? pages().pages : [], handoff };
      if (r.action === 'handoff') return { connected, handoff: connected ? handoff : null };
      if (r.action === 'start') { connected = true; return {}; }
      return frame('current-image');
    }, clock.runtime);
    await f.show('session');
    if (!paused) { await f.click('Refresh preview'); await f.annotate('Keep when refresh sees disconnect first'); }
    else await act(async () => f.control('Browser annotation').props.onChange({ target: { value: 'Keep when refresh sees disconnect first' } }));
    connected = false;
    // A completed list operation may retain historical pages/handoff when the
    // connection closes before its status is projected into the RPC response.
    await f.click('Refresh tabs');
    assert.equal(f.control('Browser annotation').props.value, 'Keep when refresh sees disconnect first');
    assert.equal(f.control('Browser tab').props.value, '');
    assert.equal(f.root.findAllByType('img').length, 0);
    assert.equal(f.root.findAllByProps({ 'aria-label': 'Browser handoff' }).length, 0);
    assert.equal(f.button('Refresh preview').props.disabled, true);
    assert.equal(f.button('Send annotation').props.disabled, true);
    assert.match(f.root.findByProps({ role: 'status' }).children.join(''), /disconnected/);
    await clock.tick();
    assert.equal(f.control('Browser annotation').props.value, 'Keep when refresh sees disconnect first');
    assert.equal(f.control('Browser tab').props.value, '');
  });
}
