import { createServer } from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { normalizeSessionTitle } from '@deepseek-ai/dsh-session-title';
import { ensureSocketDirectory } from './paths.mjs';
import { producerKind } from '../message-source/kind.mjs';

export const BRIDGE_SOURCE = 'dscode-session-bridge';
const MAX_REQUEST = 128 * 1024, MAX_BUFFER = 8 * 1024 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
const eligible = agent => agent?.session.header.agentPreset === 'dscode' && agent.session.header.origin !== 'subagent';

export class SessionBridge {
  constructor(ctx, home) {
    this.ctx = ctx; this.home = home; this.clients = new Set(); this.followers = new Map(); this.receipts = new WeakMap();
    this.server = createServer(socket => this.connect(socket));
    this.disposeEvents = ctx.on('session/event', (session, event) => {
      for (const follow of this.followers.get(session.id) ?? []) follow(event);
    });
    this.disposeSessions = ctx.on('session/disposed', session => {
      for (const follow of this.followers.get(session.id) ?? []) follow(null);
    });
  }
  async start() {
    this.path = join(ensureSocketDirectory(this.home), `${process.pid}-${randomUUID().slice(0, 8)}.sock`);
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.path, resolve); });
    chmodSync(this.path, 0o600);
    return this;
  }
  agent(id) {
    const agent = this.ctx.agents.get(id);
    if (!eligible(agent)) throw Error('Session is not active in this Host; open it in dscode first');
    return agent;
  }
  title(session) { return this.ctx.sessionTitle.get(session)?.title ?? null; }
  card(session) { return this.ctx.sessionCards?.get(session) ?? {}; }
  list() { return this.ctx.agents.list().filter(eligible).map(a => ({ id: a.session.id, title: this.title(a.session), cwd: a.session.header.cwd, status: a.status, pid: process.pid, ...this.card(a.session), ...(this.communication ? { mailbox: this.communication.store.counts(a.id) } : {}) })); }
  snapshot(agent, after = -1, limit = 100) {
    if (!Number.isSafeInteger(after) || after < -1 || after >= agent.session.seq && after !== -1) throw Error('Invalid event cursor');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw Error('Limit must be 1..500');
    const session = agent.session, head = session.seq - 1;
    const events = session.snapshotEvents(after + 1, Math.min(session.seq, after + 1 + limit));
    return { sessionId: session.id, title: this.title(session), header: session.header, status: agent.status, head, ...this.card(session),
      cursor: events.at(-1)?.seq ?? after, events,
      ...(this.communication ? { mailbox: this.communication.store.list(agent.id) } : {}),
      inbox: { nextTurn: [...agent.inbox.nextTurn], nextStep: [...agent.inbox.nextStep] } };
  }
  receipt(session, key) {
    let cache = this.receipts.get(session);
    if (!cache) { cache = { seq: 0, values: new Map() }; this.receipts.set(session, cache); }
    for (const event of session.snapshotEvents(cache.seq)) {
      const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted : event.type === 'user/message' ? [event.data] : [];
      for (const message of messages) if (producerKind(message.source) === BRIDGE_SOURCE && message.source.requestId) {
        cache.values.set(message.source.requestId, { digest: message.source.digest, messageId: message.id });
      }
    }
    cache.seq = session.seq;
    return cache.values.get(key);
  }
  async send(agent, request) {
    if (this.communication) {
      if (request.title !== undefined && (typeof request.title !== 'string' || Buffer.byteLength(request.title) > 4096 || !normalizeSessionTitle(request.title, 4096))) throw Error('Title must contain visible text, at most 4096 bytes');
      // Preserve retries of messages admitted before the communication ledger existed.
      const legacy = !request.auth && request.requestId && this.receipt(agent.session, request.requestId);
      if (legacy?.digest) {
        const digest = hash(JSON.stringify({ text: request.text, source: request.source ?? 'cli', mode: request.mode ?? 'queue', title: request.title }));
        if (legacy.digest !== digest) throw Error('requestId already belongs to a different message');
        return { accepted: true, duplicate: true, sessionId: agent.id, title: this.title(agent.session), requestId: request.requestId, messageId: legacy.messageId, mode: request.mode ?? 'queue' };
      }
      return this.communication.receive(agent, { ...request, requestId: request.requestId ?? randomUUID() });
    }
    const { text, title, source = 'cli', requestId = randomUUID(), mode = 'queue' } = request;
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64000) throw Error('Text must contain 1..64000 bytes');
    if (typeof source !== 'string' || !/^[\p{L}\p{N}_.:@/-]{1,64}$/u.test(source)) throw Error('Invalid source label');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) throw Error('Invalid requestId');
    if (!['queue', 'steer'].includes(mode)) throw Error('Mode must be queue or steer');
    if (title !== undefined && (typeof title !== 'string' || Buffer.byteLength(title) > 4096 || !normalizeSessionTitle(title, 4096))) throw Error('Title must contain visible text, at most 4096 bytes');
    const digest = hash(JSON.stringify({ text, source, mode, title }));
    const previous = this.receipt(agent.session, requestId);
    if (previous && previous.digest !== digest) throw Error('requestId already belongs to a different message');
    let messageId = previous?.messageId;
    if (!previous) {
      const message = createUserMessage({ content: [{ type: 'text', text: `[External source: ${source}]\n${text}` }],
        source: { kind: BRIDGE_SOURCE, form: 'relay', requestId, digest, label: source, mode } });
      // Explicit naming uses the native title service, including sanitization,
      // persistence, UI events and cancellation of stale automatic title work.
      // A duplicate request must never undo a newer title.
      if (title !== undefined) this.ctx.sessionTitle.rename(agent.session, title);
      // No await between deduplication and inbox admission. The native Agent
      // serializes state and wakes exactly one driver; long work holds no lock.
      if (mode === 'steer') agent.steer(message); else agent.followup(message);
      messageId = message.id;
    }
    // Accepted means the native durable inbox passed its flush barrier, not
    // that the model has completed the request. Retrying the same ID is safe.
    await this.ctx.sessions.flush(agent.session);
    return { accepted: true, duplicate: !!previous, sessionId: agent.session.id, title: this.title(agent.session), requestId, messageId, mode };
  }
  connect(socket) {
    this.clients.add(socket); socket.setEncoding('utf8'); socket.setTimeout(10000, () => socket.destroy());
    let input = '', cleanup = () => {};
    const send = value => {
      if (socket.destroyed) return false;
      const line = JSON.stringify(value) + '\n';
      if (socket.writableLength + Buffer.byteLength(line) > MAX_BUFFER) { socket.destroy(); return false; }
      socket.write(line); return true;
    };
    socket.on('error', () => {});
    socket.on('close', () => { this.clients.delete(socket); cleanup(); });
    socket.on('data', async chunk => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST) { socket.destroy(); return; }
      const end = input.indexOf('\n'); if (end < 0) return;
      socket.removeAllListeners('data');
      try {
        const req = JSON.parse(input.slice(0, end));
        if (req.method === 'list') { send({ result: this.list() }); socket.end(); return; }
        const agent = this.agent(req.sessionId);
        if (req.method === 'read') { send({ result: this.snapshot(agent, req.after, req.limit) }); socket.end(); }
        else if (req.method === 'send') { send({ result: await this.send(agent, req) }); socket.end(); }
        else if (req.method === 'reply' && this.communication) {
          send({ result: await this.communication.send(agent, { request_message_id: req.inReplyTo, text: req.text, mode: req.mode, idempotency_key: req.requestId }, true) }); socket.end();
        } else if (req.method === 'cancel' && this.communication) {
          send({ result: await this.communication.cancel(agent, req.messageId, true) }); socket.end();
        } else if (req.method === 'new-task' && this.communication) {
          send({ result: { chainIds: this.communication.newTask(agent) } }); socket.end();
        } else if (req.method === 'mailbox' && this.communication) {
          send({ result: this.communication.store.list(agent.id, req.after ?? 0, req.limit ?? 50) }); socket.end();
        } else if (req.method === 'watch-mailbox' && this.communication) {
          socket.setTimeout(0);
          let cursor = req.after ?? 0;
          this.communication.store.events(agent.id, cursor); // validate before accepting the stream
          send({ type: 'ready', sessionId: agent.id, after: cursor });
          const poll = () => {
            if (!this.ctx.agents.get(agent.id)) { send({ type: 'closed', sessionId: agent.id, cursor }); socket.end(); return; }
            try { for (const event of this.communication.store.events(agent.id, cursor)) { if (!send({ type: 'event', event })) return; cursor = event.seq; } }
            catch { socket.end(); return; }
            // Maintenance stays outside the read's failure domain: a busy or failing prune never closes a live watch.
            try { this.communication.store.pruneEvents(agent.id); } catch (error) { this.ctx.logger?.warn?.(`Mailbox prune failed: ${error.message}`); }
          };
          poll(); const interval = setInterval(poll, 250); interval.unref(); cleanup = () => clearInterval(interval);
        } else if (req.method === 'watch') {
          socket.setTimeout(0);
          let cursor = req.after ?? -1;
          // Register before snapshot; seq filtering removes overlap. Both the
          // baseline cut and follower registration happen in one JS turn.
          this.snapshot(agent, cursor, 1); // validate cursor before subscribing
          const set = this.followers.get(agent.id) ?? new Set(); this.followers.set(agent.id, set);
          const follow = event => {
            if (!event) { send({ type: 'closed', sessionId: agent.id, cursor }); socket.end(); return; }
            if (event.seq <= cursor) return;
            if (event.seq !== cursor + 1) { socket.destroy(); return; }
            if (send({ type: 'event', sessionId: agent.id, event })) cursor = event.seq;
          };
          set.add(follow); cleanup = () => { set.delete(follow); if (!set.size) this.followers.delete(agent.id); };
          const head = agent.session.seq - 1;
          send({ type: 'ready', sessionId: agent.id, head, after: cursor });
          for (const event of agent.session.snapshotEvents(cursor + 1, head + 1)) { if (socket.destroyed) break; follow(event); }
          send({ type: 'caught-up', sessionId: agent.id, cursor });
        } else throw Error('Unknown method');
      } catch (error) { send({ error: error.message, code: error.code ?? 'invalid_request' }); socket.end(); }
    });
  }
  async close() {
    this.disposeEvents(); this.disposeSessions();
    for (const socket of this.clients) socket.destroy();
    await new Promise(resolve => this.server.close(resolve));
    try { unlinkSync(this.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
