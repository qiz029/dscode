// Real Desktop RPC -> production ImapFlow -> loopback TLS fixture.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const inject = ['agents'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    console.error(error.stack);
    if (process.env.DSCODE_EMAIL_ELECTRON) process.send({ type: 'dscode-email-failed' });
    else ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const home = process.env.DSH_HOME, phase = process.env.DSCODE_EMAIL_PHASE;
  const control = state => writeFileSync(join(home, 'imap-fixture.json'), JSON.stringify(state));
  const traces = () => readFileSync(join(home, 'imap-trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const connection = ctx.get('connection'), origin = `http://127.0.0.1:${ctx.get('webServer').port}`;
  const auth = await fetch(connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const rpc = async payload => {
    const response = await fetch(origin + '/api/dscode-email', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-email', payload }) });
    assert.equal(response.status, 200);
    const body = await response.json(); assert(body.result.ok, body.result.error?.message);
    assert(!JSON.stringify(body).includes('fixture-app-password'), 'Password entered an RPC response');
    return body.result.value;
  };
  const settle = async () => {
    for (let i = 0; i < 250; i++) { const state = await rpc({ action: 'status' }); if (!state.pending) return state; await delay(20); }
    throw Error('Connector did not settle');
  };
  const saved = join(process.env.DSCODE_EMAIL_DIR, 'imap/connection.json');
  const config = { account: 'reader@example.test', password: 'fixture-app-password', host: '127.0.0.1', port: Number(process.env.DSCODE_IMAP_PORT), mailbox: 'INBOX' };
  assert.equal((await rpc({ action: 'status' })).enabled, false);
  if (phase === 'generate') {
    await rpc({ action: 'connect-imap', config: { ...config, port: Number(process.env.DSCODE_IMAP_UNTRUSTED_PORT) } });
    assert.equal((await settle()).last.ok, false);
    assert(!existsSync(saved)); assert(!traces().some(row => !row.trusted && row.verb === 'LOGIN'));
    await rpc({ action: 'connect-imap', config });
    const connected = await settle(); assert.equal(connected.last.ok, true); assert.equal(connected.imap.connected, true);
    assert.equal((await rpc({ action: 'list' })).total, 0, 'First connection imported old mail');
    assert.equal(statSync(saved).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(saved)).uidNext, 2);
    control({ uidNext: 3, holdSearch: true });
    await rpc({ action: 'sync' });
    for (let i = 0; i < 250 && !traces().some(row => row.verb === 'UID SEARCH'); i++) await delay(20);
    assert(traces().some(row => row.verb === 'UID SEARCH'));
    const cancelled = await rpc({ action: 'cancel' }); assert.equal(cancelled.pending, null); assert.equal(cancelled.last.ok, false);
    assert.equal(JSON.parse(readFileSync(saved)).uidNext, 2, 'Cancellation advanced the checkpoint');
    assert.equal((await rpc({ action: 'list' })).total, 0);
  } else {
    const restored = await rpc({ action: 'status' }); assert.equal(restored.imap.connected, true); assert.equal(restored.imap.account, config.account);
    if (phase === 'resume') {
      assert.equal((await rpc({ action: 'list' })).total, 0);
      control({ uidNext: 3, holdSearch: false });
      await rpc({ action: 'sync' }); assert.equal((await settle()).last.ok, true);
    }
    const listed = await rpc({ action: 'list' }); assert.equal(listed.total, 1);
    assert(!JSON.stringify(listed).includes('Do not send a reply.'));
    const preview = await rpc({ action: 'read', key: listed.emails[0].key }); assert.match(preview.body, /Local TLS mailbox context/);
    assert.equal(JSON.parse(readFileSync(saved)).uidNext, 3);
    const fetches = traces().filter(row => row.verb === 'BODY.PEEK').length;
    await rpc({ action: 'sync' }); assert.equal((await settle()).last.ok, true);
    assert.equal((await rpc({ action: 'list' })).total, 1);
    assert.equal(traces().filter(row => row.verb === 'BODY.PEEK').length, fetches, 'Repeat sync re-fetched old mail');
    assert(traces().some(row => row.verb === 'EXAMINE')); assert.equal(fetches, 1);
  }
  assert(!ctx.agents.list().length, 'Connector created an agent without explicit admission');
  if (phase === 'unload') {
    const searches = traces().filter(row => row.verb === 'UID SEARCH').length;
    control({ uidNext: 4, holdSearch: true });
    await rpc({ action: 'sync' });
    for (let i = 0; i < 250 && traces().filter(row => row.verb === 'UID SEARCH').length === searches; i++) await delay(20);
    assert.equal(traces().filter(row => row.verb === 'UID SEARCH').length, searches + 1);
    const service = ctx.get('dscodeEmail');
    await [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-email').fiber.dispose();
    assert.equal(ctx.get('dscodeEmail'), undefined);
    assert.equal(service.operation, null); assert.equal(service.timer, null);
    assert.equal(JSON.parse(readFileSync(saved)).uidNext, 3, 'Unload advanced an unfinished checkpoint');
  }
  console.log('DESKTOP_EMAIL_PASSED ' + JSON.stringify({ phase, realImapFlow: true, verifiedTls: true, noAgentCreated: true,
    ...(phase === 'generate' ? { untrustedCertificateRejected: true, credentialsPrivate: true, firstConnectionSkipsHistory: true, cancelledCheckpointPreserved: true }
      : { connectionRestored: true, plainTextImported: true, bodyPeekOnly: true, repeatSyncDedup: true }),
    ...(phase === 'unload' ? { activeSyncDrainedOnUnload: true } : {}) }));
  if (process.env.DSCODE_EMAIL_ELECTRON) process.send({ type: 'dscode-email-shutdown' });
  else ctx.get('appExit')(0);
}
