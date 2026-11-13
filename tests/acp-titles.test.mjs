import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { patchAcpTitles, readAcpSessionTitle } from '../scripts/patch-acp-titles.mjs';

let fixture, upstream, AcpSession;
test.before(async () => {
  fixture = createTestRuntime({ runtime: true, patched: false });
  const path = join(fixture.root, 'node_modules/@deepseek-ai/dsh-acp/lib/index.js');
  upstream = readFileSync(path, 'utf8');
  // Export the pinned implementation from this private fixture to exercise its
  // real ordering and failure boundary without starting a child Harness.
  writeFileSync(path, patchAcpTitles(upstream) + '\nexport { AcpSession };\n');
  ({ AcpSession } = await import(pathToFileURL(path)));
});
test.after(() => fixture?.close());

test('ACP title patch applies once to the pinned runtime and rejects source drift', () => {
  const patched = patchAcpTitles(upstream);
  assert.notEqual(patched, upstream);
  assert.equal(patchAcpTitles(patched), patched);
  assert.throws(() => patchAcpTitles('unrecognized upstream'), /patch drift/i);
});

test('given successive durable titles, ACP publishes standard metadata in order', async () => {
  const notifications = [], warnings = [];
  const first = Promise.withResolvers();
  const session = { id: 'acp-session' };
  const record = new AcpSession({ logger: { warn: warning => warnings.push(warning) } }, { agent: { session } }, {}, async notification => {
    notifications.push(notification);
    if (notifications.length === 1) await first.promise;
  });
  record.onSessionEvent(session, { type: 'session/title', data: { title: 'Initial fallback' } });
  record.onSessionEvent(session, { type: 'session/title', data: { title: 'Generated title' } });
  await Promise.resolve();
  assert.equal(notifications.length, 1, 'the second notification waits for the first delivery');
  first.resolve();
  await record.drainUpdates();
  assert.deepEqual(notifications, ['Initial fallback', 'Generated title'].map(title => ({
    sessionId: 'acp-session', update: { sessionUpdate: 'session_info_update', title },
  })));
  assert.deepEqual(warnings, []);

  record.titleChanged(undefined);
  record.closing = Promise.resolve();
  record.onSessionEvent(session, { type: 'session/title', data: { title: 'After close' } });
  await record.drainUpdates();
  assert.equal(notifications.length, 2, 'empty resumed sessions and closing sessions emit no title');
});

test('given failed metadata delivery, ACP logs the failure and accepts the next title', async () => {
  const notifications = [], warnings = [];
  const session = { id: 'acp-session' };
  const record = new AcpSession({ logger: { warn: warning => warnings.push(warning) } }, { agent: { session } }, {}, async notification => {
    notifications.push(notification);
    if (notifications.length === 1) throw Error('disconnected client');
  });
  record.onSessionEvent(session, { type: 'session/title', data: { title: 'First title' } });
  await record.drainUpdates();
  record.onSessionEvent(session, { type: 'session/title', data: { title: 'Next title' } });
  await record.drainUpdates();
  assert.equal(notifications.at(-1).update.title, 'Next title');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /session title update failed.*disconnected client/);
});

test('given a persisted session, the latest title is read without claiming write ownership', async () => {
  const operations = [], signal = new AbortController().signal;
  const persistence = {
    async open(...args) {
      operations.push(['open', ...args]);
      return {
        async read(...args) {
          operations.push(['read', ...args]);
          return { events: [
            { type: 'session/title', data: { title: 'Fallback' } },
            { type: 'session/title', data: { title: 'Pinned user title' } },
            { type: 'assistant/message', data: {} },
          ] };
        },
        async close() { operations.push(['close']); },
      };
    },
  };
  const logger = { warn: () => assert.fail('metadata read must succeed') };
  assert.equal(await readAcpSessionTitle(persistence, 'saved', signal, logger), 'Pinned user title');
  assert.deepEqual(operations, [['open', 'saved', 'read', { signal }], ['read', 0, undefined, { signal }], ['close']]);
  assert.equal(await readAcpSessionTitle({ open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) }, 'empty', undefined, logger), undefined);
});

test('given unavailable title metadata, listing can omit its title and releases read handles', async () => {
  for (const stage of ['open', 'read', 'close']) {
    const warnings = [], closed = [];
    const persistence = {
      async open() {
        if (stage === 'open') throw Error('unavailable');
        return {
          async read() { if (stage === 'read') throw Error('unavailable'); return { events: [] }; },
          async close() { closed.push(true); if (stage === 'close') throw Error('unavailable'); },
        };
      },
    };
    assert.equal(await readAcpSessionTitle(persistence, 'saved', undefined, { warn: warning => warnings.push(warning) }), undefined);
    assert.equal(closed.length, stage === 'open' ? 0 : 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /session title read failed.*unavailable/);
  }
});

test('given canceled title reads, ACP preserves cancellation and closes the handle', async () => {
  const controller = new AbortController(), reason = Error('list canceled');
  controller.abort(reason);
  let closed = false;
  const persistence = { open: async () => ({ read: async () => { throw reason; }, close: async () => { closed = true; } }) };
  await assert.rejects(readAcpSessionTitle(persistence, 'saved', controller.signal, { warn: () => assert.fail('cancellation must propagate') }), error => error === reason);
  assert(closed);
});
