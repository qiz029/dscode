import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { dueTime, nextFiring, dueFiring } from '../plugins/triggers/schedule.mjs';
import { normalizeTrigger } from '../plugins/triggers/config.mjs';
import { runTriggerCli } from '../plugins/triggers/cli.mjs';
import { schedulerTick, launchJobWorker } from '../plugins/triggers/scheduler.mjs';
import { acquireTriggerLease } from '../plugins/triggers/lease.mjs';
import { appendRun, readRuns } from '../plugins/triggers/log.mjs';

const NOW = Date.parse('2026-09-21T08:00:00Z');
function fixture(t, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-jobs-'));
  const raw = { id: 'monitor', workspace: home, prompt: '{{event.text}}', source: { kind: 'external' }, goal: { objective: 'handle the event' }, ...extra };
  mkdirSync(join(home, 'triggers'));
  writeFileSync(join(home, 'triggers', 'monitor.json'), JSON.stringify(raw));
  const store = new JobStore(home);
  t.after(() => { store.close(); rmSync(home, { recursive: true, force: true }); });
  const output = [];
  const deps = { home, project: home, now: NOW, stdout: { write: s => output.push(s) }, stderr: { write: s => output.push(s) } };
  const create = overrides => store.create({ triggerId: 'monitor', project: home, workspace: home, dueAt: NOW, now: NOW, ...overrides });
  return { home, raw, definition: normalizeTrigger(raw), store, deps, output, create };
}

test('delay times require one future duration or an explicit-offset calendar timestamp', () => {
  assert.equal(dueTime({ after: '30m' }, NOW), NOW + 1800000);
  assert.equal(dueTime({ after: '1.5s' }, NOW), NOW + 1500);
  assert.equal(dueTime({ at: '2026-09-21T09:00:00-07:00' }, NOW), Date.parse('2026-09-21T16:00:00Z'));
  for (const options of [{}, { after: '0s' }, { after: '-1m' }, { after: 'soon' }, { after: '1m', at: 'x' }, { at: '2026-09-22T09:00:00' }, { at: '2027-02-30T09:00:00Z' }, { at: '2020-01-01T00:00:00Z' }]) assert.throws(() => dueTime(options, NOW));
});

test('cron ranges, steps, timezones and daylight-saving transitions use real instants', () => {
  const source = { kind: 'calendar', cron: '*/15 9-17 * * 1-5', timezone: 'America/Los_Angeles' };
  assert.equal(nextFiring(source, NOW), Date.parse('2026-09-21T16:00:00Z'));
  const daily = { ...source, cron: '0 9 * * *' };
  assert.equal(nextFiring(daily, Date.parse('2026-03-07T17:00:00Z')), Date.parse('2026-03-08T16:00:00Z'));
  assert.equal(nextFiring(daily, Date.parse('2026-10-31T16:00:00Z')), Date.parse('2026-11-01T17:00:00Z'));
  assert.equal(nextFiring({ ...daily, cron: '30 1 * * *' }, Date.parse('2026-11-01T08:30:00Z')), Date.parse('2026-11-02T09:30:00Z'), 'a repeated fall-back wall time is not a second daily occurrence');
});

test('misfire coalesces many missed days into one latest occurrence or skips it', () => {
  const source = { kind: 'calendar', cron: '0 9 * * *', timezone: 'UTC', misfire: 'run-once' };
  const old = Date.parse('2026-09-01T09:00:00Z'), now = Date.parse('2026-09-21T12:00:00Z');
  assert.deepEqual(dueFiring(source, old, now), { scheduledAt: Date.parse('2026-09-21T09:00:00Z'), nextAt: Date.parse('2026-09-22T09:00:00Z'), skipped: false });
  assert.equal(dueFiring({ ...source, misfire: 'skip' }, old, now).skipped, true);
});

test('invalid calendar rules and timezones are refused before registration', t => {
  const f = fixture(t);
  for (const source of [
    { kind: 'calendar', cron: '90 9 * * *' },
    { kind: 'calendar', cron: '0 9 * * *', timezone: 'not/a-zone' },
    { kind: 'calendar', cron: '0 9 * * *', misfire: 'replay-all' },
  ]) assert.throws(() => normalizeTrigger({ ...f.raw, source }));
});

test('jobs and schedule cursors survive reopening and one scan cannot generate an occurrence twice', t => {
  const f = fixture(t, { source: { kind: 'calendar', cron: '0 9 * * *', timezone: 'UTC' } });
  const job = f.create({ dueAt: NOW + 1000, payload: { text: 'later' } });
  f.store.register(f.definition, f.home, NOW);
  const second = new JobStore(f.home);
  try {
    assert.equal(JSON.parse(second.get(job.id).payload).text, 'later');
    const due = NOW + 5 * 3600000;
    assert.equal(second.materialize(() => f.definition, due).length, 1);
    assert.equal(f.store.materialize(() => f.definition, due).length, 0);
    assert.equal(second.list().length, 2);
  } finally { second.close(); }
});

test('the cursor and generated job roll back together on a failed transaction', t => {
  const f = fixture(t, { source: { kind: 'calendar', cron: '0 9 * * *', timezone: 'UTC' } });
  const schedule = f.store.register(f.definition, f.home, NOW);
  const create = f.store.create.bind(f.store);
  f.store.create = args => { create(args); throw Error('interrupted transaction'); };
  assert.throws(() => f.store.materialize(() => f.definition, NOW + 3600000), /interrupted/);
  assert.equal(f.store.list().length, 0);
  assert.equal(f.store.schedules()[0].nextAt, schedule.nextAt);
});

test('cancel and claim exclude each other across database connections', t => {
  const f = fixture(t), other = new JobStore(f.home);
  try {
    const cancelled = f.create();
    other.cancel(cancelled.id, NOW);
    assert.equal(f.store.claim(cancelled.id, 'r1', NOW), false);
    const running = f.create();
    assert.equal(f.store.claim(running.id, 'r2', NOW), true);
    assert.throws(() => other.cancel(running.id, NOW), /running/);
    assert.equal(other.claim(running.id, 'r3', NOW), false);
  } finally { other.close(); }
});

test('schedule/jobs/cancel CLI persists data without starting an agent', async t => {
  const f = fixture(t);
  const deps = { ...f.deps, spawnRun: async () => { assert.fail('must not start now'); } };
  assert.equal(await runTriggerCli(['schedule', 'monitor', '--after', '30m', '--text', 'later'], deps), 0);
  const [job] = f.store.list();
  assert.equal(job.dueAt, NOW + 1800000);
  assert.equal(await runTriggerCli(['jobs'], deps), 0);
  assert.equal(await runTriggerCli(['cancel', job.id], deps), 0);
  assert.equal(f.store.get(job.id).state, 'cancelled');
  assert.equal(await runTriggerCli(['schedule', 'monitor', '--after', '0s'], deps), 1);
});

test('a due job follows the trigger path and records job, run and session identities', async t => {
  const f = fixture(t, { session: { mode: 'persistent' } });
  const job = f.create({ payload: { text: 'job payload' } });
  let spec;
  assert.equal(await runTriggerCli(['run-job', job.id], { ...f.deps, spawnRun: async args => {
    spec = args.spec;
    assert.equal(f.store.get(job.id).state, 'running');
    return { code: 0, result: { outcome: 'completed', exitCode: 0, sessionId: 'session-1', rounds: 2 } };
  } }), 0);
  assert.equal(spec.prompt, 'job payload');
  assert.equal(spec.session.mode, 'persistent');
  assert.equal(spec.jobId, job.id);
  assert.equal(f.store.get(job.id).state, 'completed');
  assert.equal(f.store.get(job.id).sessionId, 'session-1');
  assert.equal(readRuns(f.home)[0].jobId, job.id);
});

test('overlap, minimum interval and daily caps leave a job pending with its waiting reason', async t => {
  const f = fixture(t, { limits: { minIntervalSeconds: 60, maxRunsPerDay: 1 } });
  const job = f.create();
  const lease = await acquireTriggerLease(f.home, 'monitor');
  assert.equal(await runTriggerCli(['run-job', job.id], f.deps), 0);
  assert.equal(f.store.get(job.id).reason, 'already_running');
  lease.release();
  appendRun(f.home, { triggerId: 'monitor', runId: 'older', startedAt: NOW, outcome: 'completed', exitCode: 0 });
  assert.equal(await runTriggerCli(['run-job', job.id], { ...f.deps, now: NOW + 2000 }), 0);
  assert.equal(f.store.get(job.id).state, 'pending');
  assert.equal(f.store.get(job.id).reason, 'over_daily_limit');
  assert.equal(f.store.get(job.id).availableAt, NOW + 86400000);
});

test('a failed job is terminal and the scheduler does not retry it', async t => {
  const f = fixture(t), job = f.create();
  assert.equal(await runTriggerCli(['run-job', job.id], { ...f.deps, spawnRun: async () => { throw Error('could not boot'); } }), 1);
  assert.equal(f.store.get(job.id).state, 'failed');
  assert.equal(f.store.pending(NOW + 86400000).length, 0);
});

test('minimum intervals defer jobs without claiming them and later delivery uses the original job', async t => {
  const f = fixture(t), job = f.create();
  appendRun(f.home, { triggerId: 'monitor', runId: 'older', startedAt: NOW - 1000, outcome: 'completed', exitCode: 0 });
  assert.equal(await runTriggerCli(['run-job', job.id], f.deps), 0);
  assert.equal(f.store.get(job.id).reason, 'too_soon');
  assert.equal(f.store.get(job.id).runId, null);
  const due = f.store.get(job.id).availableAt;
  assert.equal(due, NOW + 59000);
  assert.equal(await runTriggerCli(['run-job', job.id], { ...f.deps, now: due, spawnRun: async () => ({ code: 0, result: { outcome: 'completed', exitCode: 0 } }) }), 0);
  assert.equal(f.store.get(job.id).state, 'completed');
});

test('a deferred older job keeps its FIFO place until cancellation', t => {
  const f = fixture(t), older = f.create(), newer = f.create();
  f.store.defer(older.id, 'disabled', NOW + 30000);
  assert.equal(f.store.pending(NOW).length, 0);
  f.store.cancel(older.id, NOW);
  assert.deepEqual(f.store.pending(NOW).map(job => job.id), [newer.id]);
});

test('uninstall cancels only the pending jobs from that recurring registration', t => {
  const f = fixture(t, { source: { kind: 'calendar', cron: '* * * * *', timezone: 'UTC' } });
  f.store.register(f.definition, f.home, NOW);
  f.store.materialize(() => f.definition, NOW + 60000);
  const delayed = f.create();
  f.store.unregister('monitor', f.home, NOW + 60000);
  assert.equal(f.store.schedules().length, 0);
  assert.equal(f.store.get(delayed.id).state, 'pending');
  assert.equal(f.store.list().find(job => job.kind === 'cron').state, 'cancelled');
});

test('scheduler recovers a dead worker as interrupted, but waits for an orphaned Host lease', async t => {
  const f = fixture(t), job = f.create();
  f.store.claim(job.id, 'orphan-run', NOW);
  f.store.run('UPDATE jobs SET pid=? WHERE id=?', 4194304, job.id);
  const options = { home: f.home, store: f.store, active: new Map(), now: NOW, spawnWorker: () => assert.fail('must not retry') };
  const lease = await acquireTriggerLease(f.home, 'monitor');
  await schedulerTick(options);
  assert.equal(f.store.get(job.id).state, 'running');
  lease.release();
  await schedulerTick(options);
  assert.equal(f.store.get(job.id).state, 'failed');
  assert.equal(f.store.get(job.id).reason, 'interrupted');
});

test('a long worker does not block another trigger or the scheduler clock', async t => {
  const f = fixture(t), active = new Map(), release = Promise.withResolvers();
  f.create(); f.create(); f.create({ triggerId: 'other' });
  const started = [];
  await schedulerTick({ home: f.home, store: f.store, active, now: NOW, spawnWorker: ({ job }) => { started.push(job.triggerId); return release.promise; } });
  await Promise.resolve();
  assert.deepEqual(started, ['monitor', 'other']);
  assert.equal(active.size, 2);
  release.resolve(0);
  await Promise.all([...active.values()].map(e => e.promise));
});

test('worker processes carry the chosen state directory for both source and installed launchers', async t => {
  const f = fixture(t), job = f.create();
  const worker = join(f.home, 'worker.mjs');
  const output = join(f.home, 'worker-state.json');
  writeFileSync(worker, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(output)}, JSON.stringify({dsh:process.env.DSH_HOME,dscode:process.env.DSCODE_HOME,args:process.argv.slice(2)}));`);
  assert.equal(await launchJobWorker({ home: f.home, dscodePath: worker, job }), 0);
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), { dsh: f.home, dscode: f.home, args: ['trigger', 'run-job', job.id] });
});
