import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { patchDeepSeek, patchBash, patchPersistent, patchSubagent, patchSubagentCore, patchSubagentDriver, patchTerminalBash } from '../scripts/patch-runtime.mjs';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { pathToFileURL } from 'node:url';
const fixture = createTestRuntime({ runtime: true });
const root = fixture.root;
after(fixture.close);
import { apply } from '../plugins/dscode/index.mjs';


const { DeepSeekAdapter, resolveAdapterOptions } = await import(pathToFileURL(`${root}/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`));
test('ultra uses native max on the actual wire and adds policy only to agent calls', async () => {
  const original = globalThis.fetch;
  const payloads = [];
  globalThis.fetch = async (_url, request) => {
    payloads.push(JSON.parse(request.body));
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const adapter = new DeepSeekAdapter({ options: () => resolveAdapterOptions({ models: [{ id: 'deepseek-fixture' }, { id: 'deepseek-flash' }] }), resolveApiKey: async () => 'fixture-not-a-key', resolveUserId: () => 'fixture', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }), resolveFiles: () => ({}) });
    const meta = await adapter.resolveModel('deepseek-official', 'deepseek-fixture');
    assert(meta.reasoning.efforts.some(e => e.id === 'ultra'));
    for (const [effort, purpose] of [['ultra', undefined], ['max', undefined], ['ultra', 'compaction'], ['off', undefined]]) {
      const options = { provider: 'deepseek-official', model: 'deepseek-fixture', reasoningEffort: effort, messages: [{ role: 'system', content: [{ type: 'text', text: 'Original instructions.' }] }, { role: 'user', content: [{ type: 'text', text: 'Do work.' }] }], tools: ['bash', 'subagent', 'subagent_fork', 'workflow', 'ralph'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })), ...(purpose ? { purpose } : {}) };
      const before = JSON.stringify(options);
      for await (const _chunk of adapter.stream(options)) { }
      assert.equal(JSON.stringify(options), before, 'Adapter must not mutate logged input');
    }
    for (const [model, purpose, sessionId, tools] of [['deepseek-flash', undefined, 'root', ['bash']], ['deepseek-flash', 'compaction', 'root', ['bash']], ['deepseek-flash', undefined, undefined, ['bash']], ['deepseek-flash', undefined, 'root', []]]) {
      const options = { provider: 'deepseek-official', model, reasoningEffort: 'high', sessionId, purpose,
        messages: [{ role: 'system', content: [{ type: 'text', text: 'Original instructions.' }] }, { role: 'user', content: [{ type: 'text', text: 'Do work.' }] }],
        tools: tools.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })) };
      const before = JSON.stringify(options);
      for await (const _chunk of adapter.stream(options)) { }
      assert.equal(JSON.stringify(options), before, 'Flash guidance must not mutate logged input');
    }
    assert.equal(payloads[0].reasoning_effort, 'max');
    assert.equal(payloads[0].thinking.type, 'enabled');
    assert.deepEqual(payloads[0].tools.map(tool => tool.function.name), ['bash', 'subagent', 'subagent_fork']);
    assert.deepEqual(payloads[1].tools.map(tool => tool.function.name), ['bash']);
    assert(JSON.stringify(payloads[0].messages).includes('DSCODE ULTRA'));
    assert(!JSON.stringify(payloads[1].messages).includes('DSCODE ULTRA'));
    assert(!JSON.stringify(payloads[2].messages).includes('DSCODE ULTRA'));
    assert.equal(payloads[3].thinking.type, 'disabled');
    assert.equal(payloads[3].reasoning_effort, undefined);
    assert(JSON.stringify(payloads[4].messages).includes('DSCODE DeepSeek Flash'));
    assert(!JSON.stringify(payloads[5].messages).includes('DSCODE DeepSeek Flash'));
    assert(!JSON.stringify(payloads[6].messages).includes('DSCODE DeepSeek Flash'));
    assert(JSON.stringify(payloads[7].messages).includes('DSCODE DeepSeek Flash'));
  } finally { globalThis.fetch = original; }
});
test('high and max cannot launch or wake children; Ultra remains available', async () => {
  let execute;
  let effort = 'high';
  const owner = { session: { id: 'root', header: {}, requestHeader: () => ({ config: { reasoningEffort: effort } }) }, options: {} };
  const child = { status: 'idle', session: { header: { origin: 'subagent', parentSession: 'root' } } };
  apply({ systemPrompt: { section() {} }, on: (event, cb) => { if (event === 'tools/execute') execute = cb; }, commands: { register() {} }, agents: { list: () => [child], get: () => child } });
  for (const level of ['low', 'high', 'max']) {
    effort = level;
    for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
      await assert.rejects(execute({ name, arguments: {}, agent: owner }, () => assert.fail('must not launch')), /requires Ultra/);
    }
    await assert.rejects(execute({ name: 'send_message', arguments: { agent_id: 'child' }, agent: owner }, () => assert.fail('must not wake')), /requires Ultra/);
  }
  child.status = 'running';
  assert.equal(await execute({ name: 'send_message', arguments: { agent_id: 'child' }, agent: owner }, () => 'message'), 'message');
  effort = 'ultra';
  assert.equal(await execute({ name: 'subagent', arguments: {}, agent: owner }, () => 'started'), 'started');
  const nested = { session: { id: 'nested', header: { origin: 'subagent', parentSession: 'root' }, requestHeader: () => ({ config: { reasoningEffort: 'ultra' } }) }, options: {} };
  for (const name of ['subagent', 'subagent_fork', 'workflow', 'ralph']) {
    await assert.rejects(execute({ name, arguments: {}, agent: nested }, () => assert.fail('child must not delegate')), /cannot delegate again/);
  }
});
test('dscode workers do not see delegation tools or delegation prompt sections', async () => {
  let assemble;
  const sections = [];
  apply({ systemPrompt: { section: value => sections.push(value) }, on: (event, cb) => { if (event === 'system-prompt/assemble') assemble = cb; }, commands: { register() {} }, agents: { list: () => [], get: () => undefined } });
  const base = { tools: ['bash', 'subagent', 'subagent_fork', 'workflow', 'ralph'].map(name => ({ name })), sections: ['tool:subagent', 'tool:subagent_fork', 'dscode:shell-policy'].map(name => ({ name })) };
  const child = { scope: { session: { header: { origin: 'subagent', agentPreset: 'dscode' } } } };
  assert.match(sections.find(section => section.name === 'dscode:child-policy').text(child), /Complete your assigned task/);
  assert.deepEqual((await assemble(base, child, async () => base)).tools.map(tool => tool.name), ['bash']);
  assert.deepEqual((await assemble(base, child, async () => base)).sections.map(section => section.name), ['dscode:shell-policy']);
  const root = { scope: { session: { header: { agentPreset: 'dscode' } } } };
  assert.equal(await assemble(base, root, async () => base), base);
});
test('pinned runtime patches are idempotent and reject unknown upstream code', () => {
  for (const [name, patch] of [['dsh-tool-subagent', patchSubagent], ['dsh-subagent', patchSubagentCore], ['dsh-subagent-in-process-driver', patchSubagentDriver], ['dsh-llm-deepseek', patchDeepSeek], ['dsh-tool-bash', patchBash], ['dsh-tool-bash-persistent', patchPersistent], ['dsh-terminal-bash', patchTerminalBash]]) {
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
