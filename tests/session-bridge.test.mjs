import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { SessionBridge } from '../plugins/session-bridge/server.mjs';
import { request, exchange, discover, resolveSession, parseClientArgs } from '../plugins/session-bridge/client.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-bridge-'));
  const listeners = new Map(), events = [];
  const session = { id: 'session-one', header: { id: 'session-one', agentPreset: 'dscode' }, get seq() { return events.length; }, snapshotEvents: (from = 0, to = events.length) => Object.freeze(events.slice(from, to)) };
  const append = (type, data) => { const event = Object.freeze({ seq: events.length, time: Date.now(), type, data }); events.push(event); for (const f of listeners.get('session/event') ?? []) f(session, event); };
  const agent = { id: session.id, session, status: 'running', inbox: { nextTurn: [], nextStep: [] }, followup(m) { this.inbox.nextTurn.push(m); append('agent/inbox/spliced', { inserted: [m] }); }, steer(m) { this.inbox.nextStep.push(m); append('agent/inbox/spliced', { inserted: [m] }); } };
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined, list: () => [agent] }, sessions: { async flush() {} },
    sessionTitle: { get: () => events.findLast(e => e.type === 'session/title')?.data, rename: (_session, title) => append('session/title', { title: normalizeSessionTitle(title, 80), source: { kind: 'user' } }) },
    on(name, f) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(f); return () => set.delete(f); } };
  const bridge = new SessionBridge(ctx, home);
  await bridge.start();
  t.after(async () => { await bridge.close(); rmSync(socketDirectory(home), { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  return { bridge, agent, session, append, home };
}

test('concurrent sources share one agent, retry deduplicates, read remains available while busy', async t => {
  const { bridge, agent, home } = await fixture(t);
  assert.equal((await discover(home))[0].id, agent.id);
  const base = { method: 'send', sessionId: agent.id, text: 'hello', source: 'script' };
  const replies = await Promise.all([request(bridge.path, { ...base, requestId: 'one' }), request(bridge.path, { ...base, requestId: 'one' }), request(bridge.path, { ...base, source: 'editor', requestId: 'two', mode: 'steer' })]);
  assert.equal(replies.filter(r => r.duplicate).length, 1);
  assert.equal(agent.inbox.nextTurn.length, 1); assert.equal(agent.inbox.nextStep.length, 1);
  assert.equal(agent.inbox.nextTurn[0].source.kind, 'plugin');
  assert.match(agent.inbox.nextTurn[0].content[0].text, /External source: script/);
  await assert.rejects(request(bridge.path, { ...base, requestId: 'one', text: 'different' }), /different message/);
  // Rebuild receipt cache as a new bridge would after a process restart.
  bridge.receipts = new WeakMap();
  assert.equal((await request(bridge.path, { ...base, requestId: 'one' })).duplicate, true);
  const page = await request(bridge.path, { method: 'read', sessionId: agent.id, after: -1, limit: 1 });
  assert.equal(page.status, 'running'); assert.equal(page.cursor, 0); assert.equal(page.head, 1);
  const next = await request(bridge.path, { method: 'read', sessionId: agent.id, after: page.cursor });
  assert.equal(next.events[0].seq, 1);
  await assert.rejects(request(bridge.path, { method: 'send', sessionId: 'cold', text: 'x' }), /not active/);
});

test('watch snapshot-to-follow boundary and reconnect deliver every seq once', async t => {
  const { bridge, agent, append } = await fixture(t);
  append('fixture', { n: 0 });
  const controller = new AbortController();
  const stream = exchange(bridge.path, { method: 'watch', sessionId: agent.id, after: -1 }, { signal: controller.signal });
  assert.equal((await stream.next()).value.type, 'ready');
  append('fixture', { n: 1 });
  const seqs = [];
  while (seqs.length < 2) { const { value } = await stream.next(); if (value.type === 'event') seqs.push(value.event.seq); }
  assert.deepEqual(seqs, [0, 1]);
  await stream.return();
  append('fixture', { n: 2 });
  const resumed = exchange(bridge.path, { method: 'watch', sessionId: agent.id, after: 1 });
  assert.equal((await resumed.next()).value.type, 'ready');
  assert.equal((await resumed.next()).value.event.seq, 2);
  await resumed.return();
});

test('CLI routes are explicit and ambiguous session prefixes fail closed', () => {
  assert.equal(parseClientArgs(['send', 'abc', '--title', '修复登录', 'hi']).title, '修复登录');
  assert.throws(() => parseClientArgs(['read', 'abc', '--title', 'x']), /Invalid/);
  assert.equal(parseClientArgs(['send', 'abc', '--source', 'editor', '--steer', 'hi']).mode, 'steer');
  assert.equal(parseClientArgs(['read', 'abc', '--after', '42']).after, 42);
  assert.throws(() => parseClientArgs(['send', 'abc']), /text/);
  assert.throws(() => resolveSession([{ id: 'abc1' }, { id: 'abc2' }], 'abc'), /Ambiguous/);
});

test('explicit external title is visible, validated, and not replayed over newer titles', async t => {
  const { bridge, agent, home } = await fixture(t);
  const payload = { method: 'send', sessionId: agent.id, requestId: 'with-title', text: '检查登录失败', title: '登录修复' };
  assert.equal((await request(bridge.path, payload)).title, '登录修复');
  assert.equal((await discover(home))[0].title, '登录修复');
  assert.equal((await request(bridge.path, { method: 'read', sessionId: agent.id })).title, '登录修复');
  await request(bridge.path, { ...payload, requestId: 'new-title', title: '更新的标题' });
  assert.equal((await request(bridge.path, payload)).title, '更新的标题');
  assert.equal(agent.inbox.nextTurn.length, 2);
  await assert.rejects(request(bridge.path, { ...payload, title: '冲突标题' }), /different message/);
  for (const title of ['', '  ', '\u001b[31m', 42]) await assert.rejects(request(bridge.path, { ...payload, requestId: 'invalid', title }), /Title must/);
  assert.equal(agent.inbox.nextTurn.length, 2);
});

