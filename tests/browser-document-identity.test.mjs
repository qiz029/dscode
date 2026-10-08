import test from 'node:test';
import assert from 'node:assert/strict';
import { installDocumentIdentity } from '../plugins/browser/document-identity.mjs';

function fixture() {
  const calls = [];
  let frames = [], onRead;
  const session = label => ({ label, detach: assert.fail, async send(method, params, options) {
    calls.push({ label, method, params, options });
    const owned = frames.filter(frame => frame._client() === this);
    const tree = frame => ({ frame: { id: frame._id, parentId: frame.parent || undefined, loaderId: frame.protocolLoader ?? frame._loaderId,
      url: frame.address.split('#')[0], urlFragment: frame.address.includes('#') ? '#' + frame.address.split('#').slice(1).join('#') : undefined },
    childFrames: owned.filter(child => child.parent === frame._id).map(tree) });
    const root = owned.find(frame => !owned.some(parent => parent._id === frame.parent));
    const result = { frameTree: tree(root) };
    await onRead?.(label, result);
    return result;
  } });
  const mainSession = session('main'), remoteSession = session('remote');
  const make = (id, parent, address, client) => ({ _id: id, parent, address, _loaderId: `loader-${id}`, client,
    url() { return this.address; }, parentFrame() { return frames.find(frame => frame._id === this.parent) ?? null; }, _client() { return this.client; } });
  const main = make('main', '', 'https://example.com/#anchor', mainSession);
  const same = make('same', 'main', 'https://example.com/form', mainSession);
  const remote = make('remote', 'main', 'https://cross.example/editor', remoteSession);
  const nested = make('nested', 'remote', 'https://cross.example/nested', remoteSession);
  frames = [main, same, remote, nested];
  const page = { frames: () => frames, createCDPSession: assert.fail };
  class Response { async handle() { return { content: [{ type: 'text', text: 'native result' }], structuredContent: { pages: [{ id: 1, url: main.address, documentId: 'stale' }] } }; } }
  installDocumentIdentity(Response);
  const context = { getPageById: id => { assert.equal(id, 1); return { pptrPage: page }; } };
  const result = () => new Response().handle(context);
  return { main, same, remote, nested, mainSession, remoteSession, page, calls, result,
    identity: async () => (await result()).structuredContent.pages[0].documentId,
    mutateRead: fn => { onRead = fn; },
    remove: frame => { frames = frames.filter(item => item !== frame); },
    add: () => { const frame = make('added', 'main', 'about:blank', mainSession); frames.push(frame); return frame; },
    reverse: () => frames.reverse(),
  };
}

test('all frame identities are stable, bounded and read through existing sessions without JavaScript or detachment', async () => {
  const f = fixture(), first = await f.result();
  f.reverse();
  assert.equal(first.structuredContent.pages[0].documentId, await f.identity());
  assert.match(first.structuredContent.pages[0].documentId, /^frames-v1:[0-9a-f]{64}$/);
  assert.deepEqual(first.content, [{ type: 'text', text: 'native result' }]);
  assert.equal(f.calls.length, 4, 'One metadata read per target per observation');
  for (const call of f.calls) {
    assert.equal(call.method, 'Page.getFrameTree'); assert.deepEqual(call.params, {}); assert.equal(call.options.timeout, 5000);
  }
});

test('attaching to loaded frames uses CDP loader identities before Puppeteer receives lifecycle events', async () => {
  const f = fixture(), before = await f.identity();
  for (const frame of f.page.frames()) { frame.protocolLoader = frame._loaderId; frame._loaderId = ''; }
  assert.equal(await f.identity(), before);
});

for (const which of ['main', 'same', 'remote', 'nested']) test(`${which} frame reload changes the preview identity`, async () => {
  const f = fixture(), before = await f.identity();
  assert(before);
  f[which]._loaderId += '-reloaded';
  const after = await f.identity(); assert(after); assert.notEqual(after, before);
});

for (const change of ['insert', 'remove', 'fragment']) test(`iframe ${change} changes the preview identity without reloading the main document`, async () => {
  const f = fixture(), before = await f.identity(), loader = f.main._loaderId;
  if (change === 'insert') f.add();
  if (change === 'remove') f.remove(f.nested);
  if (change === 'fragment') f.nested.address += '#new-view';
  const after = await f.identity(); assert(after); assert.notEqual(after, before); assert.equal(f.main._loaderId, loader);
});

for (const failure of ['protocol', 'missing-frame', 'missing-loader', 'changed-url', 'wrong-parent', 'extra-frame']) test(`unverifiable frame tree (${failure}) preserves ordinary output but supplies no preview identity`, async () => {
  const f = fixture();
  f.mutateRead((label, result) => {
    if (label !== 'remote') return;
    if (failure === 'protocol') throw Error('Unavailable target');
    if (failure === 'missing-frame') result.frameTree.childFrames = [];
    if (failure === 'missing-loader') result.frameTree.frame.loaderId = '';
    if (failure === 'changed-url') result.frameTree.frame.url = 'https://different.example/';
    if (failure === 'wrong-parent') result.frameTree.frame.parentId = 'unknown';
    if (failure === 'extra-frame') result.frameTree.childFrames.push({ frame: { id: 'unobserved', loaderId: 'new', url: 'about:blank' } });
  });
  const result = await f.result();
  assert.equal(result.structuredContent.pages[0].documentId, null);
  assert.deepEqual(result.content, [{ type: 'text', text: 'native result' }]);
});

for (const change of ['reload', 'close', 'insert', 'session-swap']) test(`${change} during a frame metadata read cannot publish a mixed preview identity`, async () => {
  const f = fixture();
  f.mutateRead(label => {
    if (label !== 'remote') return;
    if (change === 'reload') f.nested._loaderId += '-new';
    if (change === 'close') f.remove(f.nested);
    if (change === 'insert') f.add();
    if (change === 'session-swap') f.nested.client = f.mainSession;
  });
  assert.equal(await f.identity(), null);
});
