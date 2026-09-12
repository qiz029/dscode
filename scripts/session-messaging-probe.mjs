import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { discover, request, exchange } from '../plugins/session-bridge/client.mjs';
export const name = 'session-messaging-probe';
export const inject = ['agents', 'agentPresets', 'llm', 'sessions', 'tools', 'sessionCommunication'];
export function apply(ctx) { void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function until(fn) {
  for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
  throw Error('Messaging fixture timed out');
}
async function probe(ctx) {
  await ctx.get('loader').await();
  const secondary = process.env.DSCODE_MESSAGING_CHILD === '1', id = secondary ? 'messaging-b' : 'messaging-a';
  const service = ctx.sessionCommunication;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const original = secondary && !options.purpose && service.store.pending(id).find(r => r.kind === 'request' && r.envelope.text === 'REPLY_ME' && r.request_state === 'open');
      // user/message may already be confirmed; inspect the ledger independent of delivery state.
      const target = original || secondary && !options.purpose && service.store.list(id).messages.find(r => r.kind === 'request' && r.text === 'REPLY_ME' && r.requestState === 'open');
      if (target) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: 'reply_session', arguments: JSON.stringify({ request_message_id: target.id ?? target.messageId, text: 'FINAL_REPLY', idempotency_key: 'fixture-final-reply' }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Fixture ${id}` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['messaging-fixture'], new Adapter());
  const setup = async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, 'dscode');
    installModelSelection(agentCtx, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  };
  const handle = secondary && process.env.DSCODE_MESSAGING_RESUME === '1'
    ? await ctx.agents.resume({ resumeSessionId: id, agentOptions: { provider: 'messaging-fixture', model: 'fixture' }, setup })
    : await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: 'messaging-fixture', model: 'fixture' }, setup });
  const agent = handle.agent;
  await service.state(agent).ready;
  if (secondary) { console.log('MESSAGING_CHILD_READY'); return; }
  const children = [];
  const stop = async record => { if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill('SIGKILL'); await record.done; };
  ctx.effect(() => async () => { for (const child of children) await stop(child); }, 'messaging-probe.children');
  const launch = async resume => {
    const child = spawn(process.execPath, [process.env.DSCODE_MESSAGING_RUNTIME ?? join(process.cwd(), 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', process.env.DSCODE_MESSAGING_PROFILE ?? 'tui', '--patch', process.env.DSCODE_MESSAGING_PATCH], {
      cwd: process.cwd(), env: { ...process.env, DSCODE_MESSAGING_CHILD: '1', DSCODE_MESSAGING_RESUME: resume ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const r = { child, output: '', done: new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }) };
    child.stdout.on('data', b => { r.output += b; }); child.stderr.on('data', b => { r.output += b; }); children.push(r);
    await until(() => { if (child.exitCode !== null) throw Error(r.output); return r.output.includes('MESSAGING_CHILD_READY'); }); return r;
  };
  let child = await launch(false);
  const endpoint = async () => (await discover(process.env.DSH_HOME)).find(s => s.id === 'messaging-b');
  const readB = async () => request((await endpoint()).socket, { method: 'read', sessionId: 'messaging-b', limit: 500 });
  const tool = async (name, args) => {
    const result = await ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result)); return result.value;
  };
  for (const name of ['list_sessions', 'read_session', 'send_session', 'reply_session']) assert(ctx.tools.schemas(agent).some(t => t.name === name));
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Coordinate the messaging fixture' }], source: { kind: 'user' } })); await agent.whenIdle();
  const listed = await tool('list_sessions', {}); assert(listed.sessions.some(s => s.id === 'messaging-b'));
  const args = { session_id: 'messaging-b', kind: 'notify', mode: 'defer', text: 'DEFERRED_ONCE', idempotency_key: 'deferred-once' };
  const sent = await tool('send_session', args); assert.equal(sent.delivery, 'accepted', JSON.stringify(sent)); assert.equal(sent.wake, false);
  assert.equal((await tool('send_session', args)).duplicate, true);
  let snapshot = await readB(); assert.equal(snapshot.status, 'idle'); assert(!snapshot.events.some(e => e.type === 'user/message'));
  // An accepted defer persists across owner death, and resume itself must not wake it.
  await stop(child); child = await launch(true);
  snapshot = await readB(); assert.equal(snapshot.status, 'idle'); assert.equal(snapshot.mailbox.messages[0].delivery, 'accepted');
  const queued = await tool('send_session', { ...args, kind: 'request', mode: 'queue', text: 'REPLY_ME', idempotency_key: 'request-reply' });
  assert(queued.accepted, JSON.stringify(queued));
  await until(() => service.store.get(queued.messageId).request_state === 'replied').catch(async error => {
    console.error(child.output); console.error(JSON.stringify((await readB()).events.slice(-12))); throw error;
  });
  await until(() => agent.status === 'idle' && agent.session.snapshotEvents().some(e => e.type === 'user/message' && e.data.content.some(b => b.text?.includes('FINAL_REPLY'))));
  snapshot = await readB();
  assert.equal(snapshot.events.filter(e => e.type === 'user/message' && e.data.source.communicationId === sent.messageId).length, 1);
  assert.equal((await tool('send_session', args)).duplicate, true);
  // Kill after durable ledger admission but before native inbox admission; recovery must fill the gap.
  const crash = service.store.admit('messaging-b', { text: 'RECOVER_ADMISSION', requestId: 'crash-gap', kind: 'notify', mode: 'queue' }, service.state(agent).auth).row;
  await stop(child); child = await launch(true);
  await until(() => service.store.get(crash.id).delivery === 'consumed');
  snapshot = await readB(); assert.equal(snapshot.events.filter(e => e.type === 'user/message' && e.data.source.communicationId === crash.id).length, 1);
  const cancelled = await tool('send_session', { ...args, idempotency_key: 'cancel-note', text: 'CANCELLED_NOTE' });
  await service.cancel(agent, cancelled.messageId);
  await request((await endpoint()).socket, { method: 'send', sessionId: 'messaging-b', requestId: 'natural-turn', text: 'Continue naturally' });
  await until(async () => (await readB()).status === 'idle');
  snapshot = await readB(); assert(!snapshot.events.some(e => e.type === 'user/message' && e.data.source.communicationId === cancelled.messageId));
  const watch = exchange((await endpoint()).socket, { method: 'watch-mailbox', sessionId: 'messaging-b', after: 0 });
  assert.equal((await watch.next()).value.type, 'ready');
  let observedCancel = false;
  for (let n = 0; n < 50 && !observedCancel; n++) {
    const frame = (await watch.next()).value;
    observedCancel = frame.event?.type === 'cancelled' && frame.event.message_id === cancelled.messageId;
  }
  assert(observedCancel); await watch.return();

  // Crash artifact with BOTH ledger admission and a persisted native inbox entry, but no running owner.
  const pendingId = 'messaging-persisted-inbox';
  const staged = service.store.admit(pendingId, { requestId: 'native-pending', text: 'PERSISTED_INBOX', mode: 'queue' }, service.state(agent).auth).row;
  const durable = await ctx.get('sessionPersistence').create({ ...agent.session.header, id: pendingId, createdAt: Date.now(), isSeeded: false });
  await durable.append([{ type: 'agent/inbox/spliced', seq: 0, time: Date.now(), data: { target: 'next-turn', start: 0, inserted: [service.native(staged)] } }]);
  await durable.flush(); await durable.close();
  const recovered = await ctx.agents.resume({ resumeSessionId: pendingId, setup, agentOptions: { provider: 'messaging-fixture', model: 'fixture' } });
  await service.state(recovered.agent).ready; await recovered.agent.whenIdle();
  await until(() => service.store.get(staged.id).delivery === 'consumed');
  assert.equal(recovered.agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.communicationId === staged.id).length, 1);
  const dropped = service.store.admit(pendingId, { requestId: 'user-cancelled', text: 'DO_NOT_RESURRECT', mode: 'queue' }, service.state(agent).auth).row;
  recovered.agent.inbox.append('next-turn', service.native(dropped));
  recovered.agent.cancel({ kind: 'user' });
  assert.equal(service.store.get(dropped.id).delivery, 'cancelled');
  await recovered.dispose();
  const again = await ctx.agents.resume({ resumeSessionId: pendingId, setup, agentOptions: { provider: 'messaging-fixture', model: 'fixture' } });
  await service.state(again.agent).ready; assert.equal(again.agent.status, 'idle'); await again.dispose();

  // Exercise the production defer cutoff while another pre-step plugin is awaiting work.
  const entered = Promise.withResolvers(), released = Promise.withResolvers(); let hold = true;
  const unhook = ctx.on('agent/pre-step', async ({ agent: current, step }, next) => {
    if (hold && current === agent && step === 1) { hold = false; entered.resolve(); await released.promise; }
    return next();
  });
  const early = await service.receive(agent, { text: 'EARLY_NOTE', mode: 'defer', requestId: 'early-note' });
  const human = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
  agent.followup(human('Natural boundary')); await entered.promise;
  const late = await service.receive(agent, { text: 'LATE_NOTE', mode: 'defer', requestId: 'late-note' });
  released.resolve(); await agent.whenIdle();
  await until(() => service.store.get(early.messageId).delivery === 'consumed');
  assert.equal(service.store.get(late.messageId).delivery, 'accepted');
  agent.followup(human('Next boundary')); await agent.whenIdle();
  await until(() => service.store.get(late.messageId).delivery === 'consumed'); unhook();
  const readonly = await tool('read_session', { session_id: 'messaging-b', after: -1, limit: 10 }); assert(readonly.events.length);
  const titleEndpoint = (await endpoint()).socket;
  const titleRequest = { method: 'send', sessionId: 'messaging-b', requestId: 'deferred-title', mode: 'defer', kind: 'notify', text: 'title note', title: 'Deferred title' };
  assert.equal((await request(titleEndpoint, titleRequest)).title, 'Deferred title');
  await request(titleEndpoint, { ...titleRequest, requestId: 'later-title', title: 'Later title' });
  assert.equal((await request(titleEndpoint, titleRequest)).title, 'Later title');
  console.log('SESSION_MESSAGING_PROBE_PASSED: two Hosts; registered tools; defer cutoff/no-wake; crash/resume and persisted inbox; model tool reply; dedup; cancellation; mailbox watch');
  await stop(child); ctx.get('appExit')(0);
}
