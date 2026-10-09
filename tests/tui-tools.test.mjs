import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, applyDesktop, findConflicts } from '../plugins/tui-tools/index.mjs';
import { hookReportFile } from '../plugins/tui-tools/hook-sources.mjs';
import { validateHooks } from '../plugins/tui-tools/hooks.mjs';
import { inspectComposition } from '../plugins/tui-tools/composition.mjs';

test('Desktop diagnostics use separate command names, preserve paths and reject native Standard sessions', async () => {
  const native = { name: 'skills' }, commands = new Map([['skills', native]]);
  const agent = { ctx: { preset: 'dscode' }, status: 'idle', options: {}, session: { id: 'desktop', header: { cwd: '/skills', agentPreset: 'dscode' }, requestHeader: () => undefined, snapshotEvents: () => [] } };
  applyDesktop({ commands: { register: command => commands.set(command.name, command) },
    agentPresets: { composedPreset: ctx => ctx.preset }, get: () => undefined,
    tools: { schemas: () => [] }, permissionPresets: { current: () => 'workspace-write' },
    skills: { snapshot: async () => ({ skills: [], complete: true }) } });
  assert.equal(commands.get('skills'), native);
  assert.deepEqual([...commands.keys()].sort(), ['dscode-doctor', 'dscode-mcp', 'dscode-skills', 'dscode-status', 'skills']);
  const result = await commands.get('dscode-status').handler({ agent, rawInput: '' });
  assert.match(result.text, /Workspace: \/skills/); assert.match(result.text, /\/dscode-doctor/); assert(!result.text.includes('/statusline'));
  agent.ctx.preset = 'standard';
  for (const name of ['status', 'doctor', 'skills', 'mcp']) assert.equal((await commands.get(`dscode-${name}`).handler({ agent, rawInput: '' })).kind, 'error');
});

test('new registry diagnostics read only the Agent-bound revision without fabricating mutable entries', async () => {
  const commands = new Map();
  const host = { id: 'profile:host-mcp', options: { id: 'host-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'host' } }, disabled: false, fiber: { state: 2 }, async update() { throw Error('Unexpected mutation'); } };
  let queried;
  const registry = { inspectCompositions(scope) {
    queried = scope;
    assert(scope, 'Never enumerate every session preset');
    return [{ id: 'retained-preset', modules: [{ moduleName: '@deepseek-ai/dsh-mcp-client' }, { moduleName: '@deepseek-ai/dsh-skill-filesystem' }], leakedServices: ['unexpected-service'] }];
  } };
  const scope = { get: name => name === 'agentPresets' ? registry : undefined };
  const agent = { ctx: scope, status: 'idle', session: { id: 'one', header: { cwd: process.cwd(), agentPreset: 'retained-preset' }, requestHeader: () => null, snapshotEvents: () => [] }, options: {} };
  const ctx = { get: name => name === 'loader' ? { entries: () => [host] } : undefined,
    commands: { register: d => commands.set(d.name, d) }, agents: { list: () => [agent] },
    tools: { schemas: () => [] }, permissionPresets: { current: () => 'workspace-write' }, skills: { snapshot: async () => ({ skills: [], complete: true }) } };
  apply(ctx);
  assert.deepEqual(inspectComposition(ctx, agent).entries, [host]);
  assert.equal(queried, scope);
  const run = (name, rawInput = '') => commands.get(name).handler({ rawInput, agent });
  const status = await run('status');
  assert.equal(status.kind, 'success', status.text);
  assert.match(status.text, /Host plugins: 1 active/);
  assert.match(status.text, /Preset retained-preset: 2 active modules.*unexpected-service/);
  const mcp = await run('mcp');
  assert.match(mcp.text, /server=host/);
  assert.match(mcp.text, /Preset MCP modules are present/);
  const mutation = await run('mcp', 'disable retained-preset');
  assert.equal(mutation.kind, 'error');
  assert.match(mutation.text, /no mutable preset entries/);
  const conflicts = await run('skills', 'conflicts');
  assert.match(conflicts.text, /Incomplete:.*only Host filesystem roots were checked/);
});

test('unsupported hooks, bad regexes and async gates cannot silently load', () => {
  assert.deepEqual(validateHooks({ hooks: {} }), {});
  for (const value of [null, [], { PreCompact: [] }, { PreToolUse: [{ matcher: '[', hooks: [] }] }, { Stop: [{ hooks: [{ type: 'command', command: 'echo ok', async: true }] }] }]) assert.throws(() => validateHooks(value));
  assert(validateHooks({ Stop: [{ hooks: [{ command: 'echo ok', timeout: 5 }] }] }));
});
test('MCP mutation protects running agents, uses exact entry and reconnects by disposal', async () => {
  const commands = new Map();
  const updates = [];
  let status = 'running';
  const entry = { id: 'profile:mcp-chrome', options: { id: 'mcp-chrome', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'chrome' } }, disabled: false, fiber: { state: 2 }, async update(x) { updates.push(x); this.disabled = x.disabled; } };
  apply({ commands: { register: d => commands.set(d.name, d) }, get: () => ({ entries: () => [entry] }), agents: { list: () => [{ status }] }, tools: { schemas: () => [] } });
  const run = rawInput => commands.get('mcp').handler({ rawInput, agent: {} });
  assert.equal((await run('disable mcp-chrome')).kind, 'error');
  assert.equal(updates.length, 0);
  status = 'idle';
  assert.equal((await run('reconnect mcp-chrome')).kind, 'success');
  assert.deepEqual(updates, [{ disabled: true }, { disabled: false }]);
  assert.equal((await run('disable missing')).kind, 'error');
});
test('the /mcp listing reports no server when nothing is mounted', async () => {
  const commands = new Map();
  apply({ commands: { register: d => commands.set(d.name, d) }, get: () => ({ entries: () => [] }), agents: { list: () => [] }, tools: { schemas: () => [] } });
  const listed = await commands.get('mcp').handler({ rawInput: '', agent: {} });
  assert.equal(listed.kind, 'success', JSON.stringify(listed));
  assert(!listed.text.includes('server='), listed.text);
  assert.match(listed.text, /\/mcp tools\|enable\|disable\|reconnect/);
});
test('filesystem conflicts retain source and both paths without loading bodies into conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscode-skills-'));
  try {
    for (const dir of ['.dsh/skills/test', '.agents/skills/test']) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, 'SKILL.md'), '---\nname: test\ndescription: example\n---\nPRIVATE_BODY');
    }
    await writeFile(join(root, '.dsh/skills/flat.md'), '---\nname: test\ndescription: flat\n---\nPRIVATE_BODY');
    const result = await findConflicts(root, [{}], [{ name: 'test', source: 'project-dsh', provider: 'filesystem' }], {});
    assert.match(result, /effective source=project-dsh/);
    assert.match(result, /flat\.md/);
    assert.match(result, /\.agents\/skills\/test/);
    assert.match(result, /\.dsh\/skills\/test/);
    assert(!result.includes('PRIVATE_BODY'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a user shell command reaches the agent with its secrets redacted', async () => {
  const commands = new Map();
  const flushes = [];
  const ctx = {
    commands: { register: definition => commands.set(definition.name, definition) },
    get: name => name === 'sessions' ? { flush: async session => { flushes.push(session); } } : undefined,
  };
  apply(ctx);
  const inbox = [];
  const session = { header: { cwd: process.cwd() } };
  const agent = { session, followup: message => inbox.push(message), steer: () => {} };
  const result = await commands.get('shell-exec').handler({ rawInput: 'echo hello && echo sk-abcdefghijklmnop', agent });
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /\[output handed to the agent\]/);
  assert.equal(inbox.length, 1, 'exactly one message reaches the agent');
  const text = inbox[0].content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  assert.match(text, /\[shell\] \$ echo hello/);
  assert.match(text, /hello/);
  assert.match(text, /\[REDACTED\]/, 'a secret in the output never reaches the agent verbatim');
  assert.doesNotMatch(text, /sk-abcdefghijklmnop/);
  assert.deepEqual(flushes, [session], 'the handover is flushed before the notice claims it');
});

test('the /hooks listing warns when a layer changed after the merge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dscode-hooks-stale-'));
  try {
    const resolved = join(root, 'hooks.resolved.json');
    const source = join(root, 'hooks.local.json');
    await writeFile(resolved, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo ok' }] }] } }));
    await writeFile(source, JSON.stringify({ hooks: {} }));
    await writeFile(join(root, hookReportFile), JSON.stringify({ sources: [source], skipped: [] }));
    const past = new Date(Date.now() - 60000);
    await utimes(resolved, past, past);
    const commands = new Map();
    const entry = { options: { id: 'dscode-hooks', name: '@deepseek-ai/dsh-hooks-codex', config: { configPath: resolved } }, disabled: false, fiber: { state: 2 } };
    apply({ commands: { register: d => commands.set(d.name, d) }, get: () => ({ entries: () => [entry] }), agents: { list: () => [] }, tools: { schemas: () => [] } });
    const listed = await commands.get('hooks').handler({ rawInput: '', agent: {} });
    assert.equal(listed.kind, 'success', JSON.stringify(listed));
    assert.match(listed.text, /Needs restart: .*hooks\.local\.json \(newer than the merge\)/);
    await rm(source);
    const missing = await commands.get('hooks').handler({ rawInput: '', agent: {} });
    assert.match(missing.text, /Needs restart: .*hooks\.local\.json \(missing\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
