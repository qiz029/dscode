import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailInbox } from '../plugins/email/inbox.mjs';
import { createGmailConnector, gmailEnvelope, matchesGmailMessage, decodeHeader } from '../plugins/email/gmail.mjs';
import { gmailStore } from '../plugins/email/gmail-store.mjs';
import { runEmailClient } from '../plugins/email/cli.mjs';

const time = Date.parse('2026-09-12T10:00:00Z');
const state = { account: 'fixture@example.test', connectedAt: time, labelId: 'Label_1' };
const message = (id, changes = {}) => ({ id, labelIds: ['INBOX', 'UNREAD', 'Label_1'], internalDate: String(time + 1000),
  payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: '[ToAgent] Build task' }, { name: 'From', value: 'Other agent <agent@example.test>' }], body: { data: Buffer.from('检查构建\nPlease inspect the build.').toString('base64url') } }, ...changes });
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-gmail-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inbox = createEmailInbox({ directory });
  const home = join(directory, 'gmail'); mkdirSync(home);
  writeFileSync(join(home, 'client.json'), JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'test-only' } }));
  const calls = [];
  const routes = new Map([
    ['profile', { emailAddress: state.account, historyId: '100' }], ['labels', { labels: [{ id: 'Label_1', name: 'ToAgent' }] }],
    ['settings/filters', { filter: [{ criteria: { subject: '[ToAgent]' }, action: { addLabelIds: ['Label_1'] } }] }],
    ['history', { historyId: '101', history: [] }],
  ]);
  const transport = async (raw, options) => {
    const url = new URL(raw), path = url.pathname.split('/users/me/')[1] || 'token';
    calls.push({ path, url, options });
    const route = routes.get(path);
    if (route === undefined) throw Error('Unexpected test route: ' + path);
    const result = typeof route === 'function' ? await route(url, options) : route;
    return new Response(JSON.stringify(result.body ?? result), { status: result.status ?? 200 });
  };
  const connector = createGmailConnector({ inbox, now: () => time, fetchImpl: transport,
    authorize: async () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expiresAt: time + 3600000 }), ...overrides });
  return { connector, inbox, calls, routes, home, store: gmailStore(home) };
}

test('strict label/prefix/date/plain-text filter excludes unrelated mail and attachments', async () => {
  assert.equal((await gmailEnvelope(message('1'), state)).body, '检查构建\nPlease inspect the build.');
  for (const changes of [{ labelIds: [] }, { labelIds: ['Label_1', 'SPAM'] }, { labelIds: ['Label_1', 'SENT'] }, { internalDate: String(time - 1) }]) assert.equal(matchesGmailMessage(message('1', changes), state), false);
  for (const subject of ['Re: [ToAgent] reply', '[ToAgentX] task', 'x [ToAgent] task', '[DSCODE] task']) {
    const mail = message('1'); mail.payload.headers[0].value = subject;
    assert.equal(matchesGmailMessage(mail, state), false);
  }
  const html = message('1'); html.payload.mimeType = 'text/html';
  assert.equal(await gmailEnvelope(html, state), null);
  const attachment = message('1'); attachment.payload.filename = 'task.txt';
  assert.equal(await gmailEnvelope(attachment, state), null);
  const multi = message('2');
  multi.payload = { ...multi.payload, mimeType: 'multipart/alternative', parts: [html.payload, message('3').payload] };
  assert.match((await gmailEnvelope(multi, state)).body, /检查/);
  const encoded = '=?UTF-8?B?' + Buffer.from('[ToAgent] 中文').toString('base64') + '?=';
  assert.equal(decodeHeader(encoded), '[ToAgent] 中文');
});

test('connect provisions only missing label/filter and records boundary without loading old mail', async t => {
  const f = fixture(t);
  f.routes.set('labels', (_, options) => options.method === 'POST' ? { id: 'Label_1' } : { labels: [] });
  f.routes.set('settings/filters', (_, options) => options.method === 'POST' ? { id: 'Filter_1' } : { filter: [] });
  await f.connector.connect();
  assert.equal(f.connector.status().connected, true);
  assert.equal(f.store.read('state.json').historyId, '100');
  assert.equal(f.inbox.list().emails.length, 0);
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 2);
  assert(f.calls.every(call => !call.path.startsWith('messages')));
  for (const name of ['tokens.json', 'state.json']) assert.equal(statSync(join(f.home, name)).mode & 0o777, 0o600);
});

test('incremental pagination checks metadata before body, deduplicates and checkpoints after delivery', async t => {
  const f = fixture(t); await f.connector.connect();
  f.routes.set('history', url => url.searchParams.has('pageToken') ? { historyId: '102', history: [{ labelsAdded: [{ message: { id: '1' } }, { message: { id: '2' } }] }] }
    : { historyId: '102', nextPageToken: 'page2', history: [{ messagesAdded: [{ message: { id: '1' } }] }] });
  f.routes.set('messages/1', message('1'));
  f.routes.set('messages/2', message('2', { internalDate: String(time - 1) }));
  await f.connector.sync({ force: true });
  assert.equal(f.inbox.list().emails.length, 1);
  assert.equal(f.store.read('state.json').historyId, '102');
  assert.equal(f.calls.filter(call => call.path === 'messages/1' && call.url.searchParams.get('format') === 'full').length, 1);
  assert.equal(f.calls.filter(call => call.path === 'messages/2' && call.url.searchParams.get('format') === 'full').length, 0);
  await f.connector.sync({ force: true }); assert.equal(f.inbox.list().emails.length, 1);
  assert(f.calls.every(call => call.options.method === 'GET'));
});

test('failure retains cursor, retry does not duplicate already received messages', async t => {
  const f = fixture(t); await f.connector.connect();
  f.routes.set('history', { historyId: '102', history: [{ messagesAdded: [{ message: { id: '1' } }, { message: { id: '2' } }] }] });
  f.routes.set('messages/1', message('1')); f.routes.set('messages/2', { status: 503, body: {} });
  await assert.rejects(f.connector.sync({ force: true }), /503/);
  assert.equal(f.store.read('state.json').historyId, '100');
  assert.equal(f.inbox.list().emails.length, 1);
  f.routes.set('messages/2', message('2')); await f.connector.sync({ force: true });
  assert.equal(f.store.read('state.json').historyId, '102'); assert.equal(f.inbox.list().emails.length, 2);
});

test('expired cursor recovery retains original date boundary and captures cursor before enumeration', async t => {
  const f = fixture(t); await f.connector.connect();
  f.routes.set('history', { status: 404, body: {} }); f.routes.set('profile', { historyId: '500' });
  f.routes.set('messages', { messages: [{ id: '1' }, { id: '2' }] });
  f.routes.set('messages/1', message('1')); f.routes.set('messages/2', message('2', { internalDate: String(time - 10000) }));
  await f.connector.sync({ force: true });
  assert.equal(f.store.read('state.json').historyId, '500');
  assert.equal(f.inbox.list().emails.length, 1);
  const list = f.calls.find(call => call.path === 'messages'); assert.match(list.url.searchParams.get('q'), /^after:/);
  assert(f.calls.lastIndexOf(list) > f.calls.findLastIndex(call => call.path === 'profile'));
});

test('kernel lock prevents another session syncing or replacing credentials concurrently', async t => {
  const f = fixture(t); await f.connector.connect();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const first = f.store.locked(() => pending);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await f.connector.sync({ force: true }), { busy: true });
  release(); await first;
  await f.connector.sync({ force: true });
  assert.equal(f.store.read('state.json').historyId, '101');
});

test('expired tokens refresh privately; a different account cannot replace the connected account', async t => {
  const f = fixture(t); await f.connector.connect();
  f.store.write('tokens.json', { access_token: 'expired', refresh_token: 'test-refresh', expiresAt: 0 });
  f.routes.set('token', { access_token: 'renewed', expires_in: 3600 });
  await f.connector.sync({ force: true });
  assert.equal(f.store.read('tokens.json').refresh_token, 'test-refresh');
  assert.equal(f.connector.status().access_token, undefined);
  f.routes.set('profile', { emailAddress: 'different@example.test', historyId: '200' });
  await assert.rejects(f.connector.connect(), /original account/);
  assert.equal(f.store.read('tokens.json').access_token, 'renewed');
});

test('CLI imports a client privately, rejects invalid input, and never prints client secrets', async t => {
  const f = fixture(t), logs = [];
  const source = join(f.home, 'download.json');
  writeFileSync(source, JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'never-print-this' } }));
  await runEmailClient(['configure', source], { connector: f.connector, output: value => logs.push(value) });
  assert.equal(statSync(join(f.home, 'client.json')).mode & 0o777, 0o600);
  assert.equal(f.connector.status().configured, true);
  assert(!logs.join('').includes('never-print-this'));
  await assert.rejects(runEmailClient(['configure'], { connector: f.connector }), /Usage/);
  writeFileSync(source, '{broken');
  await assert.rejects(f.connector.configure(source), /Desktop OAuth/);
});
