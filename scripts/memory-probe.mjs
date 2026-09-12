// Loaded only by verify-memory.mjs in an isolated profile. Uses the real
// provider, session persistence, prompt and tool registries, with local inference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
export const name = 'dscode-memory-probe';
export const inject = ['llm', 'sessionPersistence', 'agents', 'agentPresets', 'commands', 'tools', 'systemPrompt'];
export function apply(ctx) {
  void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); });
}
async function probe(ctx) {
  await ctx.get('loader').await();
  const calls = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: ['low', 'high', 'max', 'ultra'].map(id => ({ id, name: id })), defaultEffort: 'high' }, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      calls.push(options);
      assert.equal(options.tools, undefined);
      const input = JSON.parse(options.messages.at(-1).content[0].text);
      const value = input.messages
        ? { raw_memory: 'The fixture project uses pnpm.', rollout_summary: 'The user explicitly requested pnpm.', evidence: [0] }
        : { summary: 'Fixture project: use pnpm.', entries: [{ title: 'Package manager', body: 'Use pnpm in the fixture project.', sources: ['memory-probe-history'] }], skills: [] };
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['memory-fixture'], new Adapter());
  const time = Date.now() - 86400000;
  const stored = await ctx.sessionPersistence.create({ version: 3, id: 'memory-probe-history', createdAt: time, cwd: process.cwd(), isSeeded: false, agentPreset: 'dscode' });
  await stored.append([{ type: 'user/message', seq: 0, time, surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: 'Use pnpm for this project.' }], source: { kind: 'human' } }) }]);
  await stored.flush(); await stored.close();
  const handle = await ctx.agents.create({ sessionId: 'memory-probe-current', meta: { cwd: process.cwd(), agentPreset: 'dscode' },
    agentOptions: { provider: 'memory-fixture', model: 'fixture', reasoningEffort: 'ultra' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'dscode'); } });
  const agent = handle.agent;
  const execution = await ctx.commands.execute(agent, '/memories run', [], new AbortController().signal);
  assert.equal(execution.result.kind, 'success');
  let summary = '';
  for (let i = 0; i < 200 && !summary.includes('pnpm'); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    try { summary = readFileSync(join(process.env.DSCODE_MEMORY_HOME, 'memory_summary.md'), 'utf8'); } catch {}
  }
  if (!summary.includes('pnpm')) {
    console.error('Memory fixture status:', (await ctx.commands.execute(agent, '/memories status', [], new AbortController().signal)).result);
    const log = await ctx.sessionPersistence.open('memory-probe-history', 'read');
    console.error('Fixture history:', await ctx.sessionPersistence.list(), await log.read()); await log.close();
  }
  assert.match(summary, /pnpm/);
  assert.deepEqual(calls.map(c => c.reasoningEffort), ['low', 'high']);
  assert(ctx.tools.schemas(agent).some(t => t.name === 'memory_search'));
  const assembly = await ctx.systemPrompt.assemble({ scope: agent });
  assert(assembly.sections.some(s => s.name === 'dscode-memory' && s.text.includes('pnpm')));
  const off = await ctx.commands.execute(agent, '/memories off', [], new AbortController().signal);
  assert.equal(off.result.kind, 'success');
  const hidden = await ctx.systemPrompt.assemble({ scope: agent });
  assert(!hidden.sections.some(s => s.name === 'dscode-memory' && s.text.includes('pnpm')));
  console.log('MEMORY_PROBE_PASSED: real JSONL history -> independent low/high model calls -> global files -> scoped prompt -> session opt-out');
  ctx.get('appExit')(0);
}
