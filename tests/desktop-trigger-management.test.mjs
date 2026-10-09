import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DesktopTriggerControl, DesktopTriggerManagement } from '../plugins/triggers/desktop-management.mjs';
import { triggerDesktopRequest } from '../plugins/triggers/desktop-host.mjs';
import { registerTriggerTools } from '../plugins/triggers/tools.mjs';
import { triggerCommand } from '../plugins/triggers/commands.mjs';
import { acquireTriggerLease } from '../plugins/triggers/lease.mjs';
import { markUnattended, mutationProblem } from '../plugins/triggers/unattended.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-desktop-management-')), home = join(root, 'state'), project = join(root, 'project');
  mkdirSync(project);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { permission: 'workspace-write', plan: {}, calls: [] };
  const agent = { id: 'session', ctx: { preset: 'dscode' }, session: { header: { cwd: project, delegationDepth: 0 } } };
  const agents = [agent];
  const ctx = { get: name => name === 'planMode' ? { get: () => state.plan } : undefined, logger: { warn() {} },
    agents: { roots: () => agents, get: id => agents.find(agent => agent.id === id) },
    agentPresets: { composedPreset: scope => scope.preset }, permissionPresets: { current: () => state.permission } };
  const control = new DesktopTriggerControl(ctx, { home });
  t.after(() => control.dispose());
  const management = new DesktopTriggerManagement({ home, control }), service = { control, management };
  const request = payload => triggerDesktopRequest(ctx, service, payload);
  return { root, home, project, state, agent, agents, ctx, control, management, request };
}

test('Desktop activation persists only by explicit choice and resumes after Host readiness', async t => {
  const f = fixture(t);
  await f.control.initialize();
  assert.equal((await f.control.status()).enabled, false);
  assert.equal((await f.control.status()).running, false);
  await f.control.setEnabled(true);
  assert.equal((await f.control.status()).running, true);
  await f.control.dispose();
  assert.equal(JSON.parse(readFileSync(f.control.path)).enabled, true, 'Quit must preserve the saved preference');
  const restarted = new DesktopTriggerControl(f.ctx, { home: f.home });
  t.after(() => restarted.dispose());
  const ready = Promise.withResolvers();
  const initializing = restarted.initialize(ready.promise);
  assert.equal(restarted.owner.status().running, false);
  ready.resolve(); await initializing;
  assert.equal((await restarted.status()).running, true);
  await restarted.setEnabled(false);
  assert.equal(JSON.parse(readFileSync(f.control.path)).enabled, false);
  const lease = await acquireTriggerLease(f.home, '_scheduler'); assert(lease); lease.release();
});

test('invalid settings fail closed and competing queue ownership rolls back a new enable', async t => {
  const f = fixture(t);
  mkdirSync(join(f.home, 'config'), { recursive: true });
  writeFileSync(f.control.path, '{"version":1,"enabled":"yes"}');
  const invalid = new DesktopTriggerControl(f.ctx, { home: f.home });
  t.after(() => invalid.dispose());
  await invalid.initialize();
  assert.equal((await invalid.status()).enabled, false);
  assert.match((await invalid.status()).error, /Invalid/);
  const lease = await acquireTriggerLease(f.home, '_scheduler');
  try {
    assert.equal((await invalid.status()).owner, 'external');
    await assert.rejects(invalid.setEnabled(true), /already running/);
    assert.equal(JSON.parse(readFileSync(invalid.path)).enabled, false);
    await invalid.setEnabled(false);
    assert.equal((await invalid.status()).running, true, 'Disabling Desktop cannot stop an external owner');
  } finally { lease.release(); }
});

test('serialized enable/disable and disposal cannot leave a newly running owner', async t => {
  const f = fixture(t);
  await Promise.all([f.control.setEnabled(true), f.control.setEnabled(false)]);
  assert.equal((await f.control.status()).running, false);
  assert.equal(JSON.parse(readFileSync(f.control.path)).enabled, false);
  await f.control.dispose();
  await assert.rejects(f.control.setEnabled(true), /shutting down/);
  await assert.rejects(f.management.manage({ action: 'list' }, f.agent), /shutting down/);
});

test('failed preference persistence never starts work and disposal fences a pending startup barrier', async t => {
  const f = fixture(t);
  mkdirSync(f.control.path, { recursive: true });
  let starts = 0;
  f.control.owner.start = async () => { starts++; };
  await assert.rejects(f.control.setEnabled(true));
  assert.equal(starts, 0);
  rmSync(f.control.path, { recursive: true });
  f.control.save(true);
  const barrier = Promise.withResolvers(), ready = f.control.initialize(barrier.promise);
  await f.control.dispose(); barrier.resolve(); await ready;
  assert.equal(starts, 0);
});

test('Desktop requests bind definitions to live DSCODE sessions and enforce mutation authority', async t => {
  const f = fixture(t);
  const args = { action: 'create', trigger_id: 'daily', definition: { prompt: 'Inspect changes', goal: { objective: 'Report findings' }, source: { kind: 'interval', seconds: 3600 } } };
  await assert.rejects(f.request({ action: 'manage', sessionId: 'missing', args }), /no longer open/);
  await assert.rejects(f.request({ action: 'manage', sessionId: f.agent.id, args: { ...args, definition: { ...args.definition, workspace: '/another-project' } } }), /accepts only/);
  f.state.permission = 'read-only';
  await assert.rejects(f.request({ action: 'manage', sessionId: f.agent.id, args }), /writable/);
  assert.equal((await f.request({ action: 'workspace', sessionId: f.agent.id })).writable, false);
  f.state.permission = 'workspace-write'; f.state.plan.pending = true;
  await assert.rejects(f.request({ action: 'manage', sessionId: f.agent.id, args }), /plan mode/);
  f.state.plan = {};
  const unmark = markUnattended(f.agent);
  await assert.rejects(f.request({ action: 'manage', sessionId: f.agent.id, args }), /Unattended/); unmark();
  const created = await f.request({ action: 'manage', sessionId: f.agent.id, args });
  assert.equal(created.definition.workspace, f.project);
  assert.equal(created.scheduler.running, false);
  const workspace = await f.request({ action: 'workspace', sessionId: f.agent.id });
  assert.equal(workspace.definitions.length, 1); assert(workspace.writable);
});

test('Desktop tools and slash commands expose start/stop without invoking OS installation', async t => {
  const f = fixture(t), tools = new Map();
  let gate;
  registerTriggerTools({ ...f.ctx, tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, on: (_event, fn) => { gate = fn; } }, { home: f.home, management: f.management });
  const tool = tools.get('trigger_scheduler');
  assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'start', 'stop']);
  assert.equal((await gate({ name: 'trigger_scheduler', arguments: { action: 'start' }, agent: f.agent }, async () => ({ kind: 'allow' }))).kind, 'ask');
  const slash = triggerCommand({ management: f.management, mutationProblem: agent => mutationProblem(f.ctx, agent) });
  const help = await slash({ agent: f.agent, rawInput: 'help' });
  assert.match(help.text, /status \| start \| stop/); assert.doesNotMatch(help.text, /scheduler install/);
  assert.match((await slash({ agent: f.agent, rawInput: 'scheduler install' })).text, /status\|start\|stop/);
  assert.equal((await slash({ agent: f.agent, rawInput: 'scheduler start' })).kind, 'success');
  assert.equal((await f.control.status()).running, true);
  assert.equal((await tool.execute({ action: 'stop' }, { agent: f.agent })).scheduler.enabled, false);
});

test('scheduling settings mount without enabling and create, edit, queue and cancel through session RPC', async t => {
  const f = fixture(t), requests = [];
  let definition, Component, props;
  runInNewContext(readFileSync(new URL('../plugins/triggers/desktop-client.mjs', import.meta.url), 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } }, setInterval, clearInterval, crypto: { randomUUID },
  });
  definition.factory(() => React).apply({ slots: { inject: (_name, fn) => fn(), register: (spec, component) => { Component = component; props = spec.inject(); } },
    connection: { rpc: { call: async (_path, _method, payload) => {
      requests.push(payload);
      return { ok: true, value: await f.request(payload) };
    } } },
  });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const field = label => renderer.root.findByProps({ 'aria-label': label });
  const button = label => renderer.root.findAllByType('button').find(node => node.children.includes(label));
  const click = async label => { await act(async () => { await button(label).props.onClick(); }); };
  const change = async (label, value) => { await act(async () => field(label).props.onChange({ target: { value } })); };
  for (let attempt = 0; !renderer.root.findAllByProps({ 'aria-label': 'Task ID' }).length && attempt < 100; attempt++) await act(async () => { await delay(5); });
  assert.deepEqual(requests.map(request => request.action), ['status', 'workspace']);
  assert.equal(f.control.enabled, false);
  await change('Task ID', 'ui-task'); await change('Task instructions', 'Review the project');
  await change('Goal (defaults to task instructions)', 'Provide a concise report');
  await click('Create task');
  assert.equal(f.management.definition(f.project, 'ui-task').goal.objective, 'Provide a concise report');
  await click('Edit ui-task'); await change('Task instructions', 'Review changed files'); await click('Save task changes');
  assert.equal(f.management.definition(f.project, 'ui-task').prompt, 'Review changed files');
  assert.equal(f.management.definition(f.project, 'ui-task').goal.objective, 'Provide a concise report');
  await click('Run ui-task once'); await click('Cancel ui-task job');
  assert.equal((await f.management.jobs({ action: 'list' }, f.agent)).jobs[0].state, 'cancelled');
  await click('Enable delivery and resume on launch'); assert(f.control.enabled);
  await click('Stop delivery and disable resume'); assert.equal(f.control.enabled, false);
  assert.deepEqual(renderer.root.findAllByProps({ role: 'alert' }).map(node => node.children), []);
});

async function mountSettings(t, request) {
  let definition, Component, props, timer, inFlight = 0;
  const focusedAlerts = [];
  runInNewContext(readFileSync(new URL('../plugins/triggers/desktop-client.mjs', import.meta.url), 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } }, crypto: { randomUUID },
    setInterval: callback => { timer = callback; return 1; }, clearInterval() {},
  });
  definition.factory(() => React).apply({ slots: { inject: (_name, fn) => fn(), register: (spec, component) => { Component = component; props = spec.inject(); } },
    connection: { rpc: { call: async (_path, _method, payload) => {
      inFlight++; try { return { ok: true, value: await request(payload) }; } finally { inFlight--; }
    } } },
  });
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props), {
    createNodeMock: element => element.props.role === 'alert' ? { focus: () => focusedAlerts.push(element.props.children) } : null,
  }); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const button = label => renderer.root.findAllByType('button').find(node => node.children.includes(label));
  const settle = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await act(async () => { await delay(2); });
      if (!inFlight && !button('Refresh schedules').props.disabled) return;
    }
    assert.fail('Scheduling UI did not settle');
  };
  await settle();
  return { renderer, button, settle, focusedAlerts,
    field: label => renderer.root.findByProps({ 'aria-label': label }),
    click: async label => { await act(async () => { await button(label).props.onClick(); }); },
    change: async (label, value) => { await act(async () => renderer.root.findByProps({ 'aria-label': label }).props.onChange({ target: { value } })); await settle(); },
    poll: async () => { await act(async () => timer()); await settle(); },
    beginPoll: async () => { await act(async () => timer()); },
  };
}

test('background schedule refresh preserves an actionable validation error and its draft', async t => {
  const f = fixture(t);
  let offline = false;
  const ui = await mountSettings(t, payload => {
    if (offline && payload.action === 'status') throw Error('Status connection interrupted');
    return f.request(payload);
  });
  await ui.change('Task ID', 'invalid'); await ui.change('Task instructions', 'Keep my instructions'); await ui.change('Interval seconds', '0');
  await ui.click('Create task');
  const errors = () => ui.renderer.root.findAllByProps({ role: 'alert' }).map(node => node.children.join(''));
  assert.match(errors().join(''), /positive whole number/);
  assert.equal(ui.focusedAlerts.length, 1, 'Submitting a failed action must bring its error into view');
  assert.match(ui.focusedAlerts[0], /positive whole number/);
  await ui.poll();
  assert.match(errors().join(''), /positive whole number/);
  offline = true; await ui.poll();
  assert.match(errors().join(''), /positive whole number/);
  assert.match(errors().join(''), /Unable to refresh schedules: Status connection interrupted/);
  offline = false; await ui.poll();
  assert.equal(errors().length, 1, 'Recovered polling must clear only the refresh error');
  assert.equal(ui.field('Task instructions').props.value, 'Keep my instructions');
  assert.equal(ui.focusedAlerts.length, 1, 'Polling and recovery must not steal focus from editing');
  await ui.change('Interval seconds', '60'); await ui.click('Create task');
  assert.deepEqual(errors(), []);
});

for (const failedRefresh of [false, true]) test(`a save waits for background polling without disabling editing (${failedRefresh ? 'failed' : 'successful'} refresh)`, async t => {
  const f = fixture(t), calls = [];
  let hold = false, release;
  const ui = await mountSettings(t, async payload => {
    calls.push(payload.action);
    if (hold && payload.action === 'status') {
      hold = false;
      await new Promise(resolve => { release = resolve; });
      if (failedRefresh) throw Error('Refresh failed');
    }
    return f.request(payload);
  });
  await ui.change('Task ID', 'queued-save'); await ui.change('Task instructions', 'Before polling');
  calls.length = 0; hold = true; await ui.beginPoll();
  assert.equal(ui.renderer.root.findByType('fieldset').props.disabled, false, 'A background request must leave editing enabled');
  await act(async () => ui.field('Task instructions').props.onChange({ target: { value: 'Edited during polling' } }));
  let submitted;
  await act(async () => { submitted = ui.button('Create task').props.onClick(); });
  assert.equal(ui.renderer.root.findByType('fieldset').props.disabled, true, 'Only the foreground save disables the form');
  assert.deepEqual(calls, ['status'], 'The save waits for the in-flight refresh');
  release(); await act(async () => submitted); await ui.settle();
  const workspace = await f.request({ action: 'workspace', sessionId: f.agent.id });
  assert.equal(workspace.definitions.length, 1);
  assert.equal(workspace.definitions[0].prompt, 'Edited during polling');
  assert.equal(calls.filter(action => action === 'manage').length, 1);
  assert.equal(ui.renderer.root.findAllByProps({ role: 'alert' }).length, 0);
});

test('switching workspace sessions clears the previous source log', async t => {
  const f = fixture(t), other = join(f.root, 'other'); mkdirSync(other);
  f.agents.push({ ...f.agent, id: 'other', session: { header: { cwd: other, delegationDepth: 0 } } });
  await f.management.manage({ action: 'create', trigger_id: 'events', definition: { prompt: 'Inspect event', goal: { objective: 'Report findings' },
    source: { kind: 'script', mode: 'daemon', command: ['node', '-e', ''] } } }, f.agent);
  f.management.withStore(store => store.run('UPDATE sources SET log=?', 'Log from the first workspace'));
  const ui = await mountSettings(t, f.request);
  await ui.click('Read events source log');
  assert.equal(ui.field('Source log').children.join(''), 'Log from the first workspace');
  await ui.change('Workspace session', 'other');
  assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': 'Source log' }).length, 0);
  await ui.change('Workspace session', f.agent.id); await ui.click('Read events source log');
  f.agents.shift(); await ui.poll();
  assert.equal(ui.field('Workspace session').props.value, 'other');
  assert.equal(ui.renderer.root.findAllByProps({ 'aria-label': 'Source log' }).length, 0, 'Closing the selected session must also clear its log');
});

for (const failure of ['reply', 'refresh']) test(`interleaved manual-run retries cannot duplicate a job after a lost ${failure}`, async t => {
  const f = fixture(t);
  for (const id of ['first', 'second']) await f.management.manage({ action: 'create', trigger_id: id,
    definition: { prompt: 'Inspect changes', goal: { objective: 'Report findings' }, source: { kind: 'external' } } }, f.agent);
  const other = join(f.root, 'other'); mkdirSync(other);
  const otherAgent = { ...f.agent, id: 'other', session: { header: { cwd: other, delegationDepth: 0 } } };
  f.agents.push(otherAgent, { ...f.agent, id: 'same-project' });
  await f.management.manage({ action: 'create', trigger_id: 'first', definition: {
    prompt: 'Inspect the other project', goal: { objective: 'Report findings' }, source: { kind: 'external' },
  } }, otherAgent);
  let drop = true, dropRefresh = false;
  const ui = await mountSettings(t, async payload => {
    if (dropRefresh && payload.action === 'status') { dropRefresh = false; throw Error('Refresh lost after accepting the job'); }
    const value = await f.request(payload);
    if (drop && payload.action === 'jobs' && payload.args.trigger_id === 'first') {
      drop = false;
      if (failure === 'reply') throw Error('Reply lost after accepting the job');
      dropRefresh = true;
    }
    return value;
  });
  await ui.click('Run first once'); assert(ui.button('Retry first once')); await ui.click('Run second once');
  await ui.change('Workspace session', 'other'); await ui.click('Run first once');
  await ui.change('Workspace session', 'same-project'); await ui.click('Retry first once');
  assert(ui.button('Run first once'), 'A confirmed retry allows a new intentional run');
  const jobs = (await f.management.jobs({ action: 'list' }, f.agent)).jobs;
  assert.equal(jobs.filter(job => job.triggerId === 'first').length, 1);
  assert.equal(jobs.filter(job => job.triggerId === 'second').length, 1);
  assert.equal((await f.management.jobs({ action: 'list' }, otherAgent)).jobs.length, 1);
});
