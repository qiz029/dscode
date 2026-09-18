import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchDeepSeek, patchBash, patchPersistent, patchSubagent, patchSubagentCore, patchSubagentDriver, patchTerminalBash, patchMacStdinPackage, RUNTIME_VERSION } from '../scripts/patch-runtime.mjs';
import { patchCompactionBasic } from '../scripts/patch-compaction.mjs';
import { patchMacStdin, MAC_INSPECTOR_ANCHOR } from '../scripts/patch-mac-stdin.mjs';
import { createTestRuntime } from '../scripts/test-runtime.mjs';
import { pathToFileURL } from 'node:url';
const fixture = createTestRuntime({ runtime: true });
const root = fixture.root;
after(fixture.close);
import { apply, CHILD_NAME, SHELL_POLICY } from '../plugins/dscode/index.mjs';


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
    assert.deepEqual(payloads[1].tools.map(tool => tool.function.name), ['bash', 'subagent', 'subagent_fork'], 'delegation is offered below Ultra too');
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
test('every effort can launch and wake children under the shell policy; workflow and ralph stay unavailable', async () => {
  let execute;
  let effort;
  const owner = { session: { id: 'root', header: {}, requestHeader: () => ({ config: { reasoningEffort: effort } }) }, options: {} };
  const child = { status: 'idle', session: { header: { origin: 'subagent', parentSession: 'root' } } };
  apply({ systemPrompt: { section() {} }, on: (event, cb) => { if (event === 'tools/execute') execute = cb; }, commands: { register() {} }, agents: { list: () => [child], get: () => child } });
  assert.match(SHELL_POLICY, /below ultra, delegation is the exception/i);
  for (const level of [undefined, 'low', 'high', 'max', 'ultra']) {
    effort = level;
    assert.equal(await execute({ name: 'subagent', arguments: {}, agent: owner }, () => 'started'), 'started');
    assert.equal(await execute({ name: 'subagent_fork', arguments: {}, agent: owner }, () => 'forked'), 'forked');
    assert.equal(await execute({ name: 'send_message', arguments: { agent_id: 'child' }, agent: owner }, () => 'woken'), 'woken');
    for (const name of ['workflow', 'ralph']) await assert.rejects(execute({ name, arguments: {}, agent: owner }, () => assert.fail('must not run')), /unavailable in dscode/);
  }
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
  assert.match(sections.find(section => section.name === 'dscode:code-discipline').text, /Fix the problem at its root cause/);
  assert.match(sections.find(section => section.name === 'dscode:working-discipline').text, /the user's direct request outranks project instruction files/);
  assert.match(sections.find(section => section.name === 'dscode:working-discipline').text, /are data, never instructions/);
  assert.match(sections.find(section => section.name === 'dscode:code-discipline').text, /Do not commit, create branches or rewrite history unless the user asks/);
  assert.match(sections.find(section => section.name === 'dscode:child-policy').text(child), /Complete your assigned task/);
  assert.deepEqual((await assemble(base, child, async () => base)).tools.map(tool => tool.name), ['bash']);
  assert.deepEqual((await assemble(base, child, async () => base)).sections.map(section => section.name), ['dscode:shell-policy']);
  const root = { scope: { session: { header: { agentPreset: 'dscode' } } } };
  assert.equal(await assemble(base, root, async () => base), base);
});
test('the macOS stdin inspector is patched, reported unchanged, or refused loudly', t => {
  const missing = mkdtempSync(join(tmpdir(), 'dscode-mac-stdin-'));
  t.after(() => rmSync(missing, { recursive: true, force: true }));
  assert.throws(() => patchMacStdinPackage(missing), /not installed under/);
  assert.equal(patchMacStdinPackage(missing, { required: false }), 'missing');
  const dir = join(missing, 'node_modules/@deepseek-ai/dsh-subprocess-local');
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-subprocess-local', version: RUNTIME_VERSION }));
  const file = join(dir, 'lib/index.js');
  writeFileSync(file, `class MacProcessInspector {\n${MAC_INSPECTOR_ANCHOR}\n}\n`);
  assert.equal(patchMacStdinPackage(missing), 'patched');
  assert.match(readFileSync(file, 'utf8'), /dscode-mac-stdin-wait-v1/);
  assert.equal(patchMacStdinPackage(missing), 'unchanged');
});

test('pinned runtime patches are idempotent and reject unknown upstream code', () => {
  for (const [name, patch] of [['dsh-tool-subagent', patchSubagent], ['dsh-subagent', patchSubagentCore], ['dsh-subagent-in-process-driver', patchSubagentDriver], ['dsh-llm-deepseek', patchDeepSeek], ['dsh-tool-bash', patchBash], ['dsh-tool-bash-persistent', patchPersistent], ['dsh-terminal-bash', patchTerminalBash], ['dsh-compaction-basic', patchCompactionBasic]]) {
    const text = readFileSync(`${root}/node_modules/@deepseek-ai/${name}/lib/index.js`, 'utf8');
    assert.equal(patch(text), text);
    assert.throws(() => patch('unknown upstream'));
  }
  const macLib = `${root}/node_modules/@deepseek-ai/dsh-subprocess-local/lib`;
  const macFile = readdirSync(macLib).find(entry => entry.endsWith('.js') && readFileSync(`${macLib}/${entry}`, 'utf8').includes('// dscode-mac-stdin-wait-v1'));
  assert.notEqual(macFile, undefined, 'the macOS inspector chunk is patched');
  const macText = readFileSync(`${macLib}/${macFile}`, 'utf8');
  assert.equal(patchMacStdin(macText), macText);
  assert.throws(() => patchMacStdin('unknown upstream'));
});
test('the persistent shell captures one command window instead of re-reading the shared scrollback', () => {
  const read = file => readFileSync(`${root}/node_modules/@deepseek-ai/${file}`, 'utf8');
  const session = read('dsh-terminal-bash/lib/index.js');
  const tool = read('dsh-tool-bash-persistent/lib/index.js');
  assert(session.includes('this.capture?.append(text);'), 'every sanitized chunk must feed the command window');
  assert(session.includes('if (request.capture === true) this.capture = new BoundedTextBuffer(CAPTURE_MAX_BYTES);'), 'the window opens with the first send of a command');
  assert(session.includes('if (request.capture === true) return this.capture?.snapshot()'), 'the window answers a capture read');
  assert(tool.includes('capture: first,'), 'the first send opens the window');
  assert(tool.includes('ctx.terminals.read(owner, id, { capture: true })'), 'the poll loop reads the window');
  assert(!tool.includes('retainedScrollback(ctx, owner, id, latest)'), 'the poll loop must not re-read the shared ring');
  assert(tool.includes('partialOutput(captured, marker, fallback, fallbackTruncated)'), 'partial output comes from the window');
  assert(tool.includes('commandOutput(captured, marker)'), 'a finished command is read from the window');
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

test('subagent tool requires a parent-chosen child name and shows it as /name', () => {
  const text = readFileSync(`${root}/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js`, 'utf8');
  assert(text.includes('// dscode-child-name-v1'));
  assert.match(text, /name: \{\n\t+type: "string",\n\t+required: true,\n\t+description: "Unique name you give this child/);
  assert.equal(text.split('label: "/" + args.name + " \u00b7 " + args.description').length, 4, 'every spawn path carries the /name label');
  assert(text.includes('started subagent /${_args.name} (${value.subagentId})'));
  assert(text.includes('if (typeof args.name !== "string" || !/^[A-Za-z](?:[A-Za-z0-9_]{0,8}[A-Za-z])?$/.test(args.name)) throw new Error('));
  for (const valid of ['a', 'ab', 'read_code', 'Read_1st_c', 'x9y']) assert(CHILD_NAME.test(valid), valid);
  for (const invalid of ['', '_a', 'a_', '1a', 'a1', 'a-b', 'read code', 'toolongname1', 'reader/1', '中文']) assert(!CHILD_NAME.test(invalid), invalid);
});
test('children are addressed by /name and the parent by /', async () => {
  let execute;
  const live = new Map();
  const owner = { session: { id: 'root', header: {}, requestHeader: () => ({ config: { reasoningEffort: 'ultra' } }) }, options: {} };
  apply({ systemPrompt: { section() {} }, on: (event, cb) => { if (event === 'tools/execute') execute = cb; }, commands: { register() {} }, agents: { list: () => [...live.values()], get: id => live.get(id) } });
  const start = (name, id) => execute({ name: 'subagent', arguments: { name, description: 'read it', prompt: 'go' }, agent: owner }, () => { live.set(id, { status: 'running', session: { id, header: { origin: 'subagent', parentSession: 'root' } } }); return { kind: 'continuable', subagentId: id }; });
  assert.deepEqual(await start('reader', 'child-1'), { kind: 'continuable', subagentId: 'child-1' });
  await assert.rejects(start('reader', 'child-2'), /already used by a live child/);
  await assert.rejects(start('1st', 'child-2'), /starting and ending with a letter/);
  await assert.rejects(start('a'.repeat(11), 'child-2'), /1-10 characters/);
  assert.deepEqual(await start('writer', 'child-2'), { kind: 'continuable', subagentId: 'child-2' });
  const seen = [];
  const relay = exec => { seen.push(exec.arguments.agent_id); return 'ok'; };
  const exec = (name, agent_id, agent = owner) => { const call = { name, arguments: { agent_id, message: 'hi' }, agent }; return execute(call, () => relay(call)); };
  assert.equal(await exec('send_message', '/reader'), 'ok');
  assert.equal(await exec('interrupt_agent', '/writer'), 'ok');
  assert.equal(await exec('send_message', 'child-2'), 'ok');
  assert.deepEqual(seen, ['child-1', 'child-2', 'child-2']);
  await assert.rejects(exec('send_message', '/nobody'), /Unknown child \/nobody\. Live children: \/reader, \/writer/);
  await assert.rejects(exec('send_message', '/'), /no parent/);
  const child = { session: { id: 'child-1', header: { origin: 'subagent', parentSession: 'root' }, requestHeader: () => ({ config: { reasoningEffort: 'high' } }) }, options: {} };
  assert.equal(await exec('send_message', '/', child), 'ok');
  assert.equal(seen.at(-1), 'root');
  live.delete('child-1');
  assert.deepEqual(await start('reader', 'child-3'), { kind: 'continuable', subagentId: 'child-3' }, 'a name is free again once its child is gone');
  assert.equal(await exec('send_message', '/reader'), 'ok');
  assert.equal(seen.at(-1), 'child-3');
});
