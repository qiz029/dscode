import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTriggerSession } from '../plugins/triggers/session-run.mjs';
import { mutationProblem } from '../plugins/triggers/tools.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-trigger-run-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const listeners = new Map(), agents = new Map(), goals = new Map();
  let next = 0, rejectSetup = false;
  const ctx = {
    get: () => undefined,
    agents: { get: id => agents.get(id), create: async ({ meta, setup }) => {
      const id = `run-${++next}`;
      const agent = { id, session: { id, header: meta }, status: 'idle', cancel() { this.cancelled = true; }, whenIdle: async () => {}, followup() { this.started = true; } };
      await setup({}, agent); agents.set(id, agent);
      return { agent, dispose: async () => { agents.delete(id); } };
    } },
    sessions: { flush: async () => {} },
    agentPresets: { mount: async () => { if (rejectSetup) throw Error('setup failed'); } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    permissionPresets: { resolve() {}, set() {}, current: () => 'workspace-write' },
    goals: { get: agent => goals.get(agent.id), clear: agent => goals.delete(agent.id), create: (agent, req) => goals.set(agent.id, { id: agent.id, revision: 1, phase: 'active', roundsStarted: 1, ...req }) },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      const list = listeners.get(name); list.add(fn); return () => list.delete(fn);
    },
  };
  const spec = { triggerId: 'fixture', runId: 'fixture-run', workspace: home, session: { mode: 'new' }, prompt: 'fixture', goal: { objective: 'Finish', maxRounds: 3 }, limits: {} };
  const start = (overrides = {}, signal) => startTriggerSession(ctx, { home, spec: { ...spec, ...overrides }, signal, spend: () => ({ cost: 0 }) });
  const emit = (name, ...args) => { for (const fn of [...listeners.get(name) ?? []]) fn(...args); };
  return { ctx, start, emit, listeners, agents, goals, failSetup: () => { rejectSetup = true; } };
}

test('owned trigger cancellation preserves other runs and interactive schedule authority', async t => {
  const f = fixture(t);
  const first = await f.start(), second = await f.start();
  const interactive = { session: { header: {} } };
  assert.match(mutationProblem(f.ctx, first.agent), /Unattended/);
  assert.equal(mutationProblem(f.ctx, interactive), undefined);
  const result = await first.cancel();
  assert.equal(result.exitCode, 130);
  assert(!f.agents.has(first.agent.id)); assert(f.agents.has(second.agent.id));
  assert.equal(second.agent.cancelled, undefined);
  assert.equal(mutationProblem(f.ctx, first.agent), undefined, 'Finished run releases its authority marker');
  f.goals.get(second.agent.id).phase = 'complete';
  f.emit('session/event', second.agent.session, { type: 'turn/end' });
  assert.equal((await second.done).exitCode, 0);
  assert.equal(f.agents.size, 0);
  for (const entries of f.listeners.values()) assert.equal(entries.size, 0);
});

test('trigger approvals include owned descendants and delegate unrelated interactive requests', async t => {
  const f = fixture(t), run = await f.start();
  t.after(() => run.cancel());
  const listener = [...f.listeners.get('approval/request')][0];
  const child = { id: 'child', session: { header: { parentSession: run.agent.id } } };
  const other = { id: 'other', session: { header: {} } };
  assert.equal(listener({ agent: run.agent }, () => 'accepted'), 'rejected');
  assert.equal(listener({ agent: child }, () => 'accepted'), 'rejected');
  assert.equal(listener({ agent: other }, () => 'accepted'), 'accepted');
  f.goals.get(run.agent.id).roundsStarted = 3;
  f.emit('session/event', run.agent.session, { type: 'turn/end' });
  assert.equal((await run.done).reason, 'approval_required');
});

test('an aborted trigger drains only its owner and pre-aborted setup creates no Agent', async t => {
  const f = fixture(t), controller = new AbortController();
  const run = await f.start({}, controller.signal);
  controller.abort();
  assert.equal((await run.done).reason, 'interrupted');
  assert.equal(f.agents.size, 0);
  await assert.rejects(f.start({}, controller.signal), /abort/i);
  assert.equal(f.agents.size, 0);
});

test('goal setup failures unwind owned sessions and leave no lifecycle listeners', async t => {
  const f = fixture(t);
  f.ctx.goals.create = () => { throw Error('goal store failed'); };
  await assert.rejects(f.start(), /goal store failed/);
  assert.equal(f.agents.size, 0);
  for (const entries of f.listeners.values()) assert.equal(entries.size, 0);
});
