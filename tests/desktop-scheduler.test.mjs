import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopTriggerScheduler } from '../plugins/triggers/desktop-scheduler.mjs';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { runScheduler } from '../plugins/triggers/scheduler.mjs';
import { acquireTriggerLease } from '../plugins/triggers/lease.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-scheduler-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const reports = [], owner = new DesktopTriggerScheduler({}, { home, report: message => reports.push(message) });
  t.after(() => owner.stop());
  return { home, owner, reports };
}

test('constructing a Desktop scheduler stays inert and start is single-flight', async t => {
  const f = fixture(t);
  assert.deepEqual(readdirSync(f.home), []);
  assert.equal(f.owner.status().running, false);
  const states = await Promise.all([f.owner.start(), f.owner.start()]);
  assert(states.every(state => state.running && state.owner === 'desktop'));
  assert.equal(await acquireTriggerLease(f.home, '_scheduler'), undefined);
  await f.owner.stop();
  const lease = await acquireTriggerLease(f.home, '_scheduler'); assert(lease); lease.release();
  assert.equal(f.owner.status().running, false);
  await f.owner.start(); await f.owner.stop();
});

test('a competing owner fails without stealing the scheduler lease', async t => {
  const f = fixture(t), other = new DesktopTriggerScheduler({}, { home: f.home, report() {} });
  await f.owner.start();
  await assert.rejects(other.start(), /already running/);
  assert.equal(f.owner.status().running, true);
  await f.owner.stop();
  await other.start();
  assert.equal(other.status().running, true);
  await other.stop();
});

test('stop during startup leaves due work pending without dispatch', async t => {
  const f = fixture(t), store = new JobStore(f.home);
  t.after(() => store.close());
  const job = store.create({ triggerId: 'pending', project: f.home, workspace: f.home, dueAt: Date.now() });
  f.owner.execute = async () => assert.fail('Work dispatched after stop');
  const starting = f.owner.start(), stopping = f.owner.stop();
  await Promise.all([starting, stopping]);
  assert.equal(store.get(job.id).state, 'pending');
  assert.equal(f.owner.status().running, false);
});

test('failed scheduler readiness releases its lease and never dispatches work', async t => {
  const f = fixture(t);
  await assert.rejects(runScheduler({ home: f.home, once: true,
    onReady: () => { throw Error('startup failed'); }, spawnWorker: () => assert.fail('unexpected worker'),
  }), /startup failed/);
  const lease = await acquireTriggerLease(f.home, '_scheduler'); assert(lease); lease.release();
});

test('Desktop queue refuses elevated definitions before claiming their jobs', async t => {
  const f = fixture(t), store = new JobStore(f.home);
  t.after(() => store.close());
  mkdirSync(join(f.home, 'triggers'), { recursive: true });
  writeFileSync(join(f.home, 'triggers/privileged.json'), JSON.stringify({ id: 'privileged', workspace: f.home, preset: 'dscode',
    permission: 'danger-full-access', source: { kind: 'external' }, prompt: 'fixture', goal: { objective: 'fixture' } }));
  const job = store.create({ triggerId: 'privileged', project: f.home, workspace: f.home, dueAt: Date.now() });
  await assert.rejects(f.owner.execute(job, new AbortController().signal), /read-only or workspace-write/);
  assert.equal(store.get(job.id).state, 'pending');
});

test('native job admission failure leaves the queue untouched and permits a later retry', async t => {
  const f = fixture(t);
  let detached = 0;
  f.owner.jobs = { attachController: () => () => detached++, start() { throw Error('native admission rejected'); } };
  await assert.rejects(f.owner.start(), /native admission rejected/);
  assert.equal(f.owner.task, undefined);
  assert.equal(detached, 1);
  assert.equal(f.owner.status().running, false);
  const lease = await acquireTriggerLease(f.home, '_scheduler'); assert(lease); lease.release();
  f.owner.jobs = undefined;
  await f.owner.start(); await f.owner.stop();
});

test('disposing an owner drains startup and permanently refuses new admission', async t => {
  const f = fixture(t);
  const starting = f.owner.start();
  await f.owner.dispose(); await starting;
  await assert.rejects(f.owner.start(), /disposed/);
  const lease = await acquireTriggerLease(f.home, '_scheduler'); assert(lease); lease.release();
});
