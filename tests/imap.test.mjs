import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImapConnector, imapConfiguration, imapEnvelope } from '../plugins/email/imap.mjs';
import { createEmailInbox } from '../plugins/email/inbox.mjs';
import { emailStore } from '../plugins/email/store.mjs';

const time = Date.parse('2026-09-12T10:00:00Z');
const config = { account: 'fixture@example.test', host: 'imap.gmail.com', port: 993, mailbox: 'INBOX', password: 'fixture-secret' };
const raw = (subject = '[ToAgent] Build task', type = 'text/plain; charset=utf-8', body = '检查构建\r\nPlease inspect.') => Buffer.from(`From: Other Agent <agent@example.test>\r\nTo: fixture@example.test\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: ${type}\r\n\r\n${body}`);
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-imap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const inbox = createEmailInbox({ directory }), calls = [], messages = new Map();
  const mailbox = { uidValidity: 1n, uidNext: 5 };
  let fail = false, failUid = null;
  const clientFactory = options => {
    assert.equal(options.secure, true); assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.logger, false); assert.equal(options.logRaw, false);
    return {
      mailbox, on() {}, close() { calls.push(['close']); },
      async connect() { if (fail) throw Error('server echoed fixture-secret'); },
      async getMailboxLock(folder, options) { assert.equal(options.readOnly, true); calls.push(['open', folder]); return { release() {} }; },
      async search(query, options) { calls.push(['search', query]); assert.equal(options.uid, true); return [...messages.keys()]; },
      async fetchOne(uid, query, options) {
        assert.equal(options.uid, true); calls.push(['fetch', uid, query]);
        if (uid === failUid) throw Error('interrupted');
        const entry = messages.get(uid); if (!entry) return false;
        return query.source ? { source: entry.source } : { uid, envelope: { subject: entry.subject }, internalDate: entry.date, size: entry.source.length, flags: new Set() };
      },
    };
  };
  const connector = createImapConnector({ inbox, clientFactory, now: () => time });
  const store = emailStore(join(directory, 'imap'));
  const add = (uid, subject = '[ToAgent] Build task', date = time + 1000, source = raw(subject)) => messages.set(uid, { subject, date: new Date(date), source });
  return { connector, inbox, calls, messages, mailbox, store, add, fail: value => { fail = value; }, failUid: value => { failUid = value; } };
}

test('IMAP setup uses TLS/read-only, persists privately after success and does not import history', async t => {
  const f = fixture(t); f.add(4);
  await f.connector.connect(config);
  assert.equal(f.inbox.list().emails.length, 0); assert.equal(f.store.read('connection.json').uidNext, 5);
  assert.equal(f.connector.status().password, undefined);
  assert(!JSON.stringify(f.connector.status()).includes(config.password));
  assert.equal(statSync(join(f.store.directory, 'connection.json')).mode & 0o777, 0o600);
  assert.equal(f.calls.filter(call => call[0] === 'search').length, 0);
  assert.equal(imapConfiguration({ ...config, password: 'abcd efgh ijkl mnop' }).password, 'abcdefghijklmnop');
  for (const value of [{ ...config, host: 'http://bad' }, { ...config, port: 0 }, { ...config, password: '' }, { ...config, host: 42 }]) assert.throws(() => imapConfiguration(value));
});

test('UID bounds prevent replay when no new messages exist and enforce exact subjects before body fetch', async t => {
  const f = fixture(t); await f.connector.connect(config); f.add(4);
  await f.connector.sync({ force: true }); assert.equal(f.calls.filter(call => call[0] === 'search').length, 0);
  f.mailbox.uidNext = 9;
  f.add(5); f.add(6, 'Re: [ToAgent] reply'); f.add(7, '[ToAgent] old mail', time - 1000); f.add(9, '[ToAgent] after snapshot');
  await f.connector.sync({ force: true });
  assert.equal(f.inbox.list().emails.length, 1); assert.equal(f.store.read('connection.json').uidNext, 9);
  assert.deepEqual(f.calls.filter(call => call[0] === 'fetch' && call[2].source).map(call => call[1]), [5]);
  assert.equal(f.calls.find(call => call[0] === 'search')[1].uid, '5:8');
});

test('failed sync retains cursor and retries already persisted mail idempotently', async t => {
  const f = fixture(t); await f.connector.connect(config); f.mailbox.uidNext = 7;
  f.add(5); f.add(6, '[ToAgent] Next task'); f.failUid(6);
  await assert.rejects(f.connector.sync({ force: true }), /sync failed/);
  assert.equal(f.store.read('connection.json').uidNext, 5); assert.equal(f.inbox.list().emails.length, 1);
  f.failUid(null); await f.connector.sync({ force: true });
  assert.equal(f.store.read('connection.json').uidNext, 7); assert.equal(f.inbox.list().emails.length, 2);
});

test('UIDVALIDITY recovery preserves date boundary and deduplicates content across renumbering', async t => {
  const f = fixture(t); await f.connector.connect(config); f.mailbox.uidNext = 6; f.add(5);
  await f.connector.sync({ force: true });
  f.messages.clear(); f.mailbox.uidValidity = 2n; f.mailbox.uidNext = 4;
  f.add(1); f.add(2, '[ToAgent] new task'); f.add(3, '[ToAgent] historical task', time - 1000);
  await f.connector.sync({ force: true });
  assert.equal(f.inbox.list().emails.length, 2);
  assert.equal(f.store.read('connection.json').uidValidity, '2');
  assert.equal(f.store.read('connection.json').connectedAt, time);
  assert(f.calls.findLast(call => call[0] === 'search')[1].since instanceof Date);
});

test('failed reauthentication never overwrites working credentials or exposes server error', async t => {
  const f = fixture(t); await f.connector.connect(config); f.fail(true);
  await assert.rejects(f.connector.connect({ ...config, password: 'replacement' }), error => !error.message.includes('fixture-secret'));
  assert.equal(f.store.read('connection.json').config.password, config.password);
  await assert.rejects(f.connector.connect({ ...config, account: 'different@example.test' }), /same IMAP/);
  f.fail(false); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.connector.connect(config, { signal: controller.signal }), /cancelled/);
});

test('MIME parser preserves Unicode plain text and excludes HTML-only or attachment-only mail', async () => {
  const state = { config, connectedAt: time }, meta = { internalDate: new Date(time + 1000) };
  assert.match((await imapEnvelope(raw(), meta, state)).body, /检查构建/);
  assert.equal(await imapEnvelope(raw('[ToAgent] html', 'text/html', '<b>task</b>'), meta, state), null);
  const multipart = raw('[ToAgent] attachment', 'multipart/mixed; boundary=x', '--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="task.txt"\r\n\r\nDo this\r\n--x--');
  assert.equal(await imapEnvelope(multipart, meta, state), null);
  const encoded = raw('=?UTF-8?B?' + Buffer.from('[ToAgent] 中文任务').toString('base64') + '?=');
  assert.equal((await imapEnvelope(encoded, meta, state)).subject, '[ToAgent] 中文任务');
});

test('cross-session lock blocks concurrent IMAP operations', async t => {
  const f = fixture(t); await f.connector.connect(config);
  let release; const pending = new Promise(resolve => { release = resolve; });
  const first = f.store.locked(() => pending); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await f.connector.sync({ force: true }), { busy: true });
  release(); await first;
  await f.connector.sync({ force: true });
});
