import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailContacts } from '../plugins/email/contacts.mjs';
import { runEmailClient } from '../plugins/email/cli.mjs';
import { apply } from '../plugins/email-tools/index.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-contacts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, contacts: createEmailContacts({ directory }) };
}
test('aliases persist across instances, normalize case and validate exact addresses', async t => {
  const { directory, contacts } = fixture(t);
  await contacts.set('CongKai', 'person@example.test');
  assert.deepEqual(createEmailContacts({ directory }).resolve('CONGKAI'), { alias: 'congkai', to: 'person@example.test' });
  assert.equal(statSync(join(directory, 'contacts', 'aliases.json')).mode & 0o777, 0o600);
  assert.throws(() => contacts.resolve('unknown'), /Unknown/);
  assert.throws(() => contacts.resolve('constructor'), /Unknown/);
  await assert.rejects(contacts.set('../x', 'person@example.test'));
  await assert.rejects(contacts.set('x', 'a@example.test,b@example.test'));
  await contacts.remove('CONGKAI'); assert.throws(() => contacts.resolve('congkai'), /Unknown/);
});
test('alias CLI sets, lists and removes without mailbox access', async t => {
  const { contacts } = fixture(t); const output = [];
  const options = { contacts, connector: {}, imap: {}, output: value => output.push(JSON.parse(value)) };
  await runEmailClient(['alias', 'set', 'congkai', 'person@example.test'], options);
  await runEmailClient(['alias', 'list'], options);
  assert.deepEqual(output[1], { congkai: 'person@example.test' });
  await runEmailClient(['alias', 'remove', 'congkai'], options);
  assert.deepEqual(contacts.list(), {});
});
test('alias approval includes actual address and rejects missing or stale resolved address', async t => {
  const { directory, contacts } = fixture(t);
  await contacts.set('congkai', 'person@example.test');
  const previous = process.env.DSCODE_EMAIL_DIR; process.env.DSCODE_EMAIL_DIR = directory;
  let gate;
  try { apply({ tools: { register() {} }, systemPrompt: { section() {} }, on: (_, hook) => { gate = hook; } }); }
  finally { if (previous === undefined) delete process.env.DSCODE_EMAIL_DIR; else process.env.DSCODE_EMAIL_DIR = previous; }
  const args = { to: 'congkai', resolved_to: 'person@example.test' };
  const check = arguments_ => gate({ name: 'send_email', arguments: arguments_ }, async () => ({ kind: 'allow' }));
  const decision = await check(args); assert.equal(decision.kind, 'ask'); assert.match(decision.reason, /congkai → person@example.test/);
  assert.equal((await check({ to: 'congkai' })).kind, 'deny');
  await contacts.set('congkai', 'changed@example.test');
  assert.equal((await check(args)).kind, 'deny');
});
test('agent manages aliases through registered tools shared with the CLI and resolver', async t => {
  const { directory, contacts } = fixture(t), tools = new Map();
  const previous = process.env.DSCODE_EMAIL_DIR; process.env.DSCODE_EMAIL_DIR = directory;
  try { apply({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, on() {} }); }
  finally { if (previous === undefined) delete process.env.DSCODE_EMAIL_DIR; else process.env.DSCODE_EMAIL_DIR = previous; }
  const call = (name, args = {}) => tools.get(name).execute(args, {});
  assert.deepEqual(await call('set_email_alias', { alias: 'CongKai', address: 'person@example.test' }), { alias: 'congkai', to: 'person@example.test' });
  assert.deepEqual(await call('list_email_aliases'), { aliases: { congkai: 'person@example.test' } });
  await call('set_email_alias', { alias: 'congkai', address: 'updated@example.test' });
  assert.equal(contacts.resolve('congkai').to, 'updated@example.test');
  assert.deepEqual(await call('resolve_email_recipient', { to: 'congkai' }), { alias: 'congkai', to: 'updated@example.test' });
  assert.match((await call('set_email_alias', { alias: 'congkai', address: 'invalid' })).error, /email address/);
  assert.equal(contacts.resolve('congkai').to, 'updated@example.test');
  await call('remove_email_alias', { alias: 'congkai' });
  assert.deepEqual(await call('list_email_aliases'), { aliases: {} });
});
