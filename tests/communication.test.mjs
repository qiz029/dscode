process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { communicationPanel, createCommunicationFeed, foldCommunication, MAX_COMMUNICATION_ROWS } from '../packages/tui/src/communication.ts';

// Cross-session traffic is otherwise invisible: the transcript hides tool
// arguments and a waiting request looks like any other running tool. These tests
// pin the fold that the activity line, the notice and /tasks all read.

const call = (seq, time, name, args) => ({ type: 'tool/call', seq, time, data: { turn: 1, step: 1, callId: `call-${seq}`, name, arguments: JSON.stringify(args) } });
const result = (seq, time, callId, isError = false) => ({
  type: 'tool/result', seq, time,
  data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [], ...(isError ? { isError: true } : {}) }] } },
});
const relay = (seq, time, label, text, kind = 'reply') => ({
  type: 'user/message', seq, time,
  data: { id: `m-${seq}`, role: 'user', source: { kind: 'plugin', plugin: 'dscode-session-bridge', form: 'relay', communicationId: `msg-${seq}`, label },
    content: [{ type: 'text', text: `[External source: ${label}] [${kind}/queue]\nMessage ID: msg-${seq}${kind === 'reply' ? '; reply to: msg-other' : ''}\n${text}` }] },
});
const fold = events => events.reduce((view, event) => foldCommunication(view, event), createCommunicationFeed());

test('a send is one sent row that waits until its result lands', () => {
  const sent = fold([call(1, 1000, 'send_session', { session_id: 'session-target', kind: 'request', mode: 'queue', text: 'check the parser edge cases' })]);
  assert.equal(sent.rows.length, 1);
  assert.deepEqual(
    { direction: sent.rows[0].direction, peer: sent.rows[0].peer, kind: sent.rows[0].kind, mode: sent.rows[0].mode, pending: sent.rows[0].pending },
    { direction: 'sent', peer: 'session-target', kind: 'request', mode: 'queue', pending: true },
  );
  assert.match(sent.rows[0].preview, /check the parser edge cases/);
  assert.deepEqual(sent.waiting, []);

  const settled = foldCommunication(sent, result(2, 1500, 'call-1'));
  assert.equal(settled.rows[0].pending, false);
  assert.equal(settled.rows[0].failed, false);
  assert.deepEqual(settled.waiting.map(({ peer, since }) => ({ peer, since })), [{ peer: 'session-target', since: 1000 }]);
});

test('an inbound relay is a received row and clears that peer from waiting', () => {
  const view = fold([
    call(1, 1000, 'send_session', { session_id: 'session-target', kind: 'request', mode: 'queue', text: 'do it' }),
    result(2, 1100, 'call-1'),
  ]);
  assert.equal(view.waiting.length, 1);
  const answered = foldCommunication(view, relay(3, 1200, 'session:session-target', 'done, here is the answer'));
  assert.equal(answered.rows.at(-1).direction, 'received');
  assert.equal(answered.rows.at(-1).peer, 'session:session-target');
  assert.match(answered.rows.at(-1).preview, /here is the answer/);
  assert.deepEqual(answered.waiting, [], 'a reply from the peer clears the outstanding request');
});

test('only send/reply tools and bridge relays enter the feed', () => {
  const view = fold([
    call(1, 1000, 'read_session', { session_id: 'session-target' }),
    call(2, 1000, 'shell_retry', { command: 'ls' }),
    { type: 'user/message', seq: 3, time: 1000, data: { id: 'm', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
  ]);
  assert.equal(view.rows.length, 0);
  assert.equal(view.waiting.length, 0);
});

test('a failed send is recorded and never counted as waiting', () => {
  const view = fold([
    call(1, 1000, 'send_session', { session_id: 'session-target', kind: 'request', mode: 'queue', text: 'x' }),
    result(2, 1100, 'call-1', true),
  ]);
  assert.equal(view.rows[0].failed, true);
  assert.equal(view.rows[0].pending, false);
  assert.deepEqual(view.waiting, []);
});

test('a notify is not a waiting request, and the row window is bounded', () => {
  const notify = fold([
    call(1, 1000, 'send_session', { session_id: 'peer', kind: 'notify', mode: 'queue', text: 'fyi' }),
    result(2, 1100, 'call-1'),
  ]);
  assert.deepEqual(notify.waiting, []);

  const many = Array.from({ length: MAX_COMMUNICATION_ROWS + 5 }, (_, index) => call(index + 1, 1000 + index, 'send_session', { session_id: `peer-${index}`, kind: 'notify', mode: 'queue', text: 'x' }));
  const bounded = fold(many);
  assert.equal(bounded.rows.length, MAX_COMMUNICATION_ROWS);
  assert.equal(bounded.rows.at(-1).peer, `peer-${MAX_COMMUNICATION_ROWS + 4}`, 'the newest row survives the cap');
});

test('/tasks lists the traffic, its state and its direction', () => {
  const view = fold([
    call(1, 1000, 'send_session', { session_id: 'session-target', kind: 'request', mode: 'queue', text: 'check the parser' }),
    result(2, 1100, 'call-1'),
    call(3, 1200, 'reply_session', { request_message_id: 'msg-other', text: 'done' }),
    result(4, 1300, 'call-3'),
    relay(5, 1400, 'session:session-peer', 'here is my answer'),
  ]);
  const panel = communicationPanel(view);
  assert.match(panel, /→ session-target request\/queue · awaiting reply — check the parser/);
  assert.match(panel, /← session:session-peer reply · received/);
  assert.equal(communicationPanel(createCommunicationFeed()), 'No cross-session messages in this session.');
});

test('only a reply clears an outstanding request, not a stray notify', () => {
  const opened = fold([
    call(1, 1000, 'send_session', { session_id: 'session-target', kind: 'request', mode: 'queue', text: 'do it' }),
    result(2, 1100, 'call-1'),
  ]);
  assert.equal(opened.waiting.length, 1);
  const notified = foldCommunication(opened, relay(3, 1200, 'session:session-target', 'still working on it', 'notify'));
  assert.equal(notified.waiting.length, 1, 'a progress notify is not the answer');
  const replied = foldCommunication(notified, relay(4, 1300, 'session:session-target', 'done', 'reply'));
  assert.deepEqual(replied.waiting, []);
});

test('waiting survives a row window that truncated the original request', () => {
  // The request row is evicted by the cap, so a window-derived answer state
  // would leave the reply with nothing to clear and the turn "awaiting" a
  // session that already answered.
  const events = [
    call(1, 1000, 'send_session', { session_id: 'session-target', kind: 'request', mode: 'queue', text: 'do it' }),
    result(2, 1100, 'call-1'),
  ];
  for (let index = 0; index < MAX_COMMUNICATION_ROWS + 2; index += 1) {
    events.push(call(10 + index * 2, 2000 + index, 'send_session', { session_id: `peer-${index}`, kind: 'notify', mode: 'queue', text: 'x' }));
    events.push(result(11 + index * 2, 2100 + index, `call-${10 + index * 2}`));
  }
  const truncated = fold(events);
  assert.equal(truncated.rows.some(row => row.peer === 'session-target'), false, 'the request row really is evicted');
  assert.equal(truncated.waiting.length, 1);
  const answered = foldCommunication(truncated, relay(9999, 3000, 'session:session-target', 'done', 'reply'));
  assert.deepEqual(answered.waiting, [], 'the reply still clears the request it answers');
});

test('outbound and inbound rows never share an id', () => {
  const view = fold([
    call(1, 1000, 'send_session', { session_id: 'session-target', kind: 'request', mode: 'queue', text: 'x' }),
    relay(2, 1100, 'session:peer', 'hello', 'notify'),
  ]);
  const ids = view.rows.map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.startsWith('sent:') || id.startsWith('recv:')), ids.join(','));
});

test('two requests to one peer both stay visible as awaiting', () => {
  const view = fold([
    call(1, 1000, 'send_session', { session_id: 'session-a', kind: 'request', mode: 'queue', text: 'first' }),
    result(2, 1100, 'call-1'),
    call(3, 1200, 'send_session', { session_id: 'session-a', kind: 'request', mode: 'queue', text: 'second' }),
    result(4, 1300, 'call-3'),
  ]);
  assert.equal(view.waiting.length, 2, 'the second request does not overwrite the first');
  assert.deepEqual(view.waiting.map(entry => entry.id), ['sent:call-1', 'sent:call-3']);
});
