import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserAccess } from '../plugins/browser/access.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'browser-permission-race-'));
  const workers = [];
  t.after(async () => {
    for (const w of workers) if (w.child.exitCode === null && w.child.signalCode === null) w.child.kill('SIGKILL');
    await Promise.all(workers.map(w => w.exited));
    await rm(home, { recursive: true, force: true });
  });
  const worker = (action, origin, pause = false) => {
    const child = fork(new URL('./fixtures/browser-permission-worker.mjs', import.meta.url), [home, action, origin, ...(pause ? ['pause'] : [])], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      ...(process.env.DSCODE_TEST_PERMISSION_EXECUTABLE ? { execPath: process.env.DSCODE_TEST_PERMISSION_EXECUTABLE, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}) });
    const messages = [], waiters = [];
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    child.on('message', message => { messages.push(message); for (const wake of waiters.splice(0)) wake(); });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal, errors })));
    const phase = async expected => {
      for (;;) {
        const found = messages.find(m => m.phase === expected || m.phase === 'error');
        if (found) { assert.notEqual(found.phase, 'error', found.message); return found; }
        await Promise.race([new Promise(resolve => waiters.push(resolve)), exited.then(r => { throw Error(`Worker exited before ${expected}: ${JSON.stringify(r)}`); })]);
      }
    };
    const result = { child, messages, exited, phase }; workers.push(result); return result;
  };
  return { home, access: new BrowserAccess(home), worker };
}

test('independent permission writers retain a block and an unrelated grant', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://blocked.example');
  const allowed = f.worker('allow', 'https://other.example', true);
  await allowed.phase('read');
  const blocked = f.worker('block', 'https://blocked.example');
  await blocked.phase('started');
  await delay(200);
  const overlapping = blocked.messages.some(m => m.phase === 'read');
  if (overlapping) await blocked.phase('done');
  allowed.child.send('release');
  await Promise.all([blocked.phase('done'), allowed.phase('done')]);
  assert.equal((await blocked.exited).code, 0); assert.equal((await allowed.exited).code, 0);
  const policy = await f.access.status();
  assert.equal(policy.sites['https://blocked.example'].access, 'block', 'an unrelated grant must not overwrite a committed block');
  assert.equal(policy.sites['https://other.example'].access, 'allow');
  assert.equal(overlapping, false, 'read-modify-write must be exclusive across processes');
});

test('a killed permission writer releases its guard without losing the committed rules', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.access.update('block', 'https://blocked.example');
  const killed = f.worker('allow', 'https://blocked.example', true);
  await killed.phase('read'); killed.child.kill('SIGKILL'); await killed.exited;
  const next = f.worker('allow', 'https://other.example'); await next.phase('done');
  assert.equal((await next.exited).code, 0);
  const policy = await f.access.status();
  assert.equal(policy.sites['https://blocked.example'].access, 'block');
  assert.equal(policy.sites['https://other.example'].access, 'allow');
});

test('malformed policy releases the write guard and a corrected file remains writable', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, 'permissions.json'), '{broken');
  await assert.rejects(f.access.update('allow', 'https://other.example'));
  await writeFile(join(f.home, 'permissions.json'), JSON.stringify({ developerMode: false, sites: {} }));
  await f.access.update('block', 'https://other.example');
  assert.equal((await f.access.status()).sites['https://other.example'].access, 'block');
  assert.equal((await stat(join(f.home, 'permissions.json'))).mode & 0o777, 0o600);
});

test('a contended writer times out without blocking reads or the event loop, then retries', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.access.update('block', 'https://blocked.example');
  const owner = f.worker('allow', 'https://blocked.example', true);
  await owner.phase('read');
  const updating = assert.rejects(f.access.update('allow', 'https://other.example'), /being edited by another process/);
  await delay(25);
  assert.equal((await f.access.status()).sites['https://blocked.example'].access, 'block');
  await updating;
  assert.equal((await f.access.status()).sites['https://other.example'], undefined);
  assert.equal((await stat(join(f.home, 'permissions.guard.sqlite'))).mode & 0o777, 0o600);
  owner.child.send('release'); await owner.phase('done'); await owner.exited;
  await f.access.update('allow', 'https://other.example');
  assert.equal((await f.access.status()).sites['https://other.example'].access, 'allow');
});

test('aliases in one Host cannot release the guard held against another process', { timeout: 10000 }, async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const read = f.access.read.bind(f.access); let held = false;
  f.access.read = async () => {
    const policy = await read();
    if (!held) { held = true; entered.resolve(); await release.promise; }
    return policy;
  };
  const owner = f.access.update('block', 'https://blocked.example');
  await entered.promise;
  const alias = new BrowserAccess(f.home + '/.').update('allow', 'https://alias.example');
  try {
    await delay(50);
    const other = f.worker('allow', 'https://other.example'); await other.phase('started');
    await delay(200);
    assert(!other.messages.some(m => m.phase === 'read'), 'opening the guard through an alias must not drop the active OS lock');
    release.resolve(); await Promise.all([owner, alias, other.phase('done')]);
    assert.equal((await other.exited).code, 0);
    const policy = await f.access.status();
    assert.equal(policy.sites['https://blocked.example'].access, 'block');
    assert.equal(policy.sites['https://alias.example'].access, 'allow');
    assert.equal(policy.sites['https://other.example'].access, 'allow');
  } finally { release.resolve(); await Promise.allSettled([owner, alias]); }
});

test('a different process can revoke a temporary grant without the reader observing the intermediate block', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.access.update('once', 'https://blocked.example');
  await f.access.checkUrl('https://blocked.example');
  const revoker = f.worker('block-forget', 'https://blocked.example');
  await revoker.phase('done'); assert.equal((await revoker.exited).code, 0);
  assert.deepEqual((await f.access.status()).sessionSites, []);
  await assert.rejects(f.access.checkUrl('https://blocked.example'), /needs user permission/);
  await f.access.update('once', 'https://blocked.example');
  await f.access.checkUrl('https://blocked.example');
});
