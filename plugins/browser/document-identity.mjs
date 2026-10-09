import { createHash } from 'node:crypto';

// Page.getFrameTree only covers frames served by its CDP target. Cross-process
// iframes have separate sessions already owned by the pinned MCP/Puppeteer graph.
// Borrow those sessions for read-only metadata; never attach to unrelated targets
// or detach the browser's live sessions.
async function documentIdentity(page, url) {
  const describe = frame => ({ frame, id: frame._id, loader: frame._loaderId, url: frame.url(),
    parent: frame.parentFrame()?._id ?? '', session: frame._client() });
  const before = page.frames().map(describe);
  const expected = new Map(before.map(frame => [frame.id, frame]));
  const main = before.filter(frame => !frame.parent);
  if (expected.size !== before.length || main.length !== 1 || main[0].url !== url) return null;
  const sessions = [...new Set(before.map(frame => frame.session))];
  const trees = await Promise.all(sessions.map(async session => ({ session,
    tree: (await session.send('Page.getFrameTree', {}, { timeout: 5000 })).frameTree })));
  const documents = new Map();
  for (const { session, tree } of trees) {
    const pending = [tree];
    for (const node of pending) {
      const frame = node.frame, observed = expected.get(frame.id);
      const frameUrl = frame.url + (frame.urlFragment ?? '');
      // A connection to an already loaded document can have no cached lifecycle
      // loader yet. CDP supplies the identity; populated caches add a race check.
      if (!observed || documents.has(frame.id) || observed.session !== session || !frame.loaderId ||
          (observed.loader && observed.loader !== frame.loaderId) || observed.url !== frameUrl || observed.parent !== (frame.parentId ?? '')) return null;
      documents.set(frame.id, [frame.id, frame.parentId ?? '', frame.loaderId, frameUrl]);
      pending.push(...(node.childFrames ?? []));
    }
  }
  if (documents.size !== before.length) return null;
  const after = page.frames().map(describe);
  if (after.length !== before.length || after.some(frame => {
    const old = expected.get(frame.id);
    return !old || ['frame', 'loader', 'url', 'parent', 'session'].some(key => frame[key] !== old[key]);
  })) return null;
  // Bound page-list metadata without exposing every embedded frame's URL.
  const ordered = [...documents.values()].sort((a, b) => a[0].localeCompare(b[0]));
  return 'frames-v1:' + createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** Add browser-issued document identities without evaluating page JavaScript. */
export function installDocumentIdentity(McpResponse) {
  const handle = McpResponse.prototype.handle;
  if (typeof handle !== 'function') throw Error('Unsupported Chrome MCP response adapter.');
  McpResponse.prototype.handle = async function (context, ...args) {
    const result = await handle.call(this, context, ...args);
    await Promise.all((result.structuredContent?.pages ?? []).map(async entry => {
      // An unavailable identity must never compare equal to a captured one.
      entry.documentId = null;
      try {
        entry.documentId = await documentIdentity(context.getPageById(entry.id).pptrPage, entry.url);
      } catch { /* Tab closure or unavailable metadata leaves preview unavailable. */ }
    }));
    return result;
  };
}
