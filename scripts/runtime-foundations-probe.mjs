// Investigation fixture: real Harness, local model, no production feature changes.
import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { mountDscodePreset } from '../packages/tui/src/dscode/preset.ts';
import { resolvePreset } from '../packages/tui/src/presets.ts';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
export const name = 'runtime-foundations-probe';
export const inject = ['agents', 'agentPresets', 'llm', 'sessions', 'sessionPersistence'];
export function apply(ctx) { void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
const ID = process.env.DSCODE_FOUNDATIONS_MODE === 'boundaries' ? 'runtime-boundaries-session' : 'runtime-foundations-session';
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: name } });

async function probe(ctx) {
  await ctx.get('loader').await();
  const mode = process.env.DSCODE_FOUNDATIONS_MODE;
  if (mode === 'preset') {
    class PresetAdapter extends LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
      async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'LEGACY_PRESET_HISTORY' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['preset-fixture'], new PresetAdapter());
    const sessionId = 'legacy-preset-fixture';
    const old = await ctx.agents.create({ sessionId, meta: { cwd: process.cwd(), agentPreset: 'minimal' }, agentOptions: { provider: 'preset-fixture', model: 'fixture' }, setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, 'minimal');
      installModelSelection(agentCtx, { get current() { return agent.options; }, assembled: undefined });
    } });
    old.agent.followup(message('LEGACY_USER_INPUT')); await old.agent.whenIdle();
    assert(JSON.stringify(old.agent.session.snapshotEvents()).includes('LEGACY_PRESET_HISTORY'));
    await ctx.sessions.flush(old.agent.session); await old.dispose();
    const setup = async (agentCtx, agent) => { await mountDscodePreset(ctx.agentPresets, agentCtx, agent.session); };
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, setup });
      assert.equal(resolvePreset(resumed.agent.session), 'dscode');
      assert(JSON.stringify(resumed.agent.session.snapshotEvents()).includes('LEGACY_PRESET_HISTORY'));
      assert.equal(resumed.agent.session.snapshotEvents().filter(e => e.type === 'agent-preset/selected' && e.data.agentPreset === 'dscode').length, 1);
      const tools = ctx.get('tools').schemas(resumed.agent);
      assert(tools.some(t => t.name === 'trigger_manage'), 'DSCODE tools must be mounted on the legacy session');
      await ctx.sessions.flush(resumed.agent.session); await resumed.dispose();
    }
    console.log('FOUNDATIONS_PRESET_LOCK: legacy history retained; DSCODE mounted; migration persisted once across resumes');
    ctx.get('appExit')(0); return;
  }
  if (mode === 'contender') {
    await assert.rejects(ctx.agents.resume({ resumeSessionId: ID }), error => {
      assert.match(error.message, /already owned by an active write handle/); return true;
    });
    assert.equal(ctx.agents.get(ID), undefined, 'Rejected resume must not publish an Agent');
    const read = await ctx.sessionPersistence.open(ID, 'read');
    await read.read(0); await read.close();
    console.log('FOUNDATIONS_CONTENDER: resume rejected; read succeeds while writer holds lock');
    ctx.get('appExit')(0); return;
  }
  if (mode === 'holder' || mode === 'successor') {
    const handle = mode === 'holder'
      ? await ctx.agents.create({ sessionId: ID, meta: { cwd: process.cwd(), agentPreset: 'dscode' } })
      : await ctx.agents.resume({ resumeSessionId: ID });
    assert.equal(handle.agent.status, 'idle');
    console.log('FOUNDATIONS_OWNER_READY');
    if (mode === 'successor') { await handle.dispose(); console.log('FOUNDATIONS_RELEASED'); ctx.get('appExit')(0); }
    return;
  }

  assert.equal(mode, 'boundaries');
  const entered = Promise.withResolvers(), releasePreStep = Promise.withResolvers();
  const modelEntered = Promise.withResolvers(), releaseModel = Promise.withResolvers();
  const requests = [], positions = [], mailbox = [message('EARLY_DEFER_NOTE')], batches = new Map();
  let noteAgent;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      if (!options.purpose) {
        requests.push(JSON.stringify(options.messages));
        if (requests.length === 1) { modelEntered.resolve(); await releaseModel.promise; }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture response' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['foundations-fixture'], new Adapter());
  // Synchronous, read-only cutoff at turn/start; asynchronous work belongs in pre-step.
  ctx.on('session/event', (session, event) => {
    if (session.id === noteAgent?.id && event.type === 'turn/start') batches.set(event.data.turn, [...mailbox]);
  });
  ctx.on('agent/pre-step', async ({ agent, turn, step }, next) => {
    if (agent !== noteAgent) return next();
    positions.push({ turn, step, nextTurn: agent.inbox.nextTurn.length });
    if (turn === 1 && step === 1) { entered.resolve(); await releasePreStep.promise; }
    const decision = await next();
    return decision.kind === 'enter' && step === 1
      ? { ...decision, messages: [...decision.messages, ...batches.get(turn)] }
      : decision;
  });
  const setup = async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, 'dscode');
    installModelSelection(agentCtx, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  };
  const handle = await ctx.agents.create({ sessionId: ID, meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: 'foundations-fixture', model: 'fixture' }, setup });
  noteAgent = handle.agent;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 0); assert.equal(noteAgent.status, 'idle');
  noteAgent.followup(message('FIRST_NATURAL_TURN'));
  await entered.promise;
  assert.equal(requests.length, 0, 'pre-step Promise must block model dispatch');
  assert.equal(positions[0].nextTurn, 0, 'Native inbox is already claimed before pre-step');
  mailbox.push(message('LATE_DEFER_NOTE'));
  releasePreStep.resolve(); await modelEntered.promise;
  assert(requests[0].includes('EARLY_DEFER_NOTE'));
  assert(!requests[0].includes('LATE_DEFER_NOTE'));
  // inject is a negative control: no explicit wake, but a busy driver consumes it this turn.
  noteAgent.inject(message('INJECT_IS_NEXT_STEP'));
  releaseModel.resolve(); await noteAgent.whenIdle();
  assert.equal(requests.length, 2);
  assert(requests[1].includes('INJECT_IS_NEXT_STEP'));
  assert(!requests[1].includes('LATE_DEFER_NOTE'));
  assert.deepEqual(positions, [{ turn: 1, step: 1, nextTurn: 0 }, { turn: 1, step: 2, nextTurn: 0 }]);
  // A real mailbox would mark consumed only after the persisted user/message receipt.
  await ctx.sessions.flush(noteAgent.session);
  const admitted = noteAgent.session.snapshotEvents().filter(e => e.type === 'user/message').map(e => e.data.id);
  for (let i = mailbox.length - 1; i >= 0; i--) if (admitted.includes(mailbox[i].id)) mailbox.splice(i, 1);
  assert.equal(mailbox.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2); assert.equal(noteAgent.status, 'idle');
  noteAgent.followup(message('SECOND_NATURAL_TURN')); await noteAgent.whenIdle();
  assert.equal(requests.length, 3); assert(requests[2].includes('LATE_DEFER_NOTE'));
  await ctx.sessions.flush(noteAgent.session);
  const read = await ctx.sessionPersistence.open(ID, 'read');
  const persisted = (await read.read(0)).events;
  assert.equal(persisted.filter(e => e.type === 'user/message' && e.data.id === mailbox[0].id).length, 1);
  await read.close(); await handle.dispose();
  console.log('FOUNDATIONS_BOUNDARIES: awaited pre-step; turn-start cutoff; late note waits; inject enters current turn; note persisted');
  ctx.get('appExit')(0);
}
