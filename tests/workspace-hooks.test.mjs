import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountWorkspaceHooks } from '../plugins/desktop-workspace/hooks.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-workspace-hooks-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'hooks.json');
  const points = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
  writeFileSync(path, JSON.stringify({ hooks: Object.fromEntries(points.map(point => [point, [{ hooks: [{ type: 'command', command: `hook-${point}` }] }]])) }));
  const requests = [], events = [], warnings = [], ensures = [], injected = [], disposers = [], listeners = new Map();
  let cwd = '/workspace/original';
  let exitCode = 0;
  const agent = { session: { header: { id: 'hook-session', cwd }, append: (type, data) => events.push({ type, data }) }, inject: value => injected.push(value) };
  const scope = {
    workingDirectory: { ensure: async (owner, signal) => { ensures.push({ owner, signal }); return cwd; } },
    shell: { resolve: request => request, execute: async request => {
      requests.push(request);
      return { result: async () => ({ exitCode, stdout: { text: 'hook context' }, stderr: { text: exitCode === 2 ? 'blocked by fixture' : '' } }) };
    } },
    sessionProjections: { stateOf: () => ({ lastTurn: 1 }) },
    logger: { warn: text => warnings.push(text) },
    effect: fn => { disposers.push(fn()); },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event); },
  };
  t.after(async () => { for (const dispose of disposers) await dispose?.(); });
  const context = { plugin: async plugin => plugin.apply(scope) };
  const signal = new AbortController().signal;
  await mountWorkspaceHooks(context, path, { agent, source: 'create', signal });
  return { agent, signal, requests, events, warnings, ensures, injected, listeners,
    setCwd: value => { cwd = value; }, block: () => { exitCode = 2; },
    remount: () => mountWorkspaceHooks(context, path, undefined) };
}

test('workspace hooks resolve the effective cwd for startup, messages, tools and stop', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.warnings, []);
  assert.equal(f.requests.length, 1);
  assert.equal(f.injected.length, 1);
  const { agent, signal } = f;
  const messages = [{ content: [{ type: 'text', text: 'hello' }] }];
  f.setCwd('/workspace/changed');
  const entered = await f.listeners.get('agent/pre-step')({ agent, signal, messages, turn: 1 }, async () => ({ kind: 'enter', messages }));
  assert.equal(entered.kind, 'enter');
  assert.equal(entered.messages.length, 2, 'hook context reaches the model');
  const exec = { agent, signal, name: 'bash', arguments: { command: 'pwd' }, callId: 'call-1' };
  await f.listeners.get('tools/pre-execute')(exec, async () => ({ kind: 'allow' }));
  await f.listeners.get('tools/post-execute')(exec, { content: [] }, async () => ({ kind: 'allow' }));
  await f.listeners.get('agent/turn-stopping')({ agent, signal, turn: 1 });
  assert.deepEqual(f.requests.map(request => JSON.parse(request.stdin).hook_event_name), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
  for (const [index, request] of f.requests.entries()) {
    const cwd = index === 0 ? '/workspace/original' : '/workspace/changed';
    assert.equal(request.workdir, cwd);
    assert.equal(JSON.parse(request.stdin).cwd, cwd);
    assert.equal(f.ensures[index].owner, agent);
    assert(f.ensures[index].signal instanceof AbortSignal);
    if (index > 0) assert.equal(f.ensures[index].signal, signal);
  }
  const starts = f.requests.length;
  await f.remount();
  assert.equal(f.requests.length, starts, 'reload must not repeat SessionStart');
});

test('a UserPromptSubmit hook still blocks delivery when it exits 2', async t => {
  const f = await fixture(t);
  f.block();
  let entered = false;
  const result = await f.listeners.get('agent/pre-step')({ agent: f.agent, signal: f.signal, messages: [{ content: [{ type: 'text', text: 'blocked' }] }], turn: 1 }, async () => { entered = true; return { kind: 'enter', messages: [] }; });
  assert.equal(result.kind, 'reject');
  assert.equal(entered, false);
  assert(f.events.some(event => event.type === 'hook/result'));
});
