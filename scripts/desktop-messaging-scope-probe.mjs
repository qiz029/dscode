import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { discover, request } from '../plugins/session-bridge/client.mjs';

export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'sessionCommunication', 'sessionCards'];
export function apply(ctx) { void run(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function run(ctx) {
  await ctx.get('loader').await();
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DESKTOP_SCOPE_READY' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-scope-fixture'], new Adapter());
  const handles = [];
  const make = async (id, preset, parentAgent) => {
    const handle = await ctx.agents.create({ sessionId: id, parentAgent,
      meta: { cwd: process.cwd(), agentPreset: preset, ...(parentAgent ? { origin: 'subagent', parentSession: parentAgent.session.id } : {}) },
      agentOptions: { provider: 'desktop-scope-fixture', model: 'fixture' },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, preset);
        installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
      },
    });
    handles.push(handle); return handle.agent;
  };
  try {
    const dscode = await make('desktop-scope-dscode', 'dscode');
    const standard = await make('desktop-scope-standard', 'standard');
    for (const agent of [dscode, standard]) agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare the local scope fixture.' }] }));
    await Promise.all([dscode.whenIdle(), standard.whenIdle()]);
    assert(standard.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === 'DESKTOP_SCOPE_READY')));
    const child = await make('desktop-scope-child', 'dscode', dscode);
    const communication = ctx.sessionCommunication;
    await communication.state(child).ready;
    const parentContexts = communication.store.context(dscode.id), childContexts = communication.store.context(child.id);
    assert(parentContexts.length > 0);
    assert.deepEqual(childContexts.map(row => row.chainId), parentContexts.map(row => row.chainId));
    assert(childContexts.every(row => row.path.at(-1) === child.id));
    assert.throws(() => communication.state(standard), error => error.code === 'target_unavailable');
    assert.equal(ctx.sessionCards.get(standard.session), null);
    assert.equal(ctx.sessionCards.get(child.session), null);
    const listed = await discover(process.env.DSH_HOME);
    assert.deepEqual(listed.map(row => row.id), [dscode.id]);
    await assert.rejects(request(listed[0].socket, { method: 'read', sessionId: standard.id }), /Session is not active/);
    await assert.rejects(request(listed[0].socket, { method: 'read', sessionId: child.id }), /Session is not active/);
    const denied = await ctx.tools.execute({ name: 'list_sessions', arguments: {}, agent: standard, callId: randomUUID(), signal: AbortSignal.timeout(10000) });
    assert.equal(denied.value.code, 'target_unavailable');
  } finally { for (const handle of handles.reverse()) await handle.dispose(); }
  assert.deepEqual(await discover(process.env.DSH_HOME), []);
  assert.equal(ctx.sessionCommunication.states.size, 0);
  console.log('SESSION_SCOPE_PROBE_PASSED: native Standard stays usable and excluded; DSCODE children inherit task budgets without appearing as root targets; disposal withdraws owners');
  ctx.get('appExit')(0);
}
