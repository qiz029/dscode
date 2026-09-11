import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchDeepSeek, patchBash, patchPersistent, patchRuntime } from '../scripts/patch-runtime.mjs';
import { root } from '../scripts/harness.mjs';
import { apply } from '../plugins/dscode/index.mjs';

patchRuntime(root);
const { DeepSeekAdapter, resolveAdapterOptions } = await import('@deepseek-ai/dsh-llm-deepseek');
test('ultra uses native max on the actual wire and adds policy only to agent calls', async () => {
  const original = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, request) => {
    payloads.push(JSON.parse(request.body));
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({ models: [{ id: 'deepseek-fixture' }] }), resolveApiKey: async () => 'fixture-not-a-key', resolveUserId: () => 'fixture', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }), resolveFiles: () => ({}) });
    const meta = await adapter.resolveModel('deepseek-official', 'deepseek-fixture');
    assert(meta.reasoning.efforts.some(e => e.id === 'ultra'));
    for (const [effort, purpose] of [['ultra', undefined], ['max', undefined], ['ultra', 'compaction'], ['off', undefined]]) {
      const options = { provider: 'deepseek-official', model: 'deepseek-fixture', reasoningEffort: effort, messages: [{ role: 'system', content: [{ type: 'text', text: 'Original instructions.' }] }, { role: 'user', content: [{ type: 'text', text: 'Do work.' }] }], tools: [{ name: 'subagent', description: 'delegate', parameters: { type: 'object', properties: {} } }], ...(purpose ? { purpose } : {}) };
      const before = JSON.stringify(options);
      for await (const _chunk of adapter.stream(options)) { }
      assert.equal(JSON.stringify(options), before, 'Adapter must not mutate logged input');
    }
    assert.equal(payloads[0].reasoning_effort, 'max');
    assert.equal(payloads[0].thinking.type, 'enabled');
    assert(JSON.stringify(payloads[0].messages).includes('DSCODE ULTRA'));
    assert(!JSON.stringify(payloads[1].messages).includes('DSCODE ULTRA'));
    assert(!JSON.stringify(payloads[2].messages).includes('DSCODE ULTRA'));
    assert.equal(payloads[3].thinking.type, 'disabled');
    assert.equal(payloads[3].reasoning_effort, undefined);
  } finally { globalThis.fetch = original; }
});
test('pinned runtime patches are idempotent and reject unknown upstream code', () => {
  for (const [name, patch] of [['dsh-llm-deepseek', patchDeepSeek], ['dsh-tool-bash', patchBash], ['dsh-tool-bash-persistent', patchPersistent]]) {
    const text = readFileSync(`${root}/node_modules/@deepseek-ai/${name}/lib/index.js`, 'utf8');
    assert.equal(patch(text), text);
    assert.throws(() => patch('unknown upstream'));
  }
});
test('ultra reserves concurrent admissions and frees slots after failed launches', async () => {
  let execute;
  const owner = { session: { id: 'root', header: {}, requestHeader: () => ({ config: { reasoningEffort: 'ultra' } }) }, options: {} };
  const children = Array.from({ length: 2 }, (_, i) => ({ status: 'running', session: { id: `child${i}`, header: { origin: 'subagent', parentSession: 'root' } } }));
  apply({ systemPrompt: { section() {} }, on: (event, cb) => { if (event === 'tools/execute') execute = cb; }, commands: { register() {} }, agents: { list: () => children, get: () => undefined } });
  let finish;
  const pending = execute({ name: 'subagent', arguments: {}, agent: owner }, () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(execute({ name: 'subagent_fork', arguments: {}, agent: owner }, () => {}), /limit/);
  finish('done'); await pending;
  await assert.rejects(execute({ name: 'subagent', arguments: {}, agent: owner }, () => Promise.reject(new Error('failed start'))), /failed start/);
  assert.equal(await execute({ name: 'subagent', arguments: {}, agent: owner }, () => 'next'), 'next');
  children.push({ status: 'running', session: { header: { origin: 'subagent', parentSession: 'root' } } });
  await assert.rejects(execute({ name: 'send_message', arguments: { agent_id: 'cold-child' }, agent: owner }, () => 'wake'), /limit/);
});
