import { createUserMessage, freezeMessage } from '@deepseek-ai/dsh-llm';
import { Mailbox, fail } from './mailbox.mjs';
import { discover, request as socketRequest } from './client.mjs';

const plugin = 'dscode-session-bridge';
export const communicationId = m => m?.source?.plugin === plugin ? m.source.communicationId : undefined;
export const isHuman = m => ['user', 'human'].includes(m?.source?.kind);
const eligible = a => a?.session.header.agentPreset === 'dscode' || a?.session.header.origin === 'subagent';

export class CommunicationService {
  constructor(ctx, home, bridge) {
    this.ctx = ctx; this.home = home; this.bridge = bridge; this.store = new Mailbox(home);
    this.states = new Map(); this.pending = new Set(); this.closed = false;
    this.disposers = [
      ctx.on('agent/session-start', ({ agent }) => this.start(agent)),
      ctx.on('agent/pre-step', (payload, next) => this.preStep(payload, next)),
      ctx.on('session/event', (session, event) => this.observe(session, event)),
      ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        const state = this.states.get(agent.id), id = communicationId(message);
        if (state && id && !state.requeueing && state.cancelCause?.kind !== 'disposed') this.store.cancel(state.auth, id, true);
      }),
      ctx.on('agent/disposed', ({ agent }) => this.remove(agent)),
    ];
    for (const agent of ctx.agents.list()) this.start(agent);
  }
  background(promise) {
    this.pending.add(promise);
    promise.catch(error => this.ctx.logger.warn(`Session communication: ${error.message}`)).finally(() => this.pending.delete(promise));
    return promise;
  }
  start(agent) {
    if (!eligible(agent) || this.states.has(agent.id) || this.closed) return;
    // Agent publication occurs only after the native persistence write lease is acquired.
    const auth = this.store.register(agent.id, this.bridge.path);
    const state = { agent, auth, cutoffs: new Map(), batches: new Map(), receipts: new Map(), ready: null };
    // Native disposal clears the inbox too; distinguish teardown from the user's cancellation.
    state.originalCancel = agent.cancel;
    state.cancelWrapper = (cause, options) => {
      state.cancelCause = cause;
      try { return state.originalCancel.call(agent, cause, options); } finally { state.cancelCause = null; }
    };
    agent.cancel = state.cancelWrapper;
    this.states.set(agent.id, state);
    state.ready = this.background(this.recover(state));
  }
  state(agent) {
    const state = this.states.get(agent.id);
    if (!state || state.agent !== agent) fail('target_unavailable', 'Session communication owner is not ready');
    this.store.authenticate(state.auth); return state;
  }
  async remove(agent) {
    const state = this.states.get(agent.id); if (!state) return;
    if (agent.cancel === state.cancelWrapper) agent.cancel = state.originalCancel;
    this.states.delete(agent.id); this.store.unregister(state.auth);
  }
  observe(session, event) {
    const state = this.states.get(session.id); if (!state) return;
    if (event.type === 'turn/start') {
      // Session observers cannot await or reenter append. Missing cutoffs fail closed in preStep.
      try { state.cutoffs.set(event.data.turn, this.store.freeze(state.auth)); }
      catch (error) { state.cutoffs.set(event.data.turn, error); }
    }
    if (event.type === 'user/message' && communicationId(event.data)) {
      state.receipts.set(communicationId(event.data), event.seq);
      this.background(this.confirm(state));
    }
    if (event.type === 'turn/end') {
      state.cutoffs.delete(event.data.turn); state.batches.delete(event.data.turn);
    }
  }
  native(row) {
    const e = row.envelope;
    // Identity must survive retries even when the prior native inbox insertion did not persist.
    return freezeMessage({ ...createUserMessage({ content: [{ type: 'text', text:
      `[External source: ${e.from.kind === 'session' ? `session:${e.from.sessionId}` : e.from.source}] [${e.kind}/${e.mode}]\nMessage ID: ${e.messageId}${e.inReplyTo ? `; reply to: ${e.inReplyTo}` : ''}\n${e.text}` }],
      source: { kind: 'plugin', plugin, form: 'relay', communicationId: e.messageId, requestId: e.idempotencyKey } }), id: e.messageId });
  }
  async confirm(state) {
    const receipts = [...state.receipts];
    // Let every synchronous session observer (including persistence) see the append before flushing.
    await Promise.resolve();
    await this.ctx.sessions.flush(state.agent.session);
    if (this.closed || this.states.get(state.agent.id) !== state) return;
    for (const [id, seq] of receipts) {
      this.store.transition(state.auth, id, 'consumed');
      if (state.receipts.get(id) === seq) state.receipts.delete(id);
    }
  }
  async recover(state) {
    for (const e of state.agent.session.snapshotEvents()) if (e.type === 'user/message' && communicationId(e.data)) state.receipts.set(communicationId(e.data), e.seq);
    await this.confirm(state);
    if (this.closed || this.states.get(state.agent.id) !== state) return;
    const parent = state.agent.session.header.parentSession;
    if (parent) this.store.include(state.auth, [], false, parent);
    for (const row of this.store.pending(state.agent.id)) {
      this.applyTitle(state, row);
      if (row.mode !== 'defer') await this.deliver(state, row, true);
    }
  }
  titleSeq(agent) { return agent.session.snapshotEvents().findLast(e => e.type === 'session/title')?.seq ?? -1; }
  applyTitle(state, row) {
    const e = row.envelope;
    if (e.title !== undefined && this.titleSeq(state.agent) === e.titleBaseSeq) this.ctx.sessionTitle.rename(state.agent.session, e.title);
  }
  async deliver(state, row, recovering = false) {
    this.store.authenticate(state.auth);
    row = this.store.get(row.id);
    if (!['accepted', 'admitted'].includes(row.delivery)) return;
    if (row.expires <= Date.now()) { this.store.expire(state.agent.id); return; }
    const agent = state.agent;
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(m => communicationId(m) === row.id);
    const consumed = agent.session.snapshotEvents().some(e => e.type === 'user/message' && communicationId(e.data) === row.id);
    // Claimed in this live driver: never requeue between claim and user/message append.
    const claimed = [...state.batches.values()].some(ids => ids.has(row.id));
    if (consumed) { state.receipts.set(row.id, agent.session.seq); await this.confirm(state); return; }
    if (!pending && !claimed) {
      const message = this.native(row);
      if (row.mode === 'steer') agent.steer(message); else agent.followup(message);
    } else if (recovering && pending && agent.status === 'idle') {
      // Resume does not itself wake a durable native inbox. Re-admit the same identity through its public API.
      const message = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(m => communicationId(m) === row.id);
      state.requeueing = true;
      try { agent.inbox.remove(message.id); if (row.mode === 'steer') agent.steer(message); else agent.followup(message); }
      finally { state.requeueing = false; }
    }
    await this.ctx.sessions.flush(agent.session);
    this.store.transition(state.auth, row.id, 'admitted');
  }
  async preStep({ agent, messages, turn, step, signal }, next) {
    if (!eligible(agent)) return next();
    const state = this.state(agent);
    const batch = state.batches.get(turn) ?? new Set(); state.batches.set(turn, batch);
    // Record synchronous claims before awaiting recovery or other plugins.
    for (const m of messages) if (communicationId(m)) {
      batch.add(communicationId(m)); this.store.transition(state.auth, communicationId(m), 'admitted', `${state.auth.generation}:${turn}`);
    }
    await state.ready;
    await this.confirm(state);
    signal.throwIfAborted();
    if (step === 1 && !state.cutoffs.has(turn)) fail('missing_cutoff', 'Missing turn-start mailbox cutoff');
    const cutoff = state.cutoffs.get(turn); if (cutoff instanceof Error) throw cutoff;
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    signal.throwIfAborted();
    this.store.expire(agent.id);
    const deferred = step === 1 ? this.store.deferred(state.auth, cutoff, turn) : [];
    const accepted = [];
    for (const m of decision.messages) {
      const id = communicationId(m);
      if (!id) { accepted.push(m); continue; }
      const row = this.store.get(id);
      if (!row || row.recipient !== agent.id || ['cancelled', 'expired', 'late'].includes(row.delivery)) continue;
      accepted.push(m);
    }
    for (const row of deferred) {
      if (!accepted.some(m => communicationId(m) === row.id)) accepted.push(this.native(row));
      batch.add(row.id);
    }
    const rows = accepted.map(communicationId).filter(Boolean).map(id => this.store.get(id));
    // A new request turn adopts that task's existing chains. Replies, notes and steering within a turn
    // keep the active context. No path mints a fresh budget except an authorized root input.
    const newRequest = step === 1 && messages.length > 0 && messages.every(m => communicationId(m)) &&
      rows.some(r => r.kind === 'request' && messages.some(m => communicationId(m) === r.id));
    this.store.include(state.auth, rows.flatMap(r => r.envelope.contexts), accepted.some(isHuman), agent.session.header.parentSession, newRequest);
    return { ...decision, messages: accepted };
  }
  async receive(agent, payload) {
    const state = this.state(agent); await state.ready;
    this.store.authenticate(state.auth);
    // Reply routing is checked both here and by the shared admission transaction.
    let admission;
    try { admission = this.store.admit(agent.id, { ...payload, titleBaseSeq: this.titleSeq(agent) }, payload.auth); }
    catch (error) { this.store.refusal(agent.id, error.code === 'invalid_sender' ? null : payload.auth?.sessionId, error.code ?? 'invalid_request'); throw error; }
    const { row, duplicate } = admission;
    this.applyTitle(state, row);
    if (row.mode !== 'defer' && row.delivery !== 'late') await this.deliver(state, row);
    else if (row.envelope.title !== undefined) await this.ctx.sessions.flush(agent.session);
    const current = this.store.get(row.id);
    return { accepted: true, duplicate, sessionId: agent.id, title: this.bridge.title(agent.session), requestId: row.envelope.idempotencyKey,
      messageId: row.id, mode: row.mode, delivery: current.delivery, wake: !duplicate && row.mode !== 'defer' && !['late', 'cancelled', 'expired'].includes(current.delivery),
      requestState: current.request_state };
  }
  async send(agent, args, reply = false) {
    if (agent.session.header.origin === 'subagent') fail('root_session_required', 'Cross-session requests and replies belong to the root session; report this to your parent agent.');
    const state = this.state(agent); await state.ready;
    let destination = args.session_id, kind = args.kind, inReplyTo = args.in_reply_to;
    if (reply) {
      const original = this.store.get(args.request_message_id);
      if (!original || original.envelope.from.kind !== 'session') fail('invalid_reply', 'Request has no session reply address');
      destination = original.envelope.from.sessionId; kind = 'reply'; inReplyTo = original.id;
    }
    const endpoints = (await discover(this.home)).filter(s => s.id === destination);
    if (endpoints.length !== 1) fail('target_unavailable', 'Target must be one active root session with this exact ID');
    return socketRequest(endpoints[0].socket, { method: 'send', sessionId: destination, text: args.text, kind,
      mode: args.mode ?? 'queue', requestId: args.idempotency_key, inReplyTo, auth: state.auth });
  }
  async cancel(agent, id, human = false) {
    const state = this.state(agent), result = this.store.cancel(state.auth, id, human);
    // The target filters again at pre-step, including across Hosts. Remove locally pending entries too.
    const target = this.states.get(result.toSessionId);
    if (target) for (const m of [...target.agent.inbox.nextTurn, ...target.agent.inbox.nextStep]) if (communicationId(m) === id) target.agent.inbox.remove(m.id);
    return result;
  }
  newTask(agent) {
    if (agent.status !== 'idle') fail('session_busy', 'Start a new task when the session is idle');
    return this.store.newTask(this.state(agent).auth).map(c => c.chainId);
  }
  async close() {
    this.closed = true; this.disposers.forEach(d => d());
    await Promise.allSettled([...this.pending]);
    for (const s of this.states.values()) {
      if (s.agent.cancel === s.cancelWrapper) s.agent.cancel = s.originalCancel;
      this.store.unregister(s.auth);
    }
    this.states.clear(); this.store.close();
  }
}
