import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { JobStore } from '../plugins/triggers/jobs.mjs';
export const name = 'trigger-tools-probe';
export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'permissionPresets', 'commands'];
export function apply(ctx) { void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function probe(ctx) {
  await ctx.get('loader').await();
  let calls = 0, approvals = 0, jobId;
  const results = [];
  ctx.on('approval/request', (req, next) => {
    if (!['trigger_manage', 'trigger_jobs', 'trigger_source'].includes(req.toolName)) return next();
    approvals++;
    return Promise.resolve('allowed-once');
  }, { prepend: true });
  ctx.on('tools/result', (exec, result) => {
    if (!exec.name.startsWith('trigger_')) return;
    results.push(result);
    if (exec.name === 'trigger_jobs' && exec.arguments.action === 'schedule') jobId = result.value?.job?.id;
  });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      if (!options.purpose) {
        for (const name of ['trigger_manage', 'trigger_jobs', 'trigger_scheduler', 'trigger_source']) assert(options.tools.some(t => t.name === name), `missing tool ${name}`);
        const steps = [
          ['trigger_manage', { action: 'create', trigger_id: 'fixture', definition: { prompt: 'Check the build', source: { kind: 'calendar', cron: '0 9 * * *', timezone: 'UTC' }, goal: { objective: 'Report the build status', maxRounds: 2 } } }],
          ['trigger_jobs', { action: 'schedule', trigger_id: 'fixture', after: '1h', idempotency_key: 'fixture-delay' }],
          ['trigger_jobs', { action: 'cancel', job_id: jobId }],
          ['trigger_manage', { action: 'create', trigger_id: 'watcher', definition: { prompt: 'Inspect changed build', source: { kind: 'script', mode: 'daemon', command: ['python3', '.dsh/scripts/watch.py'] }, goal: { objective: 'Report changed build', maxRounds: 2 } } }],
          ['trigger_source', { action: 'status', trigger_id: 'watcher' }],
          ['trigger_source', { action: 'stop', trigger_id: 'watcher' }],
          ['trigger_source', { action: 'logs', trigger_id: 'watcher' }],
          ['trigger_source', { action: 'restart', trigger_id: 'watcher' }],
          ['trigger_scheduler', { action: 'status' }],
        ];
        const step = steps[calls++];
        if (step) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `fixture-${calls}`, name: step[0], arguments: JSON.stringify(step[1]) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Finished managing the fixture jobs.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['trigger-tools-fixture'], new Adapter());
  const { agent } = await ctx.agents.create({ sessionId: 'trigger-tools-fixture-session', meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: 'trigger-tools-fixture', model: 'fixture' }, setup: async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, 'dscode');
    installModelSelection(agentCtx, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  } });
  ctx.permissionPresets.set(agent.session, 'workspace-write');
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create the fixture cron, schedule and cancel a delayed job, then inspect scheduler status.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(results.length, 9, JSON.stringify(results));
  assert(results.every(r => !r.isError && !r.value?.error), JSON.stringify(results));
  assert.equal(approvals, 6);
  assert.equal(results.at(-1).value.running, false);
  const store = new JobStore(process.env.DSH_HOME);
  try { assert.equal(store.schedules().length, 1); assert.equal(store.get(jobId).state, 'cancelled'); assert.equal(store.sources()[0].desired, 'running'); assert.equal(store.sources()[0].revision, 1); }
  finally { store.close(); }
  const beforeSlash = calls;
  const slash = async text => (await ctx.commands.execute(agent, text, [], new AbortController().signal)).result;
  for (const text of ['/trigger new tui-fixture', '/trigger enable tui-fixture', '/trigger schedule tui-fixture 1h TUI_DELAY_MARKER', '/trigger run tui-fixture TUI_EVENT_MARKER', '/trigger source watcher stop']) {
    const result = await slash(text);
    assert.equal(result.kind, 'success', JSON.stringify(result));
  }
  assert.match((await slash('/triggers show tui-fixture')).text, /tui-fixture/);
  assert.match((await slash('/trigger jobs tui-fixture')).text, /pending/);
  const slashStore = new JobStore(process.env.DSH_HOME);
  try {
    assert.equal(slashStore.list('tui-fixture').length, 2);
    const delayed = slashStore.list('tui-fixture').find(j => j.kind === 'delay');
    assert.equal((await slash(`/trigger cancel ${delayed.id}`)).kind, 'success');
    assert.equal(slashStore.get(delayed.id).state, 'cancelled');
    assert.equal(slashStore.sources()[0].desired, 'stopped');
  } finally { slashStore.close(); }
  assert.equal(calls, beforeSlash, 'slash management does not invoke the model');
  ctx.permissionPresets.set(agent.session, 'read-only');
  const denied = await ctx.tools.execute({ name: 'trigger_manage', arguments: { action: 'disable', trigger_id: 'fixture' }, agent, callId: 'deny-fixture', signal: new AbortController().signal });
  assert.equal(denied.isError, true);
  assert.equal((await slash('/trigger enable tui-fixture')).kind, 'error');
  assert.equal((await slash('/trigger show tui-fixture')).kind, 'success');
  console.log('TRIGGER_TOOLS_PROBE_PASSED');
  ctx.get('appExit')(0);
}
