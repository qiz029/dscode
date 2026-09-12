import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommunicationService } from '../plugins/session-bridge/communication.mjs';

async function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-communication-'));
  const events = [], warnings = [];
  const session = { id: 'recipient', header: { agentPreset: 'dscode' }, get seq() { return events.length; }, snapshotEvents: () => [...events] };
  const agent = { id: session.id, session, status: 'idle', cancel() {},
    inbox: { nextTurn: [], nextStep: [], remove(id) { this.nextTurn = this.nextTurn.filter(m => m.id !== id); this.nextStep = this.nextStep.filter(m => m.id !== id); } },
    followup(message) { this.inbox.nextTurn.push(message); }, steer(message) { this.inbox.nextStep.push(message); },
  };
  const ctx = { on: () => () => {}, agents: { list: () => [agent] }, sessions: { async flush() {} }, logger: { warn: message => warnings.push(message) } };
  const service = new CommunicationService(ctx, home, { path: '/fixture.sock', title: () => null });
  t.after(async () => { await service.close(); rmSync(home, { recursive: true, force: true }); });
  await service.state(agent).ready;
  const request = (key, mode = 'queue') => ({ requestId: key, text: key, mode });
  return { service, ctx, agent, events, warnings, request };
}

test('failed native flush never acknowledges delivery; retry retains one inbox identity', async t => {
  const f = await fixture(t);
  f.ctx.sessions.flush = async () => { throw Error('disk full'); };
  await assert.rejects(f.service.receive(f.agent, f.request('retry')), /disk full/);
  const id = f.agent.inbox.nextTurn[0].id;
  assert.equal(f.service.store.get(id).delivery, 'accepted');
  f.ctx.sessions.flush = async () => {};
  const result = await f.service.receive(f.agent, f.request('retry'));
  assert.equal(result.duplicate, true);
  assert.equal(result.messageId, id);
  assert.equal(result.delivery, 'admitted');
  assert.equal(f.agent.inbox.nextTurn.length, 1);
});

test('consumption waits for durability and an old owner callback cannot consume after replacement', async t => {
  const f = await fixture(t);
  const { messageId } = await f.service.receive(f.agent, f.request('receipt'));
  const state = f.service.state(f.agent);
  state.receipts.set(messageId, 1);
  const barrier = Promise.withResolvers();
  f.ctx.sessions.flush = () => barrier.promise;
  const pending = f.service.confirm(state);
  await Promise.resolve();
  assert.equal(f.service.store.get(messageId).delivery, 'admitted');
  await f.service.remove(f.agent);
  f.service.store.register(f.agent.id, '/replacement.sock');
  barrier.resolve(); await pending;
  assert.equal(f.service.store.get(messageId).delivery, 'admitted');
});

test('defer cutoff survives awaited hooks; cancellation filters claimed input before entering', async t => {
  const f = await fixture(t);
  const early = await f.service.receive(f.agent, f.request('early', 'defer'));
  f.service.observe(f.agent.session, { type: 'turn/start', data: { turn: 1 } });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const signal = new AbortController().signal;
  const pending = f.service.preStep({ agent: f.agent, messages: [], turn: 1, step: 1, signal }, async () => {
    entered.resolve(); await release.promise;
    return { kind: 'enter', messages: [] };
  });
  await entered.promise;
  const late = await f.service.receive(f.agent, f.request('late', 'defer'));
  await f.service.cancel(f.agent, early.messageId, true);
  release.resolve();
  assert.deepEqual((await pending).messages, []);
  assert.equal(f.service.store.get(early.messageId).delivery, 'cancelled');
  assert.equal(f.service.store.get(late.messageId).delivery, 'accepted');
  assert.equal(f.agent.inbox.nextTurn.length, 0);
});

test('cancelled pre-step cannot collect deferred notes and missing cutoff fails closed', async t => {
  const f = await fixture(t);
  const note = await f.service.receive(f.agent, f.request('note', 'defer'));
  const controller = new AbortController();
  f.service.observe(f.agent.session, { type: 'turn/start', data: { turn: 1 } });
  const payload = { agent: f.agent, messages: [], turn: 1, step: 1, signal: controller.signal };
  await assert.rejects(f.service.preStep(payload, async () => {
    controller.abort(); return { kind: 'enter', messages: [] };
  }), /abort/i);
  assert.equal(f.service.store.get(note.messageId).batch, null);
  await assert.rejects(f.service.preStep({ ...payload, turn: 2, signal: new AbortController().signal }, () => assert.fail('must not enter')), /cutoff/);
});

test('late disposal of a previous agent cannot unregister the replacement owner', async t => {
  const f = await fixture(t);
  await f.service.remove(f.agent);
  const replacement = { ...f.agent };
  f.service.start(replacement);
  await f.service.state(replacement).ready;
  await f.service.remove(f.agent);
  const state = f.service.state(replacement);
  assert.equal(f.service.store.authenticate(state.auth).generation, state.auth.generation);
  assert((await f.service.receive(replacement, f.request('replacement'))).accepted);
});
