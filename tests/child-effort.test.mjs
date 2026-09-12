import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { pathToFileURL } from 'node:url';
const fixture = createTestRuntime({ runtime: true });
const root = fixture.root;
after(fixture.close);

const { apply } = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js`));

for (const providerName of ['spawn', 'fork']) test(`${providerName}: effort-only schema, validation, inheritance and route isolation`, async () => {
  const registered = new Map(), starts = [], preflights = [];
  const provider = { name: providerName, capabilities: { agentOptions: true, depthLimit: true }, inheritsParentContext: providerName === 'fork', prepareContinuable() {} };
  const ctx = {
    sessionProjections: { register() {} }, on() {}, systemPrompt: { section() {}, getSectionOrder() { return 0; } },
    tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } },
    subagents: { getProvider: () => provider, async startContinuable({ request }) { starts.push(request); return { childId: 'child' }; } },
    get(name) { if (name === 'llm') return { async resolveCallConfig(config) { preflights.push(config); if (!['low', 'high', 'max', 'ultra'].includes(config.reasoningEffort)) throw Error('unsupported effort'); } }; }
  };
  apply(ctx, { provider: providerName, toolName: 'delegate', maxDepth: 1, backgroundMode: 'continuable', modelSelectionSettings: false });
  const tool = registered.get('delegate');
  assert(tool.parameters.properties.reasoning_effort);
  assert.equal(tool.parameters.properties.provider, undefined);
  assert.equal(tool.parameters.properties.model, undefined);
  const parent = { options: { provider: 'original', model: 'original', reasoningEffort: 'max' }, session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'flash', reasoningEffort: 'ultra' } }) } };
  const exec = { agent: parent, signal: new AbortController().signal };
  for (const effort of ['low', 'high', 'max']) {
    await tool.execute({ description: 'test', prompt: 'test', reasoning_effort: effort }, exec);
    assert.deepEqual(starts.at(-1).agentOptions, { reasoningEffort: effort });
    assert.deepEqual(preflights.at(-1), { provider: 'deepseek', model: 'flash', reasoningEffort: effort });
    assert.equal(parent.session.requestHeader().config.reasoningEffort, 'ultra');
  }
  await tool.execute({ description: 'inherit', prompt: 'test' }, exec);
  assert.equal(starts.at(-1).agentOptions, undefined);
  const count = starts.length;
  await assert.rejects(tool.execute({ description: 'test', prompt: 'test', reasoning_effort: 'bad' }, exec), /unsupported/);
  await assert.rejects(tool.execute({ description: 'test', prompt: 'test', provider: 'other', model: 'other', reasoning_effort: 'low' }, exec), /disabled|unexpected|additional|unknown/i);
  assert.equal(starts.length, count);
});
