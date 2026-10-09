import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { startTriggerSession } from '../plugins/triggers/session-run.mjs';
import { mutationProblem } from '../plugins/triggers/unattended.mjs';

export const inject = ['agents', 'sessions', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'llm', 'goals'];
export function apply(ctx) { void run(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function run(ctx) {
  await ctx.get('loader').await();
  const home = process.env.DSH_HOME, reload = process.env.DSCODE_TRIGGER_RELOAD === '1';
  const calls = new Map(), requests = [], stalls = new Map();
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const agent = ctx.agents.currentInitiator();
      if (options.model === 'stall') {
        stalls.set(agent.id, true);
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) { reject(options.signal.reason); return; }
          options.signal.addEventListener('abort', () => { stalls.delete(agent.id); reject(options.signal.reason); }, { once: true });
        });
      }
      const goal = agent && ctx.goals.get(agent);
      if (goal && goal.phase === 'active') {
        const count = (calls.get(goal.id) ?? 0) + 1; calls.set(goal.id, count);
        requests.push({ sessionId: agent.id, goalId: goal.id, messages: options.messages });
        if (count >= 2) ctx.goals.complete(agent, { id: goal.id, revision: goal.revision });
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DESKTOP_TRIGGER_SESSION_OK' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-trigger-fixture'], new Adapter());
  const prepare = (scope, agent) => installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  const interactive = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd(), agentPreset: 'dscode' },
    agentOptions: { provider: 'desktop-trigger-fixture', model: 'interactive' },
    setup: async (scope, agent) => { await ctx.agentPresets.mount(scope, 'dscode'); prepare(scope, agent); },
  });
  ctx.permissionPresets.set(interactive.agent.session, 'workspace-write');
  const spec = (id, mode = 'new', model = 'fixture', seconds = 15) => ({ triggerId: id, runId: randomUUID(),
    workspace: process.cwd(), preset: 'dscode', permission: 'workspace-write', session: { mode },
    model: `desktop-trigger-fixture/${model}`, prompt: reload ? 'SECOND_HOST_MARKER' : 'FIRST_HOST_MARKER',
    goal: { objective: 'Finish the fixture in two turns', maxRounds: 4 }, limits: { timeoutSeconds: seconds },
  });
  const start = (definition, signal) => startTriggerSession(ctx, { spec: definition, home, prepare, signal, spend: () => ({ cost: 0 }) });
  try {
    const persistent = await start(spec('persistent-desktop', 'persistent'));
    const result = await persistent.done;
    assert.equal(result.exitCode, 0); assert.equal(calls.get(requests.find(row => row.sessionId === result.sessionId).goalId), 2);
    assert.equal(ctx.agents.get(result.sessionId), undefined);
    const history = JSON.stringify(requests.find(row => row.sessionId === result.sessionId).messages);
    assert(history.includes('FIRST_HOST_MARKER'), 'Persisted first input missing');
    if (reload) assert(history.includes('SECOND_HOST_MARKER'));

    const fresh1 = await start(spec('new-desktop'));
    assert.equal((await fresh1.done).exitCode, 0);
    const fresh2 = await start(spec('new-desktop'));
    assert.notEqual(fresh1.agent.id, fresh2.agent.id);
    assert.equal((await fresh2.done).exitCode, 0);

    const stalled = await start(spec('timeout-desktop', 'new', 'stall', 0.5));
    assert.match(mutationProblem(ctx, stalled.agent), /Unattended/);
    assert.equal(mutationProblem(ctx, interactive.agent), undefined, 'Interactive scheduling was disabled by another run');
    const simultaneous = await start(spec('parallel-desktop'));
    assert.equal((await simultaneous.done).exitCode, 0);
    const timeout = await stalled.done;
    assert.equal(timeout.exitCode, 124); assert.equal(timeout.reason, 'timeout');
    assert.equal(ctx.agents.get(stalled.agent.id), undefined);
    assert.equal(stalls.size, 0, 'Timeout left model execution running');

    const controller = new AbortController();
    const cancelled = await start(spec('cancel-desktop', 'new', 'stall'), controller.signal);
    controller.abort();
    assert.equal((await cancelled.done).exitCode, 130);
    assert.equal(ctx.agents.get(cancelled.agent.id), undefined);

    interactive.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'The shared Host must remain usable.' }] }));
    await interactive.agent.whenIdle();
    assert(interactive.agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === 'DESKTOP_TRIGGER_SESSION_OK')));
    assert.equal(ctx.agents.roots().length, 1, 'Trigger run leaked an owned Agent');
    console.log('DESKTOP_TRIGGER_SESSION_PASSED ' + JSON.stringify({ reload, persistentSession: result.sessionId, twoTurnGoals: true, freshIsolation: true,
      concurrentTimeoutIsolation: true, cancellationDrained: true, interactiveSchedulingPreserved: true, sharedHostAlive: true, liveModelInference: false }));
  } finally { await interactive.dispose(); }
  ctx.get('appExit')(0);
}
