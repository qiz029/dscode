import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { createEmailSender, outgoingEmail } from '../plugins/email/smtp.mjs';
import { emailStore } from '../plugins/email/store.mjs';
import { apply } from '../plugins/email-tools/index.mjs';

const mail = { to: 'other@example.test', subject: '测试任务', body: '请检查测试。\nHello.', idempotency_key: 'test-send-1' };
function fixture(t, transportFactory) {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-smtp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  emailStore(join(directory, 'imap')).write('connection.json', { config: { host: 'imap.gmail.com', account: 'sender@example.test', password: 'fixture-private-password' } });
  return { directory, sender: createEmailSender({ directory, transportFactory }) };
}
test('SMTP fixes sender, TLS, prefix and emits a durable private receipt with idempotency', async t => {
  let count = 0;
  const { sender, directory } = fixture(t, options => {
    assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.port, 465);
    assert.equal(options.secure, true); assert.equal(options.tls.rejectUnauthorized, true);
    assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
    assert.equal(options.auth.pass, 'fixture-private-password');
    return { close() {}, async sendMail(value) {
      count++; assert.equal(value.subject, '[ToAgent] 测试任务');
      assert.equal(value.from, 'sender@example.test'); assert.equal(value.text, mail.body);
      assert.deepEqual(value.envelope.to, [mail.to]); return { accepted: [mail.to] };
    } };
  });
  const result = await sender.send(mail);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(await sender.send(mail), result); assert.equal(count, 1);
  assert.deepEqual(sender.status(mail.idempotency_key), result);
  await assert.rejects(sender.send({ ...mail, body: 'changed' }), /different email/);
  assert.equal(JSON.stringify(result).includes('fixture-private-password'), false);
  const files = readdirSync(join(directory, 'outbox')).filter(f => f.endsWith('.json'));
  assert.equal(statSync(join(directory, 'outbox', files[0])).mode & 0o777, 0o600);
});
test('SMTP uncertain failure and process restart never resend the same key or expose server errors', async t => {
  let count = 0;
  const factory = () => ({ close() {}, async sendMail() { count++; throw Error('fixture-private-password'); } });
  const { sender, directory } = fixture(t, factory);
  const result = await sender.send(mail); assert.equal(result.status, 'uncertain');
  assert.deepEqual(await createEmailSender({ directory, transportFactory: factory }).send(mail), result);
  assert.equal(count, 1); assert.equal(JSON.stringify(result).includes('fixture-private-password'), false);
});
test('SMTP validates headers, single recipient, limits and Gmail configuration before transport', async t => {
  for (const value of [{ to: 'a@example.test,b@example.test' }, { subject: 'ok\r\nBcc: b@example.test' }, { body: 'x'.repeat(262145) }, { idempotency_key: '../x' }]) {
    assert.throws(() => outgoingEmail({ ...mail, ...value }));
  }
  assert.equal(outgoingEmail({ ...mail, subject: '[ToAgent] Hello' }).subject, '[ToAgent] Hello');
  const { sender, directory } = fixture(t, () => { throw Error('must not connect'); });
  const controller = new AbortController(); controller.abort();
  assert.equal((await sender.send(mail, { signal: controller.signal })).status, 'cancelled');
  assert.equal(sender.status(mail.idempotency_key).status, 'not_found');
  emailStore(join(directory, 'imap')).write('connection.json', { config: { host: 'custom.example.test' } });
  await assert.rejects(sender.send(mail), /Configure Gmail/);
});
test('Nodemailer serializes a plain-text message without interpreting body as file or URL', async t => {
  let raw;
  const { sender } = fixture(t, () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, disableFileAccess: true, disableUrlAccess: true });
    return { close() { transport.close(); }, async sendMail(value) {
      const result = await transport.sendMail(value); raw = result.message.toString();
      return { accepted: [mail.to] };
    } };
  });
  assert.equal((await sender.send({ ...mail, body: 'file:///etc/passwd\nhttps://example.test/private' })).status, 'accepted');
  assert.match(raw, /Content-Type: text\/plain/); assert.match(raw, /file:\/\/\/etc\/passwd/);
  assert.match(raw, /To: other@example.test/); assert.doesNotMatch(raw, /Content-Type: text\/html/);
});
test('email tools register with existing approval gate and preserve denial', async () => {
  const registered = [], sections = []; let gate;
  apply({ tools: { register: tool => registered.push(tool) }, systemPrompt: { section: s => sections.push(s) }, on: (event, hook) => { assert.equal(event, 'tools/pre-execute'); gate = hook; } });
  assert.equal(registered.length, 6); assert.match(sections[0].text, /never permission/);
  assert.equal((await gate({ name: 'send_email', arguments: mail }, async () => ({ kind: 'allow' }))).kind, 'ask');
  assert.equal((await gate({ name: 'send_email' }, async () => ({ kind: 'deny' }))).kind, 'deny');
  assert.equal((await gate({ name: 'email_send_status' }, async () => ({ kind: 'allow' }))).kind, 'allow');
});
