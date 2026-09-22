import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TriggerManagement } from '../plugins/triggers/management.mjs';
import { triggerCommand } from '../plugins/triggers/commands.mjs';
import { mutationProblem } from '../plugins/triggers/tools.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-trigger-command-'));
  const home = join(root, 'state'), workspace = join(root, 'project');
  mkdirSync(home); mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = { permission: 'workspace-write', plan: {}, installations: 0 };
  const agent = { session: { header: { cwd: workspace } } };
  const ctx = { get: () => ({ get: () => state.plan }), permissionPresets: { current: () => state.permission } };
  const management = new TriggerManagement({ home, dscodePath: process.execPath, platform: 'darwin', service: async (_action, options) => { state.installations++; options.out('fixture installation'); } });
  const handler = triggerCommand({ management, mutationProblem: agent => mutationProblem(ctx, agent) });
  const call = (rawInput, options = {}) => handler({ rawInput, agent, ...options });
  return { home, workspace, state, agent, management, handler, call };
}
const patch = { prompt: 'Review the build', goal: { objective: 'Report findings' }, source: { kind: 'calendar', cron: '0 9 * * *', timezone: 'UTC' }, session: { mode: 'persistent' } };

test('TUI can create a disabled starter, configure cron, enable, pause and unregister it', async t => {
  const f = fixture(t);
  const first = await f.call('new daily');
  assert.equal(first.kind, 'success', first.text);
  assert.equal(f.management.definition(f.workspace, 'daily').enabled, false);
  assert.match(first.text, /Starter is disabled/);
  const updated = await f.call(`update daily ${JSON.stringify(patch)}`);
  assert.equal(updated.kind, 'success', updated.text);
  assert.equal(f.management.withStore(s => s.schedules().length), 1);
  await f.call('enable daily');
  assert.equal(f.management.definition(f.workspace, 'daily').enabled, true);
  assert.match((await f.call('')).text, /registered/);
  assert.match((await f.call('show daily')).text, /persistent/);
  await f.call('disable daily');
  assert.equal(f.management.definition(f.workspace, 'daily').enabled, false);
  await f.call('unregister daily');
  assert.equal(f.management.withStore(s => s.schedules().length), 0);
  await f.call('register daily');
  assert.equal(f.management.withStore(s => s.schedules().length), 1);
});

test('TUI queues immediate and delayed work without a model turn; retries and cancellation are durable', async t => {
  const f = fixture(t); await f.call('new daily');
  const command = { commandId: 'repeatable-run' };
  const first = await f.call('run daily build failed with spaces', command);
  assert.equal(first.kind, 'success', first.text); assert.match(first.text, /Scheduler: stopped/);
  await f.call('run daily build failed with spaces', command);
  assert.equal(f.management.withStore(s => s.list().length), 1);
  assert.match((await f.call('events daily')).text, /build failed with spaces/);
  assert.equal(JSON.parse(f.management.withStore(s => s.list()[0].payload)).text, 'build failed with spaces');
  const scheduled = await f.call('schedule daily 30m check later', { commandId: 'delay-one' });
  assert.equal(scheduled.kind, 'success', scheduled.text);
  await f.call('schedule daily 30m check later', { commandId: 'delay-one' });
  const job = f.management.withStore(s => s.list().find(j => j.kind === 'delay'));
  assert.equal(f.management.withStore(s => s.list().length), 2);
  assert.match((await f.call('jobs daily')).text, new RegExp(job.id));
  assert.equal((await f.call(`cancel ${job.id}`)).kind, 'success');
  assert.equal(f.management.withStore(s => s.get(job.id).state), 'cancelled');
  const at = new Date(Date.now() + 60000).toISOString();
  assert.equal((await f.call(`schedule daily ${at} absolute`)).kind, 'success');
});

test('TUI exposes source controls and scheduler installation independently of saved definitions', async t => {
  const f = fixture(t);
  assert.equal((await f.call(`create watcher ${JSON.stringify({ ...patch, source: { kind: 'script', mode: 'daemon', command: ['python3', 'watch.py'] } })}`)).kind, 'success');
  assert.match((await f.call('source watcher')).text, /desired running/);
  assert.match((await f.call('source watcher stop')).text, /desired stopped/);
  assert.match((await f.call('source watcher restart')).text, /desired running/);
  assert.equal(f.management.withStore(s => s.sources()[0].revision), 1);
  assert.match((await f.call('source watcher logs')).text, /No source output/);
  assert.match((await f.call('scheduler')).text, /stopped/);
  const result = await f.call('scheduler install');
  assert.equal(result.kind, 'success'); assert.match(result.text, /fixture installation/); assert.match(result.text, /stopped/);
  assert.equal(f.state.installations, 1);
});

test('TUI mutations respect permission, plan, subagent and abort boundaries while reads remain available', async t => {
  const f = fixture(t); await f.call('new daily');
  for (const setup of [() => { f.state.permission = 'read-only'; }, () => { f.state.plan = { active: true }; }, () => { f.agent.session.header.delegationDepth = 1; }]) {
    f.state.permission = 'workspace-write'; f.state.plan = {}; f.agent.session.header.delegationDepth = 0; setup();
    for (const input of ['enable daily', 'run daily', 'schedule daily 1h', 'scheduler install']) assert.equal((await f.call(input)).kind, 'error', input);
    assert.equal((await f.call('show daily')).kind, 'success');
    assert.equal((await f.call('jobs')).kind, 'success');
  }
  f.state.permission = 'workspace-write'; f.state.plan = {}; f.agent.session.header.delegationDepth = 0;
  const controller = new AbortController(); controller.abort();
  assert.equal((await f.call('enable daily', { signal: controller.signal })).kind, 'error');
  assert.equal(f.management.definition(f.workspace, 'daily').enabled, false);
  assert.equal(f.management.withStore(s => s.list().length), 0);
  assert.equal(f.state.installations, 0);
});

test('invalid TUI input does not mutate definitions and jobs cannot escape the current workspace', async t => {
  const f = fixture(t); await f.call('new daily');
  const path = f.management.definition(f.workspace, 'daily').path, before = readFileSync(path, 'utf8');
  for (const raw of ['enable daily extra', 'list extra', 'new', 'show', 'source daily stop extra', 'scheduler start', 'schedule daily', 'schedule daily 0s', 'update daily {bad}', 'update daily {"workspace":"/tmp"}']) assert.equal((await f.call(raw)).kind, 'error', raw);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(f.management.withStore(s => s.list().length), 0);
  const job = f.management.withStore(s => s.create({ triggerId: 'foreign', project: '/another', workspace: '/another', dueAt: Date.now(), payload: { text: 'hidden' } }));
  assert.doesNotMatch((await f.call('jobs')).text, /foreign/);
  assert.equal((await f.call(`cancel ${job.id}`)).kind, 'error');
  writeFileSync(join(f.home, 'triggers/foreign.json'), JSON.stringify({ id: 'foreign', workspace: '/another', ...patch }));
  assert.doesNotMatch((await f.call('list')).text, /foreign/);
  assert.equal((await f.call('enable foreign')).kind, 'error');
});
