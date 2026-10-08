import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { markUnattended } from '../plugins/triggers/unattended.mjs';

export const inject = ['agents', 'agentPresets', 'permissionPresets', 'llm', 'tools', 'goals', 'jobs', 'commands', 'connection', 'webServer'];
export function apply(ctx) { void run(ctx).catch(error => {
  console.error(error.stack);
  if (process.env.DSCODE_SCHEDULER_ELECTRON) process.send({ type: 'dscode-scheduler-failed' });
  else ctx.get('appExit')(1);
}); }
async function run(ctx) {
  const calls = new Map(), requestedTools = [], toolResults = [];
  let expectTriggerTools = true;
  ctx.on('tools/result', (exec, result) => { if (exec.agent.id === 'management-interactive') toolResults.push({ name: exec.name, result }); });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const agent = ctx.agents.currentInitiator(), goal = ctx.goals.get(agent);
      assert.equal(options.tools.some(tool => tool.name === 'trigger_manage'), expectTriggerTools);
      if (agent.id === 'management-interactive' && requestedTools.length) {
        const [name, args] = requestedTools.shift();
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      if (goal?.phase === 'active') {
        const count = (calls.get(goal.id) ?? 0) + 1; calls.set(goal.id, count);
        if (count >= 2) ctx.goals.complete(agent, { id: goal.id, revision: goal.revision });
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DESKTOP_MANAGEMENT_OK' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  // Register before the persisted scheduler's loader barrier opens on reload.
  ctx.llm.registerAdapter(['desktop-management-fixture'], new Adapter());
  await ctx.get('loader').await();
  const { control } = ctx.get('dscodeTriggers');
  await control.ready;
  const home = process.env.DSH_HOME, phase = process.env.DSCODE_SCHEDULER_PHASE, project = process.cwd();
  const store = new JobStore(home), snapshotPath = join(home, 'management-probe.json');
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const auth = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const rpc = (payload, headers = { Cookie: cookie, Origin: origin }) => fetch(origin + '/api/dscode-triggers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-triggers', payload }),
  });
  const request = async payload => {
    const response = await rpc(payload); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value;
  };
  const wait = async predicate => {
    const until = Date.now() + 20000;
    while (!predicate()) { assert(Date.now() < until, JSON.stringify(store.list())); await delay(25); }
  };
  let handle, other;
  try {
    assert([401, 403].includes((await rpc({ action: 'status' }, {})).status));
    assert([401, 403].includes((await rpc({ action: 'start' }, { Cookie: cookie, Origin: 'https://untrusted.example' })).status));
    if (phase === 'configure') {
      assert.equal((await request({ action: 'status' })).scheduler.enabled, false);
      handle = await ctx.agents.create({ sessionId: 'management-interactive', meta: { cwd: project, agentPreset: 'dscode' },
        agentOptions: { provider: 'desktop-management-fixture', model: 'fixture' }, setup: async (scope, agent) => {
          await ctx.agentPresets.mount(scope, 'dscode');
          installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
        } });
      const agent = handle.agent, sessionId = agent.id;
      ctx.permissionPresets.set(agent.session, 'workspace-write');
      const slash = async text => (await ctx.commands.execute(agent, text, [], new AbortController().signal)).result;
      assert.match((await slash('/trigger help')).text, /status \| start \| stop/);
      assert.equal((await slash('/trigger scheduler install')).kind, 'error');
      const definition = { prompt: 'Perform the scheduled check', source: { kind: 'external' }, model: 'desktop-management-fixture/fixture',
        goal: { objective: 'Complete the scheduled check', maxRounds: 3 }, session: { mode: 'persistent' }, limits: { timeoutSeconds: 15, minIntervalSeconds: 1 } };
      const created = await request({ action: 'manage', sessionId, args: { action: 'create', trigger_id: 'desktop-managed', definition } });
      assert.equal(created.definition.workspace, project);
      assert.equal((await request({ action: 'workspace', sessionId })).definitions.length, 1);
      ctx.permissionPresets.set(agent.session, 'read-only');
      assert.equal((await (await rpc({ action: 'manage', sessionId, args: { action: 'disable', trigger_id: 'desktop-managed' } })).json()).result.ok, false);
      assert.equal((await slash('/trigger scheduler start')).kind, 'error');
      ctx.permissionPresets.set(agent.session, 'workspace-write');
      let approvals = 0;
      ctx.on('approval/request', (request, next) => {
        if (!request.toolName.startsWith('trigger_')) return next();
        approvals++; return Promise.resolve('allowed-once');
      }, { prepend: true });
      const tool = (name, args, actor = agent) => ctx.tools.execute({ name, arguments: args, agent: actor, callId: randomUUID(), signal: new AbortController().signal });
      const unmark = markUnattended(agent);
      assert((await tool('trigger_scheduler', { action: 'start' })).isError); unmark();
      const job = (await request({ action: 'jobs', sessionId, args: { action: 'schedule', trigger_id: 'desktop-managed', after: '1s', idempotency_key: 'first-ui-job' } })).job;
      const cancelled = (await request({ action: 'jobs', sessionId, args: { action: 'schedule', trigger_id: 'desktop-managed', after: '1h', idempotency_key: 'cancel-ui-job' } })).job;
      await request({ action: 'jobs', sessionId, args: { action: 'cancel', job_id: cancelled.id } });
      const elsewhere = join(home, 'other'); mkdirSync(elsewhere);
      other = await ctx.agents.create({ sessionId: 'other-workspace', meta: { cwd: elsewhere, agentPreset: 'dscode' },
        agentOptions: { provider: 'desktop-management-fixture', model: 'fixture' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'dscode'); } });
      const foreign = (await (await rpc({ action: 'jobs', sessionId: other.agent.id, args: { action: 'cancel', job_id: job.id } })).json()).result;
      assert.equal(foreign.ok, false); assert.match(foreign.error.message, /No job in this workspace/);
      requestedTools.push(['trigger_scheduler', { action: 'start' }]);
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Enable the fixture scheduler and resume on launch.' }] }));
      await agent.whenIdle();
      const started = toolResults.findLast(row => row.name === 'trigger_scheduler')?.result;
      assert(started, 'The Agent did not execute the scheduler tool');
      assert(!started.isError && !started.value?.error, JSON.stringify(started)); assert(approvals > 0);
      const unmarkAgain = markUnattended(agent);
      const killed = await tool('job_kill', { job_id: control.owner.status().job_id });
      assert(killed.isError); unmarkAgain(); assert(control.owner.status().running);
      await wait(() => ['completed', 'failed'].includes(store.get(job.id).state));
      assert.equal(store.get(job.id).state, 'completed', JSON.stringify(store.get(job.id)));
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Verify interactive session remains usable.' }] }));
      await agent.whenIdle();
      assert(agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === 'DESKTOP_MANAGEMENT_OK')));
      await request({ action: 'stop' });
      // Queue before enabling so the next Host proves persisted admission. This
      // run is far enough in the future to avoid racing the current Host exit.
      const next = store.create({ triggerId: 'desktop-managed', project, workspace: project, dueAt: Date.now() + 3000 });
      writeFileSync(snapshotPath, JSON.stringify({ next: next.id, firstSession: store.get(job.id).sessionId }));
      await request({ action: 'start' });
    } else if (phase === 'resume') {
      const saved = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      assert.equal((await request({ action: 'status' })).scheduler.enabled, true);
      await wait(() => ['completed', 'failed'].includes(store.get(saved.next).state));
      assert.equal(store.get(saved.next).state, 'completed', JSON.stringify(store.get(saved.next)));
      assert.equal(store.get(saved.next).sessionId, saved.firstSession);
      await request({ action: 'stop' });
      const pending = store.create({ triggerId: 'desktop-managed', project, workspace: project, dueAt: Date.now() });
      writeFileSync(snapshotPath, JSON.stringify({ ...saved, pending: pending.id }));
    } else if (phase === 'disabled') {
      const saved = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      const status = await request({ action: 'status' });
      assert.equal(status.scheduler.enabled, false); assert.equal(status.scheduler.running, false);
      assert.equal(store.get(saved.pending).state, 'pending');
      store.cancel(saved.pending);
      handle = await ctx.agents.create({ sessionId: 'unload-interactive', meta: { cwd: project, agentPreset: 'dscode' },
        agentOptions: { provider: 'desktop-management-fixture', model: 'fixture' }, setup: async (scope, agent) => {
          await ctx.agentPresets.mount(scope, 'dscode');
          installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
        } });
      await request({ action: 'start' });
      const nativeJob = control.owner.status().job_id;
      const entry = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-desktop-triggers');
      assert(entry?.fiber, 'Mounted scheduling plugin has no owned fiber');
      await entry.fiber.dispose();
      expectTriggerTools = false;
      assert.equal(control.closed, true);
      assert.equal((await ctx.jobs.wait(nativeJob, 20000)).status, 'killed');
      assert.equal(ctx.get('dscodeTriggers'), undefined);
      assert.equal((await rpc({ action: 'status' })).status, 404);
      const removed = await ctx.tools.execute({ name: 'trigger_scheduler', arguments: { action: 'status' }, agent: handle.agent, callId: randomUUID(), signal: new AbortController().signal });
      assert(removed.isError, 'Unloaded scheduling tools remained callable');
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after scheduling plugin removal.' }] }));
      await handle.agent.whenIdle();
      assert(handle.agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === 'DESKTOP_MANAGEMENT_OK')));
    } else throw Error(`Unexpected management phase ${phase}`);
    console.log('DESKTOP_SCHEDULER_PASSED ' + JSON.stringify({ phase, mountedManagement: true, authenticatedRpc: true, workspaceIsolation: true,
      persistedExplicitActivation: true, ...(phase === 'disabled' ? { pluginUnloadRemovesToolsAndRpc: true, interactiveSessionSurvives: true } : {}), liveModelInference: false }));
  } finally { await other?.dispose(); await handle?.dispose(); store.close(); }
  if (process.env.DSCODE_SCHEDULER_ELECTRON) process.send({ type: 'dscode-scheduler-shutdown' });
  else ctx.get('appExit')(0);
}
