import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerTriggerTools } from '../plugins/triggers/tools.mjs';
import { loadTriggerDefinitions } from '../plugins/triggers/config.mjs';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { acquireTriggerLease } from '../plugins/triggers/lease.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-trigger-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'state'), workspace = join(root, 'project');
  mkdirSync(workspace);
  const agent = { session: { header: { cwd: workspace, delegationDepth: 0 } } };
  const tools = new Map();
  let gate;
  const state = { permission: 'auto', plan: { active: false }, time: Date.UTC(2026, 8, 22, 6) };
  const ctx = { tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} },
    on: (_name, handler) => { gate = handler; }, get: () => ({ get: () => state.plan }), permissionPresets: { current: () => state.permission } };
  const serviceCalls = [];
  registerTriggerTools(ctx, { home, dscodePath: process.execPath, platform: 'darwin', now: () => state.time,
    service: async (action, options) => { serviceCalls.push({ action, path: options.dscodePath, home: options.home }); options.out('installed fixture'); } });
  const call = (name, args, actor = agent) => tools.get(name).execute(args, { agent: actor });
  const decide = (name, action, decision = { kind: 'allow' }) => gate({ name, arguments: { action }, agent }, async () => decision);
  return { home, workspace, agent, tools, state, serviceCalls, call, decide };
}
const definition = { prompt: 'Review the project', source: { kind: 'calendar', cron: '0 9 * * 1-5', timezone: 'America/Los_Angeles' }, goal: { objective: 'Report findings', maxRounds: 3 }, session: { mode: 'persistent' }, permission: 'read-only' };
const create = f => f.call('trigger_manage', { action: 'create', trigger_id: 'daily', definition });

test('agent tools create, edit and disable a cron definition shared with the CLI', async t => {
  const f = fixture(t);
  const created = await create(f);
  assert.equal(created.error, undefined);
  assert.equal(created.definition.workspace, f.workspace);
  assert.equal(created.scheduler.running, false);
  assert.match(created.scheduler.next_step, /trigger_scheduler/);
  assert.equal(loadTriggerDefinitions({ home: f.home, workspace: f.workspace }).definitions[0].session.mode, 'persistent');
  const store = new JobStore(f.home);
  t.after(() => store.close());
  assert.equal(store.schedules().length, 1);
  assert.equal((await f.call('trigger_manage', { action: 'update', trigger_id: 'daily', definition: { source: { kind: 'interval', seconds: 600 }, session: { mode: 'new' } } })).definition.overlap, 'skip');
  assert.equal(JSON.parse(store.schedules()[0].source).seconds, 600);
  await f.call('trigger_manage', { action: 'disable', trigger_id: 'daily' });
  assert.equal(loadTriggerDefinitions({ home: f.home, workspace: f.workspace }).definitions[0].enabled, false);
  await f.call('trigger_manage', { action: 'enable', trigger_id: 'daily' });
  assert.equal((await f.call('trigger_manage', { action: 'get', trigger_id: 'daily' })).definition.enabled, true);
  assert.equal((await f.call('trigger_manage', { action: 'list' })).schedules.length, 1);
  await f.call('trigger_manage', { action: 'unregister', trigger_id: 'daily' });
  assert.equal(store.schedules().length, 0);
  await f.call('trigger_manage', { action: 'register', trigger_id: 'daily' });
  assert.equal(store.schedules().length, 1);
});

test('delay-job retries keep one durable job and original due time, even after it is due', async t => {
  const f = fixture(t);
  await create(f);
  const args = { action: 'schedule', trigger_id: 'daily', after: '10m', event: { text: 'Check deployment' }, idempotency_key: 'deploy-1' };
  const first = await f.call('trigger_jobs', args);
  assert.equal(first.error, undefined);
  f.state.time += 3600000;
  const retry = await f.call('trigger_jobs', args);
  assert.equal(retry.job.id, first.job.id);
  assert.equal(retry.job.dueAt, first.job.dueAt);
  const conflict = await f.call('trigger_jobs', { ...args, after: '20m' });
  assert.match(conflict.error, /different job request/);
  assert.equal((await f.call('trigger_jobs', { action: 'list' })).jobs.length, 1);
  assert.equal((await f.call('trigger_jobs', { action: 'cancel', job_id: first.job.id })).job.state, 'cancelled');
  assert.equal((await f.call('trigger_jobs', { action: 'cancel', job_id: first.job.id })).job.state, 'cancelled');
  assert.equal((await f.call('trigger_jobs', args)).job.state, 'cancelled', 'retry never resurrects a cancelled job');
  const at = new Date(f.state.time + 1000).toISOString();
  const absoluteArgs = { action: 'schedule', trigger_id: 'daily', at, idempotency_key: 'absolute' };
  const absolute = await f.call('trigger_jobs', absoluteArgs);
  f.state.time += 2000;
  assert.equal((await f.call('trigger_jobs', absoluteArgs)).job.id, absolute.job.id);
});

test('invalid schedules and privileged definitions are refused before mutation', async t => {
  const f = fixture(t);
  const invalid = await f.call('trigger_manage', { action: 'create', trigger_id: 'bad', definition: { ...definition, source: { kind: 'calendar', cron: 'bad' } } });
  assert.match(invalid.error, /five fields/);
  assert.equal(loadTriggerDefinitions({ workspace: f.workspace }).definitions.length, 0);
  await create(f);
  const original = readFileSync(join(f.workspace, '.dsh/triggers/daily.yml'), 'utf8');
  const badUpdate = await f.call('trigger_manage', { action: 'update', trigger_id: 'daily', definition: { goal: { objective: '' } } });
  assert.match(badUpdate.error, /non-empty/);
  assert.equal(readFileSync(join(f.workspace, '.dsh/triggers/daily.yml'), 'utf8'), original);
  for (const args of [{ after: 'soon' }, { after: '1h', at: '2026-09-23T00:00:00Z' }, { after: '0s' }]) {
    assert((await f.call('trigger_jobs', { action: 'schedule', trigger_id: 'daily', idempotency_key: 'invalid', ...args })).error);
  }
  writeFileSync(join(f.workspace, '.dsh/triggers/danger.json'), JSON.stringify({ ...definition, id: 'danger', workspace: f.workspace, permission: 'danger-full-access' }));
  assert.match((await f.call('trigger_jobs', { action: 'schedule', trigger_id: 'danger', after: '1m', idempotency_key: 'danger' })).error, /permission/);
  assert.equal((await f.call('trigger_jobs', { action: 'list' })).jobs.length, 0);
});

test('tool mutations respect approval, plan/read-only modes and unattended/subagent boundaries', async t => {
  const f = fixture(t);
  assert.equal((await f.decide('trigger_manage', 'create')).kind, 'ask');
  assert.equal((await f.decide('trigger_manage', 'list')).kind, 'allow');
  assert.equal((await f.decide('trigger_jobs', 'schedule', { kind: 'deny', reason: 'prior denial' })).kind, 'deny');
  f.state.permission = 'read-only';
  assert.equal((await f.decide('trigger_jobs', 'schedule')).kind, 'deny');
  assert.match((await create(f)).error, /writable/);
  f.state.permission = 'auto'; f.state.plan = { active: false, pending: true };
  assert.match((await create(f)).error, /plan mode/);
  f.state.plan = { active: false }; f.agent.session.header.delegationDepth = 1;
  assert.match((await create(f)).error, /subagents/);
  f.agent.session.header.delegationDepth = 0;
  const previous = process.env.DSCODE_TRIGGER_OPTIONS;
  process.env.DSCODE_TRIGGER_OPTIONS = '/test/spec';
  try { assert.match((await create(f)).error, /Unattended/); }
  finally { if (previous === undefined) delete process.env.DSCODE_TRIGGER_OPTIONS; else process.env.DSCODE_TRIGGER_OPTIONS = previous; }
});

test('workspace isolation and symlinks cannot redirect management to another project', async t => {
  const f = fixture(t);
  await create(f);
  const other = join(f.workspace, 'other'); mkdirSync(other);
  const store = new JobStore(f.home); t.after(() => store.close());
  const foreign = store.create({ triggerId: 'daily', project: other, workspace: other, dueAt: f.state.time + 5000 });
  assert.equal((await f.call('trigger_jobs', { action: 'list' })).jobs.length, 0);
  assert.match((await f.call('trigger_jobs', { action: 'cancel', job_id: foreign.id })).error, /No job/);
  const path = join(f.workspace, '.dsh/triggers/daily.yml');
  const target = join(other, 'target'); writeFileSync(target, readFileSync(path)); rmSync(path); symlinkSync(target, path);
  const before = readFileSync(target, 'utf8');
  assert.match((await f.call('trigger_manage', { action: 'disable', trigger_id: 'daily' })).error, /regular project-local/);
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('scheduler tools use the owning launcher and report actual liveness', async t => {
  const f = fixture(t);
  assert.equal((await f.call('trigger_scheduler', { action: 'status' })).running, false);
  const lease = await acquireTriggerLease(f.home, '_scheduler');
  try { assert.equal((await f.call('trigger_scheduler', { action: 'status' })).running, true); }
  finally { lease.release(); }
  assert.equal((await f.decide('trigger_scheduler', 'install')).kind, 'ask');
  const installed = await f.call('trigger_scheduler', { action: 'install' });
  assert.equal(installed.scheduler.running, false, 'install acknowledgement alone is not proof of a running service');
  assert.deepEqual(f.serviceCalls, [{ action: 'install', path: process.execPath, home: f.home }]);
});

test('agent script source tools share durable controls and the existing approval boundary', async t => {
  const f = fixture(t);
  const created = await f.call('trigger_manage', { action: 'create', trigger_id: 'watcher', definition: { ...definition, source: { kind: 'script', mode: 'daemon', command: ['python3', '.dsh/scripts/watch.py'] } } });
  assert.equal(created.error, undefined);
  assert.equal(created.definition.source.permission, 'read-only');
  const args = { trigger_id: 'watcher' };
  assert.equal((await f.call('trigger_source', { ...args, action: 'status' })).source.desired, 'running');
  assert.equal((await f.decide('trigger_source', 'stop')).kind, 'ask');
  assert.equal((await f.decide('trigger_source', 'logs')).kind, 'allow');
  assert.equal((await f.call('trigger_source', { ...args, action: 'stop' })).source.desired, 'stopped');
  assert.equal((await f.call('trigger_source', { ...args, action: 'restart' })).source.revision, 1);
  assert.equal((await f.call('trigger_source', { ...args, action: 'logs' })).log, '');
  f.state.permission = 'read-only';
  assert.equal((await f.decide('trigger_source', 'start')).kind, 'deny');
  assert.match((await f.call('trigger_source', { ...args, action: 'restart' })).error, /writable/);
  assert.equal((await f.call('trigger_source', { ...args, action: 'status' })).error, undefined);
  f.state.permission = 'auto';
  await f.call('trigger_manage', { action: 'update', trigger_id: 'watcher', definition: { source: { kind: 'external' } } });
  const store = new JobStore(f.home);
  try { assert.equal(store.sources().length, 0); } finally { store.close(); }
});
