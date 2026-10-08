import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import * as delegation from '../plugins/dscode/desktop-host.mjs';

export const inject = ['agents', 'agentPresets', 'llm', 'sessions', 'tools', 'commands', 'subagents'];
export function apply(ctx) { void run(ctx).catch(error => {
  writeFileSync(join(process.env.DSH_HOME, 'delegation-probe-error.txt'), error.stack);
  console.error(error.stack);
  if (process.env.DSCODE_DELEGATION_ELECTRON) process.send({ type: 'dscode-delegation-failed' }); else ctx.get('appExit')(1);
}); }
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_DELEGATION_PHASE, ui = !!process.env.DSCODE_DELEGATION_UI, home = process.env.DSH_HOME, handles = [];
  let modelCalls = 0, inspectForeground;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      modelCalls++;
      if (inspectForeground) await inspectForeground(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Delegation fixture ready.' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Delegation fixture ready. This response is scripted.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-delegation-fixture'], new Adapter());
  ctx.on('approval/request', (request, next) => request.toolName === 'subagent' ? Promise.resolve('allowed-once') : next(), { prepend: true });
  const make = async (id, preset, resume = false, parent) => {
    const setup = async (scope, agent) => { await ctx.agentPresets.mount(scope, preset);
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }); };
    const handle = resume ? await ctx.agents.resume({ resumeSessionId: id, setup }) : await ctx.agents.create({ sessionId: id,
      ...(parent ? { parent } : {}), meta: { cwd: realpathSync(join(home, 'workspace')), agentPreset: preset, ...(parent ? { origin: 'subagent', parentSession: parent.id } : {}) },
      agentOptions: { provider: 'desktop-delegation-fixture', model: 'fixture' }, setup });
    handles.push(handle); return handle.agent;
  };
  const agent = await make('desktop-delegation-current', 'dscode', phase !== 'generate');
  const settlements = new Map();
  const settlement = id => {
    if (!settlements.has(id)) settlements.set(id, Promise.withResolvers());
    return settlements.get(id);
  };
  agent.ctx.on('subagent/end', event => settlement(event.id).resolve());
  const settled = async id => {
    await settlement(id).promise;
    await agent.whenIdle();
    await ctx.sessions.flush(agent.session);
  };
  const other = await make('desktop-delegation-other-' + phase, 'dscode');
  const otherHandle = handles.at(-1);
  const standard = await make('desktop-delegation-standard-' + phase, 'standard');
  const child = await make('desktop-delegation-child-' + phase, 'dscode', false, agent);
  const origin = `http://127.0.0.1:${ctx.get('webServer').port}`, connection = ctx.get('connection');
  const auth = await fetch(connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const request = (sessionId = agent.id, headers = { Cookie: cookie, Origin: origin }, action = 'status') => fetch(origin + '/api/dscode-delegation', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-delegation', payload: { action, sessionId } }),
  });
  const status = async (id = agent.id) => { const response = await request(id); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value; };
  const invoke = (owner, name, args, signal = AbortSignal.timeout(30000)) => ctx.tools.execute({ name, arguments: args, agent: owner, callId: randomUUID(), signal });
  try {
    if (phase === 'generate') {
      const command = await ctx.commands.execute(agent, '/delegate Exercise the Desktop board fixture', [], AbortSignal.timeout(30000));
      assert.equal(command.result.kind, 'success', command.result.text); await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      const history = JSON.stringify(agent.session.snapshotEvents());
      assert(history.includes('Delegation board in the right sidebar')); assert(!history.includes('/delegate-dashboard'));
      assert.equal((await status()).columns.pending.length, 0);
      await invoke(agent, 'delegate_board', { action: 'add', tasks: [
        { title: 'Shared interface', child: 'base', detail: 'Own the interface; verify compatibility before dependent work.' },
        { title: 'Desktop view', child: 'view', priority: 'high', depends_on: ['base'], detail: 'Implement the view using the verified interface.' },
      ] });
      assert.deepEqual((await status()).columns.pending.map(task => task.id), ['t1', 't2']);
      assert.deepEqual((await status()).columns.pending[1].blockedBy, ['t1']);
      const launched = await invoke(agent, 'subagent', { name: 'base', description: 'Scripted board child', prompt: 'Return the scripted fixture response without modifying files.', worktree: true, run_in_background: true });
      assert.equal(launched.value?.kind, 'continuable', JSON.stringify(launched));
      await settled(launched.value.subagentId);
      const verifying = (await status()).columns.verifying;
      assert.equal(verifying.length, 1, JSON.stringify(launched)); assert(verifying[0].worktree.startsWith(realpathSync(join(home, 'workspace')) + '/'));
      await invoke(agent, 'delegate_board', { action: 'complete', task_id: 't1', verification: 'Fixture: native child settled; no file changes expected.' });
      assert.deepEqual((await status()).columns.pending[0].blockedBy, []);
      await invoke(agent, 'delegate_board', { action: 'add', tasks: [{ title: 'Foreground inspection', child: 'inspect', detail: 'Wait for a one-shot child and then verify its worktree.' }] });
      let seenRunning = false;
      inspectForeground = async ({ sessionId }) => {
        if (ctx.agents.get(sessionId)?.session.header.parentSession !== agent.id) return;
        seenRunning = (await status()).columns.running.some(task => task.child === 'inspect');
      };
      const foreground = await invoke(agent, 'subagent', { name: 'inspect', description: 'Scripted foreground child', prompt: 'Return the scripted fixture response without modifying files.', worktree: true, run_in_background: false });
      inspectForeground = undefined;
      assert.equal(foreground.value?.kind, 'foreground', JSON.stringify(foreground));
      assert(seenRunning, 'Foreground task was not shown as running during its model request');
      assert.equal(ctx.agents.get(foreground.value.runId), undefined, 'Native foreground run disposes its child before returning');
      const foregroundTask = (await status()).columns.verifying.find(task => task.child === 'inspect');
      assert(foregroundTask, 'Disposed foreground child must still be verifiable'); assert.equal(foregroundTask.worktree, foreground.value.worktree);
      await invoke(agent, 'delegate_board', { action: 'complete', task_id: foregroundTask.id, verification: 'Fixture: foreground child settled and was disposed; result and worktree inspected.' });
      await invoke(agent, 'delegate_board', { action: 'add', tasks: [{ title: 'Cancelled foreground inspection', child: 'cancel' }] });
      const cancellation = new AbortController(); let cancelledChild;
      inspectForeground = async ({ sessionId, signal }) => {
        if (ctx.agents.get(sessionId)?.session.header.parentSession !== agent.id) return;
        cancelledChild = sessionId;
        assert((await status()).columns.running.some(task => task.child === 'cancel'));
        cancellation.abort(); signal.throwIfAborted();
      };
      const cancelled = await invoke(agent, 'subagent', { name: 'cancel', description: 'Cancelled foreground child', prompt: 'Wait for fixture cancellation.', run_in_background: false }, cancellation.signal);
      inspectForeground = undefined;
      assert(cancelledChild); assert.equal(cancelled.isError, true); assert.equal(ctx.agents.get(cancelledChild), undefined);
      const cancelledTask = (await status()).columns.verifying.find(task => task.child === 'cancel');
      assert(cancelledTask, 'Cancellation must leave an accepted task available for review'); assert.equal(cancelledTask.waiting, false);
      await invoke(agent, 'delegate_board', { action: 'reopen', task_id: cancelledTask.id, reason: 'Fixture cancelled; a new run is required.', child: 'retry' });
      await invoke(agent, 'delegate_board', { action: 'add', tasks: [{ title: 'Resume named child', child: 'persist' }] });
      let asked = false;
      inspectForeground = async ({ sessionId }) => {
        const sender = ctx.agents.get(sessionId);
        if (sender?.session.header.parentSession !== agent.id) return;
        const question = await invoke(sender, 'send_message', { agent_id: '/', message: 'Fixture question: retain this waiting state until the next process replies.' });
        assert.equal(question.isError, false, JSON.stringify(question)); asked = true;
      };
      const persistent = await invoke(agent, 'subagent', { name: 'persist', description: 'Persistent named child', prompt: 'Return the scripted fixture response.', worktree: true, run_in_background: true });
      assert.equal(persistent.value?.kind, 'continuable', JSON.stringify(persistent));
      await settled(persistent.value.subagentId);
      inspectForeground = undefined; assert(asked);
      assert((await status()).columns.running.some(task => task.child === 'persist' && task.waiting));
      const catalog = await ctx.subagents.listChildren(agent.id);
      assert(catalog.some(row => row.id === persistent.value.subagentId && row.mode === 'continuable' && row.label.startsWith('/persist · ')));
      writeFileSync(join(home, 'delegation-child.json'), JSON.stringify({ childId: persistent.value.subagentId }));
    }
    await invoke(other, 'delegate_board', { action: 'add', tasks: [{ title: 'Other session only', child: 'other' }] });
    assert.equal((await status(other.id)).columns.pending[0].title, 'Other session only');
    let snapshot = await status(); assert.equal(snapshot.columns.pending[0].title, 'Desktop view');
    assert.equal(snapshot.columns.complete[0].title, 'Shared interface');
    assert(!JSON.stringify(snapshot).includes('Other session only'));
    if (phase === 'generate') {
      for (const args of [
        { action: 'update', task_id: 't2', priority: 'low', depends_on: ['missing'] },
        { action: 'reopen', task_id: 't1', reason: '' },
        { action: 'reopen', task_id: 't5', reason: '' },
      ]) {
        const rejected = await invoke(agent, 'delegate_board', args);
        assert.equal(rejected.value?.code, 'delegate_board_error', JSON.stringify(rejected));
        assert.deepEqual(await status(), snapshot, 'Rejected edit changed the displayed board');
      }
      // A successful save must not write any partially applied rejected edit.
      await invoke(agent, 'delegate_board', { action: 'update', task_id: 't2', priority: 'high' });
      assert.deepEqual(await status(), snapshot);
    }
    if (phase === 'generate') writeFileSync(join(home, 'delegation-snapshot.json'), JSON.stringify(snapshot));
    else assert.deepEqual(snapshot.columns, JSON.parse(readFileSync(join(home, 'delegation-snapshot.json'))).columns);
    if (phase === 'resume') {
      const { childId } = JSON.parse(readFileSync(join(home, 'delegation-child.json')));
      assert.equal(ctx.agents.get(childId), undefined, 'Child must be cold before named delivery');
      const rejected = await invoke(other, 'send_message', { agent_id: '/persist', message: 'This unrelated parent must not find the alias.' });
      assert.equal(rejected.isError, true); assert.equal(ctx.agents.get(childId), undefined);
      const duplicate = await invoke(agent, 'subagent', { name: 'persist', description: 'Duplicate alias must fail', prompt: 'Do not start this child.' });
      assert.equal(duplicate.isError, true); assert.equal(ctx.agents.get(childId), undefined);
      let observed = false;
      inspectForeground = async ({ sessionId }) => {
        if (sessionId !== childId) return;
        observed = (await status()).columns.running.some(task => task.child === 'persist');
      };
      const delivered = await invoke(agent, 'send_message', { agent_id: '/persist', message: 'Resume the existing named child and return the scripted fixture response.' });
      assert.equal(delivered.isError, false, JSON.stringify(delivered));
      await settled(childId); inspectForeground = undefined;
      assert(observed, 'Resumed child must update the original task'); snapshot = await status();
      assert(snapshot.columns.verifying.some(task => task.child === 'persist' && !task.waiting));
      assert.equal((await ctx.subagents.listChildren(agent.id)).filter(row => row.id === childId).length, 1, 'Named delivery must reuse the same child');
      writeFileSync(join(home, 'delegation-snapshot.json'), JSON.stringify(snapshot));
    }
    assert.equal((await request(agent.id, {})).status, 401);
    assert.equal((await request(agent.id, { Cookie: cookie, Origin: 'https://untrusted.example' })).status, 403);
    for (const id of [standard.id, child.id, 'missing']) assert.equal((await (await request(id)).json()).result.ok, false);
    assert.equal((await (await request(agent.id, undefined, 'clear')).json()).result.ok, false);
    const seq = agent.session.seq, calls = modelCalls; await status(); await status();
    assert.equal(agent.session.seq, seq); assert.equal(modelCalls, calls);
    await otherHandle.dispose(); handles.splice(handles.indexOf(otherHandle), 1);
    assert.deepEqual((await status()).columns, snapshot.columns);
    if (phase === 'unload') {
      await [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-desktop-delegation').fiber.dispose();
      assert.equal((await request()).status, 404);
      const reload = ctx.plugin(delegation); await reload; assert.deepEqual((await status()).columns, snapshot.columns); await reload.dispose();
    }
    console.log('DESKTOP_DELEGATION_PASSED ' + JSON.stringify({ phase, authenticatedRpc: true, originEnforced: true,
      simultaneousSessionIsolation: true, childAndStandardExcluded: true, noReadSideEffects: true, mutationRejected: true,
      ...(phase === 'generate' ? { desktopCommandHint: true, nativeChildWorktree: true, dependencyRelease: true, foregroundRunningAndVerification: true, foregroundCancellationAndReopen: true, rejectedBoardEditsPreserved: true } : { persistedBoard: true }),
      ...(phase === 'resume' ? { coldNamedChildResumed: true, resumedWaitingCleared: true, coldAliasReserved: true, foreignAliasRejected: true } : {}),
      ...(phase === 'unload' ? { unloadReload: true } : {}) }));
    if (ui) { console.log('DESKTOP_DELEGATION_UI_READY ' + JSON.stringify({ home, sessionId: agent.id })); return; }
  } finally { if (!ui) for (const handle of handles.reverse()) await handle.dispose(); }
  if (process.env.DSCODE_DELEGATION_ELECTRON) process.send({ type: 'dscode-delegation-shutdown' }); else ctx.get('appExit')(0);
}
