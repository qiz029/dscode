import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { MemoryStore } from '../plugins/memory/store.mjs';
import { readMetrics } from '../plugins/session-metrics/store.mjs';

export const inject = ['llm', 'sessionPersistence', 'agents', 'agentPresets', 'commands'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    console.error(error.stack);
    if (process.env.DSCODE_MEMORY_ELECTRON) process.send({ type: 'dscode-memory-failed' });
    else ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const handles = new Set(), calls = [], store = new MemoryStore(process.env.DSCODE_MEMORY_HOME);
  let gate;
  const pause = () => { gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() }; return gate; };
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 },
      reasoning: { efforts: ['low', 'high'].map(id => ({ id, name: id })) } }; }
    async *stream(options) {
      let text = 'Attribution foreground ready.';
      if (!options.sessionId) {
        assert.equal(options.tools, undefined);
        calls.push({ model: options.model, effort: options.reasoningEffort });
        if (gate) { const current = gate; gate = undefined; current.entered.resolve(); await current.release.promise; }
        const input = JSON.parse(options.messages[0].content[0].text);
        text = JSON.stringify(input.messages
          ? { raw_memory: 'Use pnpm.', rollout_summary: 'The user requested pnpm.', evidence: [0] }
          : { summary: 'Use pnpm.', entries: [{ title: 'Package manager', body: 'Use pnpm.', sources: ['memory-attribution-history'] }], skills: [] });
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['memory-attribution-fixture'], new Adapter());
  const make = async id => {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd(), agentPreset: 'dscode' },
      agentOptions: { provider: 'memory-attribution-fixture', model: id },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, 'dscode');
        installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
      } });
    handles.add(handle); return handle;
  };
  const foreground = async agent => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Prepare attribution fixture.' }] }));
    await agent.whenIdle();
    assert(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === 'Attribution foreground ready.')));
  };
  const command = async (agent, input) => {
    const { result } = await ctx.commands.execute(agent, `/memories ${input}`, [], AbortSignal.timeout(10000));
    assert.equal(result.kind, 'success', JSON.stringify(result)); return result;
  };
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) { assert(Date.now() < deadline, 'Attribution fixture timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const idle = agent => wait(async () => (await command(agent, 'status')).text.includes('Worker: idle'));
  const memoryRows = id => {
    const ledger = readMetrics(process.env.DSH_HOME, id); assert(!ledger.corrupt);
    const starts = ledger.rows.filter(row => row.kind === 'start' && row.purpose === 'memory');
    for (const row of starts) {
      const end = ledger.rows.find(item => item.kind === 'end' && item.id === row.id);
      assert(end, 'Every memory charge must settle'); assert.equal(end.usage.outputTokens, 5);
    }
    return starts;
  };
  const releases = [];
  try {
    const time = Date.now() - 86400000;
    const history = await ctx.sessionPersistence.create({ version: 4, id: 'memory-attribution-history', createdAt: time, cwd: process.cwd(), isSeeded: false, agentPreset: 'dscode' });
    await history.append([{ type: 'user/message', seq: 0, time, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Use pnpm.' }] }) }]);
    await history.flush(); await history.close();
    const a = await make('memory-owner-a'), b = await make('memory-owner-b');
    const first = pause(); releases.push(first.release);
    await foreground(a.agent);
    await wait(() => calls.length === 1);
    await foreground(b.agent);
    first.release.resolve(); await idle(a.agent);
    assert.deepEqual(calls, [{ model: a.agent.id, effort: 'low' }, { model: a.agent.id, effort: 'high' }]);
    assert.equal(memoryRows(a.agent.id).length, 2, 'Both phases belong to their initiating session');
    assert.equal(memoryRows(b.agent.id).length, 0, 'The interleaved session must not inherit charges');

    await command(a.agent, 'note Keep pnpm.'); await idle(a.agent);
    assert.equal(memoryRows(a.agent.id).length, 3, 'Manual note belongs to its caller');
    assert.equal(memoryRows(b.agent.id).length, 0);
    const c = await make('memory-owner-manual');
    store.note('Prefer the existing package manager.');
    await command(c.agent, 'run'); await idle(c.agent);
    assert.equal(memoryRows(c.agent.id).length, 1, 'Manual run before a foreground request still has an owner');

    // New offline history forces extraction followed by consolidation, so the
    // second stage starts only after the original owner has been disposed.
    const laterHistory = await ctx.sessionPersistence.create({ version: 4, id: 'memory-attribution-later-history', createdAt: time, cwd: process.cwd(), isSeeded: false, agentPreset: 'dscode' });
    await laterHistory.append([{ type: 'user/message', seq: 0, time, surfaceOp: 'append', data: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep the lockfile.' }] }) }]);
    await laterHistory.flush(); await laterHistory.close();
    const closing = pause(); releases.push(closing.release);
    await command(c.agent, 'note Keep the lockfile.');
    await wait(() => calls.length === 5);
    await c.dispose(); handles.delete(c);
    const d = await make('memory-owner-later'); await foreground(d.agent);
    closing.release.resolve(); await idle(d.agent);
    assert.equal(memoryRows(c.agent.id).length, 3, 'Closing the owner must retain both its in-flight and subsequent stage charges');
    assert.equal(memoryRows(d.agent.id).length, 0);
    assert.equal(store.get('usage').calls, 6);
    console.log('DESKTOP_MEMORY_PASSED ' + JSON.stringify({ phase: 'attribution', realPersistedLedgers: true,
      interleavedSessionIsolation: true, fixedRouteAcrossStages: true, manualRunOwner: true, manualNoteOwner: true,
      ownerDisposalPreservesCharge: true, consolidationAfterOwnerDisposal: true, noSessionIdOnAuxiliaryRequests: true, settledMemoryCalls: 6 }));
  } finally {
    for (const release of releases) release.resolve();
    for (const handle of [...handles].reverse()) await handle.dispose();
    store.close();
  }
  if (process.env.DSCODE_MEMORY_ELECTRON) process.send({ type: 'dscode-memory-shutdown' });
  else ctx.get('appExit')(0);
}
