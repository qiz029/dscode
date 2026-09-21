import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeTrigger } from '../plugins/triggers/config.mjs';
import { appendRun, formatRun, readRuns, runTailPath, writeRunTail } from '../plugins/triggers/log.mjs';
import { consumeEvent, emitEvent, listEvents, MAX_EVENT_TEXT_BYTES } from '../plugins/triggers/spool.mjs';
import { alivePid, finishTriggerRun, lockPath, planTriggerRun, releaseTriggerRun } from '../plugins/triggers/run.mjs';

// The safety half of the trigger mechanism: an unattended run must not overlap
// itself, must not fire twice for one event, and must respect its limits. The
// execution of the session itself is not implemented here.

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-trigger-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const workspace = join(root, 'repo');
  mkdirSync(workspace, { recursive: true });
  const definition = normalizeTrigger({
    id: 'nightly-review',
    workspace,
    prompt: 'review the diff',
    source: { kind: 'calendar', cron: '0 9 * * *' },
    goal: { objective: 'the diff is reviewed' },
    limits: { minIntervalSeconds: 60, maxRunsPerDay: 2, timeoutSeconds: 900 },
    ...overrides,
  });
  return { home, workspace, definition };
}

test('an event is stored as data and refused when it tries to carry more', t => {
  const { home } = fixture(t);
  const event = emitEvent(home, 'nightly-review', { source: 'ci', title: 'build', text: 'the build failed', fields: { run: 42, branch: 'main' } }, { eventId: 'build-123', now: NOW });
  assert.deepEqual(event, {
    triggerId: 'nightly-review', eventId: 'build-123', source: 'ci', title: 'build',
    text: 'the build failed', fields: { run: 42, branch: 'main' }, receivedAt: NOW,
  });
  assert.deepEqual(listEvents(home, 'nightly-review'), [event]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'triggers', 'spool', 'nightly-review', 'build-123.json'), 'utf8')), event);

  // The authority boundary: a producer cannot name a permission or a session.
  assert.throws(() => emitEvent(home, 'nightly-review', { text: 'x', permission: 'danger-full-access' }, { eventId: 'e1', now: NOW }), /no such field: permission/);
  assert.throws(() => emitEvent(home, 'nightly-review', { text: 'x', sessionId: 's' }, { eventId: 'e1', now: NOW }), /no such field: sessionId/);
  assert.throws(() => emitEvent(home, 'nightly-review', { text: 'x' }, { now: NOW }), /eventId is required/);
  assert.throws(() => emitEvent(home, 'nightly-review', { text: 'x', fields: { nested: { a: 1 } } }, { eventId: 'e1', now: NOW }), /must be a string, number or boolean/);
  assert.throws(() => emitEvent(home, 'nightly-review', { text: 'x'.repeat(MAX_EVENT_TEXT_BYTES + 1) }, { eventId: 'e1', now: NOW }), /longer than 64000 bytes/);
  assert.throws(() => emitEvent(home, 'Bad Id', { text: 'x' }, { eventId: 'e1', now: NOW }), /triggerId/);
});

test('events are listed oldest first and consumed at most once', t => {
  const { home } = fixture(t);
  emitEvent(home, 'nightly-review', { text: 'second' }, { eventId: 'b', now: NOW + 1000 });
  emitEvent(home, 'nightly-review', { text: 'first' }, { eventId: 'a', now: NOW });
  assert.deepEqual(listEvents(home, 'nightly-review').map(event => event.eventId), ['a', 'b']);
  assert.equal(consumeEvent(home, 'nightly-review', 'a'), true);
  assert.deepEqual(listEvents(home, 'nightly-review').map(event => event.eventId), ['b']);
  assert.equal(consumeEvent(home, 'nightly-review', 'a'), false);
});

test('a run record keeps the vocabulary and a torn line never breaks the listing', t => {
  const { home } = fixture(t);
  appendRun(home, { triggerId: 'nightly-review', runId: 'r1', startedAt: NOW, outcome: 'completed', exitCode: 0, cost: 0.42, rounds: 3 });
  assert.throws(() => appendRun(home, { triggerId: 'nightly-review', runId: 'r2', startedAt: NOW, outcome: 'finished', exitCode: 0 }), /outcome must be one of/);
  assert.throws(() => appendRun(home, { triggerId: 'nightly-review', runId: 'r2', startedAt: NOW, outcome: 'failed', reason: 'because', exitCode: 1 }), /reason must be null or one of/);
  assert.throws(() => appendRun(home, { triggerId: 'nightly-review', startedAt: NOW, outcome: 'failed', exitCode: 1 }), /needs runId/);
  writeFileSync(join(home, 'triggers', 'runs.jsonl'), '{"triggerId":"nightly-review","runId":"torn"', { flag: 'a' });
  const runs = readRuns(home, { triggerId: 'nightly-review' });
  assert.equal(runs.length, 1, 'the torn line is skipped, not fatal');
  assert.equal(readRuns(home, { triggerId: 'other' }).length, 0);
  assert.match(formatRun(runs[0]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} completed exit 0 \$0\.42 3r$/);
  assert.equal(formatRun(undefined), 'never ran');
  const tail = writeRunTail(home, 'nightly-review', 'r1', 'the last words\n');
  assert.equal(tail, runTailPath(home, 'nightly-review', 'r1'));
  assert.equal(readFileSync(tail, 'utf8'), 'the last words\n');
});

test('every run needs an identity, or the duplicate check is inert', t => {
  const { home, definition } = fixture(t);
  assert.throws(() => planTriggerRun(definition, { home, now: NOW }), /needs an eventId/);
  assert.throws(() => planTriggerRun(definition, { home, now: NOW, eventId: '  ' }), /needs an eventId/);
});

test('the decision refuses a disabled trigger, a missing workspace and a spent budget', t => {
  const { home, definition } = fixture(t);
  assert.deepEqual(planTriggerRun({ ...definition, enabled: false }, { home, now: NOW, eventId: 'e1' }), { action: 'skip', reason: 'disabled' });
  assert.deepEqual(planTriggerRun({ ...definition, workspace: join(home, 'gone') }, { home, now: NOW, eventId: 'e1' }), { action: 'skip', reason: 'workspace_missing' });

  const { home: home2, definition: definition2 } = fixture(t);
  appendRun(home2, { triggerId: definition2.id, runId: 'r1', startedAt: NOW - 10 * 60 * 1000, outcome: 'completed', exitCode: 0 });
  appendRun(home2, { triggerId: definition2.id, runId: 'r2', startedAt: NOW - 5 * 60 * 1000, outcome: 'completed', exitCode: 0 });
  assert.deepEqual(planTriggerRun(definition2, { home: home2, now: NOW, eventId: 'e2' }), { action: 'skip', reason: 'over_daily_limit' });

  const { home: home3, definition: definition3 } = fixture(t);
  appendRun(home3, { triggerId: definition3.id, runId: 'r1', startedAt: NOW - 10 * 1000, outcome: 'completed', exitCode: 0 });
  assert.deepEqual(planTriggerRun(definition3, { home: home3, now: NOW, eventId: 'e3' }), { action: 'skip', reason: 'too_soon' });

  // A skipped decision is not a run, so it must not count against the day or the interval.
  const { home: home4, definition: definition4 } = fixture(t);
  for (let index = 0; index < 5; index += 1) appendRun(home4, { triggerId: definition4.id, runId: `r${index}`, startedAt: NOW, outcome: 'skipped', reason: 'too_soon', exitCode: 0 });
  assert.equal(planTriggerRun(definition4, { home: home4, now: NOW, eventId: 'e4' }).action, 'run');
});

test('the same event never runs twice', t => {
  const { home, definition } = fixture(t);
  appendRun(home, { triggerId: definition.id, runId: 'r1', startedAt: NOW - 2 * 60 * 60 * 1000, eventId: 'build-123', outcome: 'completed', exitCode: 0 });
  assert.deepEqual(planTriggerRun(definition, { home, now: NOW, eventId: 'build-123' }), { action: 'skip', reason: 'duplicate' });
  assert.equal(planTriggerRun(definition, { home, now: NOW, eventId: 'build-124' }).action, 'run');
});

test('single flight skips a live run and reclaims a dead one', t => {
  const { home, definition } = fixture(t);
  const first = planTriggerRun(definition, { home, now: NOW, eventId: 'lock-1' });
  assert.equal(first.action, 'run');
  assert.deepEqual(planTriggerRun(definition, { home, now: NOW + 5 * 60 * 1000, eventId: 'lock-2' }), { action: 'skip', reason: 'already_running' });

  // A lock from a process that is gone is reclaimed instead of blocking forever.
  const dead = { triggerId: definition.id, runId: 'ghost', startedAt: NOW, pid: 4194304, eventId: null };
  writeFileSync(lockPath(home, definition.id), JSON.stringify(dead));
  assert.equal(alivePid(4194304), false);
  const reclaimed = planTriggerRun(definition, { home, now: NOW + 5 * 60 * 1000, eventId: 'lock-3' });
  assert.equal(reclaimed.action, 'run');
  assert.notEqual(reclaimed.handle.runId, 'ghost');

  // An old lock ages out even when its pid happens to be alive again.
  const stale = { triggerId: definition.id, runId: 'ancient', startedAt: NOW - 10 * 60 * 60 * 1000, pid: process.pid, eventId: null };
  writeFileSync(lockPath(home, definition.id), JSON.stringify(stale));
  assert.equal(planTriggerRun(definition, { home, now: NOW + 5 * 60 * 1000, eventId: 'lock-4' }).action, 'run');
  assert.equal(alivePid(process.pid), true);
});

test('finishing records how the run ended and releases the lock it owns', t => {
  const { home, workspace, definition } = fixture(t);
  const planned = planTriggerRun(definition, { home, now: NOW, eventId: 'build-9' });
  const record = finishTriggerRun(home, planned.handle, { outcome: 'completed', exitCode: 0, sessionId: 'session-1', cost: 0.5, rounds: 4, endedAt: NOW + 2000, cwd: workspace });
  assert.deepEqual({ ...record, endedAt: undefined }, {
    triggerId: definition.id, runId: planned.handle.runId, startedAt: NOW, endedAt: undefined, eventId: 'build-9', source: null,
    outcome: 'completed', reason: null, exitCode: 0, sessionId: 'session-1', cost: 0.5, rounds: 4, cwd: workspace,
  });
  assert.equal(readRuns(home, { triggerId: definition.id }).length, 1);
  // The lock is gone, so the next window (past the minimum interval) may run.
  assert.equal(planTriggerRun(definition, { home, now: NOW + 61 * 1000, eventId: 'later' }).action, 'run');

  // A lock that belongs to another run is left alone.
  const second = fixture(t);
  const other = planTriggerRun(second.definition, { home: second.home, now: NOW, eventId: 'other' });
  assert.equal(other.action, 'run');
  writeFileSync(lockPath(second.home, second.definition.id), JSON.stringify({ ...other.handle, runId: 'someone-else' }));
  finishTriggerRun(second.home, other.handle, { outcome: 'failed', reason: 'model_error', exitCode: 1 });
  assert.equal(JSON.parse(readFileSync(lockPath(second.home, second.definition.id), 'utf8')).runId, 'someone-else');
});

test('a lock that cannot be read is never deleted by someone else', t => {
  const { home, definition } = fixture(t);
  const planned = planTriggerRun(definition, { home, now: NOW, eventId: 'e1' });
  // A torn lock (crash mid-write) cannot prove ownership, so it stays and ages out.
  writeFileSync(lockPath(home, definition.id), '{"triggerId":"nightly-rev');
  assert.equal(releaseTriggerRun(home, planned.handle), false);
  assert.equal(readFileSync(lockPath(home, definition.id), 'utf8'), '{"triggerId":"nightly-rev');
  writeFileSync(lockPath(home, definition.id), JSON.stringify(planned.handle));
  assert.equal(releaseTriggerRun(home, planned.handle), true);
});

test('an event identity is bounded and free of control characters', t => {
  const { home } = fixture(t);
  assert.throws(() => emitEvent(home, 'nightly-review', { text: 'x' }, { eventId: 'e'.repeat(201), now: NOW }), /longer than 200 characters/);
  assert.throws(() => emitEvent(home, 'nightly-review', { text: 'x' }, { eventId: 'bad\u0007id', now: NOW }), /control characters/);
  assert.equal(emitEvent(home, 'nightly-review', { text: 'x' }, { eventId: '2026-09-21T09:00', now: NOW }).eventId, '2026-09-21T09:00');
});
