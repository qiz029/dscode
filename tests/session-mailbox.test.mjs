import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Mailbox, limits } from '../plugins/session-bridge/mailbox.mjs';
import { parseClientArgs } from '../plugins/session-bridge/client.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-mailbox-test-')); let now = 1000;
  const store = new Mailbox(home, () => now, { retainedMessages: 12, retainedEvents: 16, retainedChains: 12, retainedRefusals: 16 }), a = store.register('a', '/a'), b = store.register('b', '/b');
  store.newTask(a);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const send = (id, key, auth = a, extra = {}) => store.admit(id, { text: 'task', requestId: key, ...extra }, auth);
  return { home, store, a, b, send, advance: () => { now += limits.ttlMs + 1; } };
}

test('message admission is idempotent and all mutable identity fields conflict on reuse', t => {
  const { store, a, send } = fixture(t);
  const one = send('b', 'one'); assert.equal(one.duplicate, false);
  assert.equal(send('b', 'one').row.id, one.row.id); assert(send('b', 'one').duplicate);
  for (const extra of [{ text: 'changed' }, { kind: 'notify' }, { mode: 'defer' }]) assert.throws(() => send('b', 'one', a, extra), { code: 'idempotency_conflict' });
  assert.equal(store.one('SELECT used FROM chains').used, 1);
  assert.throws(() => send('b', 'fake', { ...a, secret: 'forged' }), { code: 'invalid_sender' });
});

test('delegation cycles and depth reject while return notifications and final replies are allowed', t => {
  const { store, a, b, send } = fixture(t);
  const ab = send('b', 'ab').row;
  store.include(b, ab.envelope.contexts);
  assert.throws(() => send('a', 'cycle', b), { code: 'cycle_detected' });
  assert.throws(() => send('b', 'self', b), { code: 'cycle_detected' });
  assert.equal(send('a', 'progress', b, { kind: 'notify', inReplyTo: ab.id }).row.kind, 'notify');
  const c = store.register('c', '/c'), d = store.register('d', '/d');
  const bc = send('c', 'bc', b).row; store.include(c, bc.envelope.contexts);
  const cd = send('d', 'cd', c).row; store.include(d, cd.envelope.contexts);
  assert.throws(() => send('e', 'de', d), { code: 'depth_exceeded' });
  send('a', 'answer', b, { kind: 'reply', inReplyTo: ab.id });
  assert.equal(store.get(ab.id).request_state, 'replied');
  assert.throws(() => send('a', 'second-answer', b, { kind: 'reply', inReplyTo: ab.id }), { code: 'already_replied' });
  assert.throws(() => send('a', 'wrong-sender', c, { kind: 'reply', inReplyTo: ab.id }), { code: 'invalid_reply' });
});

test('all inherited chains are charged, retries do not charge, final reply has a reserved slot', t => {
  const { store, a, b, send } = fixture(t);
  const first = send('b', 'first').row; store.include(b, first.envelope.contexts);
  for (let n = 1; n < limits.sends; n++) send('b', `request-${n}`);
  assert.throws(() => send('b', 'extra'), { code: 'budget_exhausted' });
  assert(send('b', 'first').duplicate);
  assert.equal(send('a', 'reply', b, { kind: 'reply', inReplyTo: first.id }).row.delivery, 'accepted');
  const fresh = store.register('fresh', '/fresh'); store.newTask(fresh);
  store.include(fresh, first.envelope.contexts);
  assert.throws(() => send('z', 'cannot-pick-fresh', fresh), { code: 'budget_exhausted' });
  // Failed multi-chain transaction did not debit the unrelated fresh budget.
  const chain = store.context(fresh.sessionId).find(c => c.path[0] === 'fresh');
  assert.equal(store.one('SELECT used FROM chains WHERE id=?', chain.chainId).used, 0);
});

test('defer cutoff excludes later notes; unconfirmed claims survive reopened storage', t => {
  const { home, store, b, send } = fixture(t);
  const early = send('b', 'early', undefined, { mode: 'defer' }).row;
  const cutoff = store.freeze(b);
  const late = send('b', 'late', undefined, { mode: 'defer' }).row;
  assert.deepEqual(store.deferred(b, cutoff, 1).map(r => r.id), [early.id]);
  const reopened = new Mailbox(home); t.after(() => reopened.close());
  assert.equal(reopened.get(early.id).delivery, 'accepted');
  assert(reopened.get(early.id).batch);
  store.transition(b, early.id, 'consumed');
  assert.deepEqual(store.deferred(b, store.freeze(b), 2).map(r => r.id), [late.id]);
});

test('expiry and cancellation prevent delivery; first late final reply is kept without activation', t => {
  const { store, a, b, send, advance } = fixture(t);
  const first = send('b', 'first').row; store.include(b, first.envelope.contexts);
  store.cancel(a, first.id);
  const late = send('a', 'late-reply', b, { kind: 'reply', inReplyTo: first.id }).row;
  assert.equal(late.delivery, 'late');
  const deferred = send('b', 'deferred', a, { mode: 'defer' }).row;
  advance();
  assert.equal(store.deferred(b, store.freeze(b), 1).length, 0);
  assert.equal(store.get(deferred.id).delivery, 'expired');
  assert.throws(() => send('b', 'expired'), { code: 'chain_expired' });
});

test('owner generations fence stale updates; contexts and budgets survive owner replacement', t => {
  const { store, a, send } = fixture(t);
  const row = send('b', 'first').row;
  const current = store.register('a', '/new');
  assert.throws(() => send('b', 'old-owner'), { code: 'invalid_sender' });
  assert.equal(send('b', 'first', current).row.id, row.id);
  assert.equal(store.one('SELECT used FROM chains').used, 1);
  store.unregister(a); assert(store.authenticate(current));
});

test('an independent incoming request adopts existing task chains without minting a budget', t => {
  const { store, a, b, send } = fixture(t);
  store.newTask(b);
  const first = send('b', 'request').row;
  store.include(b, first.envelope.contexts, false, undefined, true);
  const reply = send('a', 'reply', b, { kind: 'reply', inReplyTo: first.id }).row;
  store.include(a, reply.envelope.contexts);
  assert.equal(send('b', 'followup').row.kind, 'request');
  assert.equal(store.one('SELECT COUNT(*) AS n FROM chains').n, 2); // Only the two explicit user roots.
  assert.equal(store.one('SELECT used FROM chains WHERE id=?', first.envelope.chainIds[0]).used, 2);
});

test('mailbox capacity is enforced for independent external roots too', t => {
  const { store } = fixture(t);
  for (let n = 0; n < 16; n++) store.admit('b', { requestId: `${n}`, text: 'x'.repeat(64000), mode: 'defer' });
  assert.throws(() => store.admit('b', { requestId: 'full', text: 'x'.repeat(64000), mode: 'defer' }), { code: 'mailbox_full' });
  assert.equal(store.counts('b').defer, 16);
});

test('CLI expresses defer and reply without accepting conflicting delivery strategies', () => {
  assert.equal(parseClientArgs(['send', 'b', '--defer', '--kind', 'notify', 'note']).mode, 'defer');
  assert.throws(() => parseClientArgs(['send', 'b', '--steer', '--defer', 'note']), /only one/);
  assert.equal(parseClientArgs(['reply', 'b', '--reply-to', 'id', 'answer']).inReplyTo, 'id');
  assert.equal(parseClientArgs(['mailbox', 'b']).after, 0);
  assert.equal(parseClientArgs(['cancel', 'b', 'id']).messageId, 'id');
});

test('independent processes cannot overspend one shared chain', async t => {
  const { home, store, a } = fixture(t);
  const moduleURL = new URL('../plugins/session-bridge/mailbox.mjs', import.meta.url).href;
  const code = `import { Mailbox } from ${JSON.stringify(moduleURL)};
    const [home, credentials, prefix] = process.argv.slice(1), store = new Mailbox(home, () => 1000), auth = JSON.parse(credentials);
    let accepted = 0;
    for (let n = 0; n < 4; n++) { try { store.admit('b', { requestId: prefix + n, text: 'concurrent', mode: 'defer' }, auth); accepted++; }
      catch (e) { if (e.code !== 'budget_exhausted') throw e; } }
    store.close(); console.log(accepted);`;
  const counts = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, home, JSON.stringify(a), String(index)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { error += b; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(Number(output.trim())) : reject(Error(error)));
  })));
  assert.equal(counts.reduce((a, b) => a + b), limits.sends);
  assert.equal(store.one('SELECT used FROM chains').used, limits.sends);
});

test('defer batch is bounded including metadata; claimed cancellation reports that input cannot be recalled', t => {
  const { store, a, b, send } = fixture(t);
  const note = send('b', 'claimed', a, { mode: 'defer' }).row;
  store.deferred(b, store.freeze(b), 1);
  const cancelled = store.cancel(a, note.id);
  assert.equal(cancelled.alreadyClaimed, true); assert.equal(cancelled.requestState, 'cancelled');
  assert.equal(cancelled.delivery, 'cancelled'); // Stop future recovery even if this turn already claimed it.
  assert.throws(() => send('b', 'oversized-encoding', a, { text: '\u0000'.repeat(20000), mode: 'defer' }), { code: 'message_too_large' });
});

test('retention removes old settled rows and their events, and sweeps an expired pending row', t => {
  const { store, a, b, send } = fixture(t);
  const old = send('b', 'old', a).row;
  store.transition(b, old.id, 'consumed');
  store.prune();
  assert.equal(store.tableCounts().messages, 1, 'a fresh prune keeps a just-settled message');
  const cutoff = 1000 + limits.retentionMs + limits.ttlMs;
  store.now = () => cutoff;
  store.newTask(a); // the first task chain expired with the jump, as it would in a real week-long gap
  const pending = send('b', 'still-pending', a).row;
  store.prunedAt = 0;
  store.prune();
  assert.equal(store.get(old.id), null, 'a settled message past the window is dropped');
  assert.equal(store.get(pending.id).id, pending.id, 'a swept pending row in a live chain is kept');
  assert(store.one('SELECT COUNT(*) n FROM events WHERE recipient=?', 'b').n > 0, 'the newer events survive');
});


test('pruning keeps deliverable rows even with a populated table', t => {
  const { store, b } = fixture(t);
  store.now = () => 2 * 3600000;
  // Anonymous senders get expires=Infinity, so only the cap can bound their rows; stop at the
  // pending-mailbox limit, which is the other guard under test.
  let accepted = 0;
  for (let index = 0; index < store.retention.retainedMessages; index++) {
    try { store.admit('b', { text: 'x', requestId: 'anon-' + index }, undefined); accepted++; }
    catch (error) { if (error.code !== 'mailbox_full') throw error; break; }
  }
  assert(accepted > 0 && accepted <= store.retention.retainedMessages);
  store.prunedAt = 0;
  store.prune();
  assert.equal(store.tableCounts().messages, accepted, 'nothing deliverable is evicted');
});

// A far-future clock: the fixture starts an hour from epoch 0, and prune itself is throttled hourly.
test('the cap evicts only settled mail whose reply window has closed', t => {
  const { store, b } = fixture(t);
  const base = 2 * 3600000;
  store.now = () => base;
  store.newTask(b); // closed rows settle behind this chain, so they expire one hour from now
  const closed = [];
  for (let index = 0; index < store.retention.retainedMessages + 1; index++) {
    const row = store.admit('b', { text: 'x', requestId: 'cap-' + index }, undefined).row;
    closed.push(row.id);
    store.transition(b, row.id, 'consumed');
  }
  // One more task: the pending message and the live chain expire three hours from the fixture start.
  store.newTask(b);
  const pending = store.admit('b', { text: 'x', requestId: 'cap-pending' }, undefined).row;
  store.now = () => base + 2 * 3600000;
  store.prunedAt = 0;
  store.prune();
  const settled = store.one("SELECT COUNT(*) n FROM messages WHERE delivery NOT IN ('accepted','admitted')").n;
  assert(settled <= store.retention.retainedMessages, `the cap bounds the closed rows (${settled})`);
  assert.equal(store.get(closed[0]), null, 'the oldest closed row is evicted');
  assert.equal(store.get(closed.at(-1)).id, closed.at(-1), 'recent closed rows survive');
  assert.equal(store.get(pending.id).id, pending.id, 'deliverable mail is never evicted');
});

test('a forced prune ignores the hourly throttle, a plain one does not', t => {
  const { store } = fixture(t);
  store.now = () => 2 * 3600000;
  store.prune();
  const stamped = store.prunedAt;
  store.prune();
  assert.equal(store.prunedAt, stamped, 'the second plain prune is a no-op inside the window');
  store.now = () => 2 * 3600000 + 1000;
  store.prune({ force: true });
  assert.notEqual(store.prunedAt, stamped, 'force runs it anyway');
});

test('the event cap is per recipient, so one busy stream cannot age out another', t => {
  const { store } = fixture(t);
  const base = 2 * 3600000;
  store.now = () => base;
  store.event('a', 'quiet', null);
  for (let index = 0; index < store.retention.retainedEvents + 3; index++) store.event('b', 'burst', null);
  store.prunedAt = 0;
  store.prune();
  assert(store.one('SELECT COUNT(*) n FROM events WHERE recipient=?', 'a').n >= 1, 'the quiet recipient keeps its event');
  assert(store.one('SELECT COUNT(*) n FROM events WHERE recipient=?', 'b').n <= store.retention.retainedEvents, 'the busy recipient is bounded');
});
