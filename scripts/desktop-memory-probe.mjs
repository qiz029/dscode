import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { MemoryStore } from '../plugins/memory/store.mjs';
import * as memory from '../plugins/memory/desktop-host.mjs';

export const inject = ['llm', 'sessionPersistence', 'agents', 'agentPresets', 'commands', 'tools', 'systemPrompt'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    console.error(error.stack);
    if (process.env.DSCODE_MEMORY_ELECTRON) process.send({ type: 'dscode-memory-failed' });
    else ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_MEMORY_PHASE, calls = [], handles = [];
  const store = new MemoryStore(process.env.DSCODE_MEMORY_HOME);
  let hold = false, aborted = false;
  const entered = Promise.withResolvers();
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: {
      efforts: ['low', 'high', 'ultra'].map(id => ({ id, name: id })), defaultEffort: 'high',
    }, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      calls.push(options);
      assert.equal(options.tools, undefined);
      if (hold) {
        entered.resolve();
        await new Promise((resolve, reject) => {
          const abort = () => { aborted = true; reject(options.signal.reason); };
          if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
      const input = JSON.parse(options.messages.at(-1).content[0].text);
      if (input.messages) assert.equal(input.session, 'desktop-memory-history');
      const value = input.messages
        ? { raw_memory: 'The fixture project uses pnpm.', rollout_summary: 'The user explicitly requested pnpm.', evidence: [0] }
        : { summary: 'Fixture project: use pnpm.', entries: [{ title: 'Package manager', body: 'Use pnpm.', sources: ['desktop-memory-history'] }], skills: [] };
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-memory-fixture'], new Adapter());
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) { assert(Date.now() < deadline, 'Memory probe timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
  };
  const make = async (id, preset, parentAgent) => {
    const method = id === 'desktop-memory-current' && phase !== 'generate' ? 'resume' : 'create';
    const handle = await ctx.agents[method]({ sessionId: id, resumeSessionId: id, parentAgent,
      meta: { cwd: process.cwd(), agentPreset: preset, ...(parentAgent ? { origin: 'subagent', parentSession: parentAgent.id } : {}) },
      agentOptions: { provider: 'desktop-memory-fixture', model: 'fixture', reasoningEffort: 'ultra' },
      setup: async scope => { await ctx.agentPresets.mount(scope, preset); },
    });
    handles.push(handle); return handle.agent;
  };
  const command = async (agent, input) => (await ctx.commands.execute(agent, `/memories ${input}`, [], AbortSignal.timeout(10000))).result;
  const summary = async agent => (await ctx.systemPrompt.assemble({ scope: agent })).sections.find(s => s.name === 'dscode-memory')?.text ?? '';
  const search = async agent => (await ctx.tools.execute({ name: 'memory_search', arguments: { query: 'pnpm' }, agent,
    callId: randomUUID(), signal: AbortSignal.timeout(10000) }));
  const hasTool = agent => ctx.tools.schemas(agent).some(tool => tool.name === 'memory_search');
  try {
    const agent = await make('desktop-memory-current', 'dscode');
    const standard = await make(`desktop-memory-standard-${phase}`, 'standard');
    const child = await make(`desktop-memory-child-${phase}`, 'dscode', agent);
    assert(hasTool(agent)); assert(hasTool(child)); assert(!hasTool(standard));
    assert.equal(await summary(standard), '');
    assert.equal((await command(standard, 'global-off')).kind, 'error');
    if (phase === 'generate') {
      const time = Date.now() - 86400000;
      for (const [id, preset, origin] of [['desktop-memory-history', 'dscode'], ['excluded-standard', 'standard'], ['excluded-child', 'dscode', 'subagent']]) {
        const history = await ctx.sessionPersistence.create({ version: 4, id, createdAt: time, cwd: process.cwd(), isSeeded: false, agentPreset: preset, ...(origin ? { origin } : {}) });
        await history.append([{ type: 'user/message', seq: 0, time, surfaceOp: 'append', data: createUserMessage({
          content: [{ type: 'text', text: 'Use pnpm for this project.' }], source: { kind: 'user' },
        }) }]);
        await history.flush(); await history.close();
      }
      assert.equal((await command(agent, 'run')).kind, 'success');
      await wait(() => store.get('snapshot')?.summary.includes('pnpm'));
      assert.deepEqual(calls.map(call => call.reasoningEffort), ['low', 'high']);
      assert.match(readFileSync(join(process.env.DSCODE_MEMORY_HOME, 'memory_summary.md'), 'utf8'), /pnpm/);
      const result = await search(agent); assert(!result.isError, JSON.stringify(result));
      assert.deepEqual(result.value.evidence[0].sequences, [0]);
      assert.equal(result.value.evidence[0].session, 'desktop-memory-history');
      assert.match(await summary(child), /pnpm/);
      await command(agent, 'off');
      assert.equal(await summary(agent), ''); assert.equal(await summary(child), '');
      assert.equal((await search(child)).value.disabled, true);
      await command(agent, 'global-off');
    } else if (phase === 'resume') {
      assert.equal(store.get('generate'), false); assert.equal(store.enabled(agent.id), false);
      assert.equal(await summary(agent), '');
      await command(agent, 'run'); assert.equal(calls.length, 0);
      await command(agent, 'global-on'); assert.equal(await summary(agent), '');
      await command(agent, 'on'); assert.match(await summary(agent), /pnpm/); assert.match(await summary(child), /pnpm/);
      assert.equal((await search(agent)).value.evidence[0].session, 'desktop-memory-history');
    } else {
      assert.match(await summary(agent), /pnpm/);
      hold = true;
      await command(agent, 'note Use the existing project package manager.');
      await Promise.race([entered.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('Memory stream did not start')), 15000); timer.unref(); })]);
      const entry = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-memory');
      assert(entry?.fiber); await entry.fiber.dispose();
      assert(aborted); assert(!hasTool(agent)); assert(!hasTool(child)); assert(!hasTool(standard));
      assert.equal(await summary(agent), ''); assert.equal(await summary(child), '');
      assert((await search(agent)).isError);
      assert.equal(store.db.prepare('SELECT count(*) AS count FROM leases').get().count, 0);
      // Reload into already-open agents; the shared store and persisted switches survive.
      const remounted = ctx.plugin(memory);
      await remounted;
      assert(hasTool(agent)); assert(hasTool(child)); assert(!hasTool(standard));
      assert.match(await summary(agent), /pnpm/);
      await remounted.dispose();
      assert(!hasTool(agent)); assert(!hasTool(child));
    }
    console.log('DESKTOP_MEMORY_PASSED ' + JSON.stringify({ phase, schemaIsolation: true, standardCommandDenied: true,
      ...(phase === 'generate' ? { jsonlGeneration: true, effortIsolation: true, sourceEvidence: true, parentOptOut: true }
        : phase === 'resume' ? { persistedSwitches: true, persistedEvidence: true } : { abortOnUnload: true, leasesReleased: true, existingAgentReload: true }) }));
  } finally { for (const handle of handles.reverse()) await handle.dispose(); store.close(); }
  if (process.env.DSCODE_MEMORY_ELECTRON) process.send({ type: 'dscode-memory-shutdown' });
  else ctx.get('appExit')(0);
}
