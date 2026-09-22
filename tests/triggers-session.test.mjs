import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { normalizeTrigger } from '../plugins/triggers/config.mjs';
import { runTriggerCli } from '../plugins/triggers/cli.mjs';
import { emitEvent, listEvents } from '../plugins/triggers/spool.mjs';
import { readRuns } from '../plugins/triggers/log.mjs';
import { bindingPath, openTriggerSession } from '../plugins/triggers/session.mjs';
import { acquireTriggerLease } from '../plugins/triggers/lease.mjs';
import { runTriggerHost } from '../plugins/triggers/host.mjs';
import { writeRunSpec, readRunResult } from '../plugins/triggers/options.mjs';

function fixture(t, overrides = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-trigger-session-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const raw = { id: 'monitor', workspace: home, prompt: 'Review {{event.text}}', source: { kind: 'external' }, session: { mode: 'persistent' }, goal: { objective: 'finish this event', maxRounds: 3 }, limits: { minIntervalSeconds: 1, maxRunsPerDay: 4 }, ...overrides };
  mkdirSync(join(home, 'triggers'));
  writeFileSync(join(home, 'triggers', 'monitor.json'), JSON.stringify(raw));
  let now = Date.now();
  const output = [];
  const deps = { home, project: home, clock: () => now, delay: async ms => { now += ms; }, stdout: { write: s => output.push(s) }, stderr: { write: s => output.push(s) } };
  return { home, raw, deps, output, definition: normalizeTrigger(raw) };
}

test('session modes default to new and persistent requires queue overlap', () => {
  const raw = { id: 't', workspace: '/tmp', prompt: 'p', source: { kind: 'external' }, goal: { objective: 'g' } };
  assert.deepEqual(normalizeTrigger(raw).session, { mode: 'new' });
  assert.equal(normalizeTrigger({ ...raw, session: { mode: 'persistent' } }).overlap, 'queue');
  for (const session of ['persistent', {}, { mode: 'typo' }, { mode: 'persistent', id: 'injected' }]) {
    assert.throws(() => normalizeTrigger({ ...raw, session }), /session/);
  }
  assert.throws(() => normalizeTrigger({ ...raw, session: { mode: 'persistent' }, overlap: 'skip' }), /overlap/);
});

test('binding survives another host, while new mode leaves it untouched', async t => {
  const f = fixture(t);
  const stored = new Map();
  const created = [], resumed = [], flushed = [];
  const ctx = {
    agents: {
      create: async ({ sessionId, meta }) => {
        created.push(sessionId);
        const handle = { agent: { session: { id: sessionId, header: meta, history: ['first event'] } } };
        stored.set(sessionId, handle);
        return handle;
      },
      resume: async ({ resumeSessionId }) => { resumed.push(resumeSessionId); return stored.get(resumeSessionId); },
    },
    sessions: { flush: async session => flushed.push(session.id) },
  };
  const spec = { ...f.definition, triggerId: 'monitor' };
  const first = await openTriggerSession(ctx, spec, { home: f.home });
  assert.deepEqual(flushed, created);
  const second = await openTriggerSession(ctx, spec, { home: f.home });
  assert.deepEqual(second.agent.session.history, ['first event']);
  assert.equal(second.agent.session.id, first.agent.session.id);
  assert.equal(created.length, 1);
  assert.deepEqual(resumed, created);
  const fresh = await openTriggerSession(ctx, { ...spec, session: { mode: 'new' } }, { home: f.home });
  assert.notEqual(fresh.agent.session.id, first.agent.session.id);
  const again = await openTriggerSession(ctx, spec, { home: f.home });
  assert.equal(again.agent.session.id, first.agent.session.id);
  await assert.rejects(openTriggerSession(ctx, { ...spec, workspace: '/different' }, { home: f.home }), /another workspace/);
  ctx.agents.resume = async () => { throw Error('session missing'); };
  await assert.rejects(openTriggerSession(ctx, spec, { home: f.home }), /session missing/);
  assert.equal(created.length, 2, 'a failed resume never silently replaces the session');
});

test('a failed initial flush cannot publish a persistent binding', async t => {
  const f = fixture(t);
  const ctx = { agents: { create: async () => ({ agent: { session: { id: 's', header: { cwd: f.home } } } }) }, sessions: { flush: async () => { throw Error('disk full'); } } };
  await assert.rejects(openTriggerSession(ctx, { ...f.definition, triggerId: 'monitor' }, { home: f.home }), /disk full/);
  assert.throws(() => readFileSync(bindingPath(f.home, 'monitor')), /ENOENT/);
});

test('persistent runs drain FIFO, including arrivals during execution, with separate limits and records', async t => {
  const f = fixture(t);
  const specs = [];
  emitEvent(f.home, 'monitor', { text: 'first' }, { eventId: 'e1', now: 1 });
  emitEvent(f.home, 'monitor', { text: 'second' }, { eventId: 'e2', now: 2 });
  const code = await runTriggerCli(['run', 'monitor'], { ...f.deps, spawnRun: async ({ spec }) => {
    specs.push(spec);
    if (spec.eventId === 'e1') emitEvent(f.home, 'monitor', { text: 'third' }, { eventId: 'e3', now: 3 });
    return { code: 0, result: { outcome: 'completed', exitCode: 0, sessionId: 'same-session', cost: 0.2, rounds: 1 } };
  } });
  assert.equal(code, 0);
  assert.deepEqual(specs.map(s => s.eventId), ['e1', 'e2', 'e3']);
  assert.equal(new Set(specs.map(s => s.runId)).size, 3);
  assert(specs.every(s => s.session.mode === 'persistent'));
  const runs = readRuns(f.home).filter(r => r.outcome !== 'skipped').reverse();
  assert.equal(runs.length, 3);
  assert(runs[1].startedAt - runs[0].startedAt >= 1000);
  assert.deepEqual(listEvents(f.home, 'monitor'), []);
});

test('concurrent callers wait and never overlap, and an id retry cannot overwrite queued data', async t => {
  const f = fixture(t);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const executed = [];
  let active = 0;
  const deps = { ...f.deps, spawnRun: async ({ spec }) => {
    assert.equal(++active, 1);
    executed.push(spec.prompt);
    if (executed.length === 1) { entered.resolve(); await release.promise; }
    --active;
    return { code: 0, result: { outcome: 'completed', exitCode: 0 } };
  } };
  const first = runTriggerCli(['fire', 'monitor', '--event-id', 'e1', '--text', 'first'], deps);
  await entered.promise;
  const second = runTriggerCli(['fire', 'monitor', '--event-id', 'e2', '--text', 'second'], deps);
  await new Promise(resolve => setImmediate(resolve));
  emitEvent(f.home, 'monitor', { text: 'replacement' }, { eventId: 'e2' });
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  assert.deepEqual(executed, ['Review first', 'Review second']);
});

test('daily cap retains queued events and a duplicate cannot block the next event', async t => {
  const f = fixture(t, { limits: { minIntervalSeconds: 1, maxRunsPerDay: 1 } });
  const deps = { ...f.deps, spawnRun: async () => ({ code: 0, result: { outcome: 'completed', exitCode: 0 } }) };
  await runTriggerCli(['fire', 'monitor', '--event-id', 'e1', '--text', 'first'], deps);
  emitEvent(f.home, 'monitor', {}, { eventId: 'e1', now: 1 });
  emitEvent(f.home, 'monitor', {}, { eventId: 'e2', now: 2 });
  assert.equal(await runTriggerCli(['run', 'monitor'], deps), 0);
  assert.deepEqual(listEvents(f.home, 'monitor').map(e => e.eventId), ['e2']);
  assert.equal(readRuns(f.home)[0].reason, 'over_daily_limit');
});

test('a run that cannot spawn retains its event and releases the kernel lease', async t => {
  const f = fixture(t);
  assert.equal(await runTriggerCli(['fire', 'monitor', '--event-id', 'e1', '--text', 'first'], { ...f.deps, spawnRun: async () => { throw Error('no host'); } }), 1);
  assert.equal(listEvents(f.home, 'monitor').length, 1);
  const lease = await acquireTriggerLease(f.home, 'monitor');
  assert(lease);
  lease.release();
});

test('the Host inherits the lease and retains it after the parent releases its copy', async t => {
  const f = fixture(t);
  const lease = await acquireTriggerLease(f.home, 'monitor');
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe', lease.fd] });
  t.after(() => { lease.release(); child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  lease.release();
  assert.equal(await acquireTriggerLease(f.home, 'monitor'), undefined);
  child.kill('SIGKILL');
  await exited;
  const successor = await acquireTriggerLease(f.home, 'monitor');
  assert(successor);
  successor.release();
});

test('scheduled firings queue behind pending events and preserve their own identities', async t => {
  const f = fixture(t, { source: { kind: 'interval', seconds: 60 } });
  emitEvent(f.home, 'monitor', { text: 'earlier' }, { eventId: 'earlier', now: 1 });
  const specs = [];
  assert.equal(await runTriggerCli(['run', 'monitor'], { ...f.deps, spawnRun: async ({ spec }) => {
    specs.push(spec);
    return { code: 0, result: { outcome: 'completed', exitCode: 0 } };
  } }), 0);
  assert.equal(specs.length, 2);
  assert.equal(specs[0].eventId, 'earlier');
  assert.match(specs[1].eventId, /^interval:/);
});

test('disabling a persistent trigger during a run stops the drain without discarding events', async t => {
  const f = fixture(t);
  const specs = [];
  emitEvent(f.home, 'monitor', {}, { eventId: 'e1', now: 1 });
  emitEvent(f.home, 'monitor', {}, { eventId: 'e2', now: 2 });
  await runTriggerCli(['run', 'monitor'], { ...f.deps, spawnRun: async ({ spec }) => {
    specs.push(spec);
    writeFileSync(join(f.home, 'triggers', 'monitor.json'), JSON.stringify({ ...f.raw, enabled: false }));
    return { code: 0, result: { outcome: 'completed', exitCode: 0 } };
  } });
  assert.equal(specs.length, 1);
  assert.deepEqual(listEvents(f.home, 'monitor').map(e => e.eventId), ['e2']);
});

test('each resumed run replaces the old goal and caps only its own spend', async t => {
  const f = fixture(t);
  const optionsPath = join(f.home, 'run.json');
  writeRunSpec(optionsPath, { triggerId: 'monitor', runId: 'r2', session: { mode: 'persistent' }, workspace: f.home, prompt: 'second event', goal: { objective: 'new objective', maxRounds: 3 }, limits: { maxCostUsd: 0.5 } });
  const session = { id: 's1', header: { cwd: f.home } };
  let goal = { id: 'old', revision: 5, phase: 'blocked', roundsStarted: 20 };
  let cost = 100;
  const calls = [], listeners = new Map(), done = Promise.withResolvers();
  const agent = { id: 's1', session, followup: m => calls.push(['prompt', m]) };
  const ctx = {
    get: key => key === 'loader' ? { await: async () => {} } : code => done.resolve(code),
    agents: { create: async () => ({ agent }) },
    sessions: { flush: async () => calls.push(['flush']) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    goals: {
      get: () => goal,
      clear: (_agent, ref) => { calls.push(['clear', ref]); goal = undefined; },
      create: (_agent, request) => { assert.equal(goal, undefined); goal = { id: 'new', revision: 1, phase: 'active', roundsStarted: 1, ...request }; },
    },
    on: (name, callback) => listeners.set(name, callback),
  };
  await runTriggerHost(ctx, { optionsPath, home: f.home, spend: () => ({ cost }) });
  assert.deepEqual(calls.find(c => c[0] === 'clear'), ['clear', { id: 'old', revision: 5 }]);
  cost += 0.25;
  listeners.get('session/event')(session, { type: 'turn/end' });
  assert.equal(readRunResult(`${optionsPath}.result.json`), undefined, 'old session spend does not trip this run cap');
  cost += 0.5;
  listeners.get('session/event')(session, { type: 'turn/end' });
  assert.equal(await done.promise, 2);
  assert.deepEqual(readRunResult(`${optionsPath}.result.json`), { outcome: 'overrun', reason: 'cost_cap', exitCode: 2, cost: 0.75, rounds: 1, sessionId: 's1' });
});
