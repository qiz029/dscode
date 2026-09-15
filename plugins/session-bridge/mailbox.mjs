import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export const limits = Object.freeze({ depth: 3, sends: 8, ttlMs: 3600000, pending: 100, bytes: 1048576, contexts: 32,
  // The retention window is the real policy: settled rows are deleted only once they are past it.
  // The row caps are a backstop against runaway growth from an idle or hostile sender; they are
  // deliberately far above any realistic mailbox so they never cut a live late-reply window short.
  retentionMs: 7 * 24 * 3600000, retainedMessages: 50000, retainedEvents: 5000, retainedChains: 20000, retainedRefusals: 5000 });
export class CommunicationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new CommunicationError(code, message); };
const json = JSON.stringify;
const digest = value => createHash('sha256').update(json(value)).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function mergeContexts(...sets) {
  const result = [...new Map(sets.flat().map(c => [json(c), c])).values()];
  if (result.length > limits.contexts) fail('context_limit', 'Too many causal paths; start a new task explicitly.');
  return result;
}

// Shared metadata only. Native Harness owns the session writer and model driver.
export class Mailbox {
  constructor(home, now = Date.now, retention = {}) {
    this.retention = Object.freeze(Object.fromEntries(['retentionMs', 'retainedMessages', 'retainedEvents', 'retainedChains', 'retainedRefusals'].map(key => {
      const value = retention[key] ?? limits[key];
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid mailbox retention: ${key}`);
      return [key, value];
    })));
    const root = join(home, 'session-communication'); mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'mailbox.sqlite')); this.now = now; this.prunedAt = 0; this.eventsPrunedAt = new Map();
    chmodSync(join(root, 'mailbox.sqlite'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY, generation TEXT NOT NULL, secret TEXT NOT NULL, socket TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contexts(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chains(id TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, sender TEXT NOT NULL, idem TEXT NOT NULL, digest TEXT NOT NULL,
        recipient TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL, body TEXT NOT NULL, size INTEGER NOT NULL, expires INTEGER NOT NULL,
        delivery TEXT NOT NULL, request_state TEXT, reply_id TEXT, batch TEXT, UNIQUE(sender,idem));
      CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient,delivery,seq);
      CREATE TABLE IF NOT EXISTS refusals(key TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, message_id TEXT, type TEXT NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL);`);
  }
  /** Cheap size check for the prune test surface. */
  tableCounts() { return Object.fromEntries(['messages', 'events', 'refusals', 'chains', 'contexts'].map(name => [name, this.one(`SELECT COUNT(*) AS n FROM ${name}`).n])); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(recipient, type, messageId, data = {}) { this.run('INSERT INTO events(recipient,message_id,type,time,data) VALUES(?,?,?,?,?)', recipient, messageId, type, this.now(), json(data)); }
  refusal(recipient, sender, code) {
    this.transaction(() => {
      const key = digest({ recipient, sender, code, contexts: sender ? this.context(sender) : [] });
      if (this.run('INSERT OR IGNORE INTO refusals VALUES(?)', key).changes) this.event(sender ?? recipient, 'send-refused', null, { recipient, code });
    });
  }
  register(id, socket) {
    const auth = { sessionId: id, generation: randomUUID(), secret: randomUUID() };
    this.run('INSERT OR REPLACE INTO owners VALUES(?,?,?,?)', id, auth.generation, auth.secret, socket); return auth;
  }
  authenticate(auth) {
    if (!auth || ['sessionId', 'generation', 'secret'].some(k => typeof auth[k] !== 'string' || !auth[k] || auth[k].length > 256)) fail('invalid_sender', 'Invalid sender runtime identity');
    const owner = auth && this.one('SELECT * FROM owners WHERE id=?', auth.sessionId);
    if (!owner || owner.generation !== auth.generation || !equal(owner.secret, auth.secret)) fail('invalid_sender', 'Sender runtime is no longer the owner.');
    return owner;
  }
  unregister(auth) { this.run('DELETE FROM owners WHERE id=? AND generation=?', auth.sessionId, auth.generation); }
  context(id) { return JSON.parse(this.one('SELECT value FROM contexts WHERE id=?', id)?.value ?? '[]'); }
  setContext(id, value) { this.run('INSERT OR REPLACE INTO contexts VALUES(?,?)', id, json(value)); return value; }
  root(id) {
    const chainId = randomUUID(), now = this.now();
    this.run('INSERT INTO chains VALUES(?,?,?,0)', chainId, now, now + limits.ttlMs);
    return [{ chainId, path: [id] }];
  }
  newTask(auth) {
    return this.transaction(() => { this.authenticate(auth); const context = this.setContext(auth.sessionId, this.root(auth.sessionId)); this.event(auth.sessionId, 'task-started', null); return context; });
  }
  include(auth, incoming, human = false, parent, replace = false) {
    return this.transaction(() => {
      this.authenticate(auth);
      let current = replace ? [] : this.context(auth.sessionId);
      if (parent) current = mergeContexts(current, this.context(parent).map(c => ({ ...c, path: c.path.includes(auth.sessionId) ? c.path : [...c.path, auth.sessionId] })));
      if (!current.length && human && !parent) current = this.root(auth.sessionId);
      return this.setContext(auth.sessionId, mergeContexts(current, incoming));
    });
  }
  get(id) {
    const row = this.one('SELECT * FROM messages WHERE id=?', id);
    return row ? { ...row, envelope: JSON.parse(row.body) } : null;
  }
  public(row) { return row && { ...row.envelope, seq: row.seq, delivery: row.delivery, requestState: row.request_state, batch: row.batch, alreadyClaimed: row.batch !== null || row.delivery === 'consumed' }; }
  expire(id) {
    const now = this.now();
    this.run("UPDATE messages SET request_state='expired' WHERE recipient=? AND request_state='open' AND expires<=?", id, now);
    for (const row of this.all("SELECT id FROM messages WHERE recipient=? AND delivery IN ('accepted','admitted') AND expires<=?", id, now)) {
      this.run("UPDATE messages SET delivery='expired' WHERE id=?", row.id); this.event(id, 'expired', row.id);
    }
  }
  /** Drop dead rows so the sqlite file stays bounded: settled messages past the retention
   * window (or beyond the cap), their events, expired chains and old refusals. A request whose
   * reply window may still be used is kept for the full retention window, because late replies
   * are legal. Cheap, idempotent and throttled to once an hour. */
  prune({ force = false } = {}) {
    const now = this.now();
    // The throttle is per process, but the table outlives it: the caller forces the first sweep.
    if (!force && now - this.prunedAt < 3600000) return;
    // Stamp only after the transaction commits, so a failed sweep retries instead of waiting an hour.
    this.transaction(() => {
      const cutoff = now - this.retention.retentionMs;
      // Settle every request whose reply window has closed first: the in-process expiry sweep only
      // runs on mailbox reads, so an idle session would otherwise never settle one.
      for (const { recipient } of this.all('SELECT DISTINCT recipient FROM messages')) this.expire(recipient);
      this.run("DELETE FROM messages WHERE delivery IN ('consumed','cancelled','expired','late') AND expires<=?", cutoff);
      // Inside the retention window neither still-deliverable mail (accepted/admitted) nor a
      // request whose reply window is still open is ever evicted: late replies are legal.
      this.run("DELETE FROM messages WHERE delivery NOT IN ('accepted','admitted') AND expires<=? AND seq <= COALESCE((SELECT seq FROM messages WHERE delivery NOT IN ('accepted','admitted') AND expires<=? ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)", now, now, this.retention.retainedMessages);
      this.run('DELETE FROM events WHERE time<?', cutoff);
      // Events are per-recipient cursors: cap each recipient's own stream so a busy session
      // cannot age out another session's unread notifications.
      for (const { recipient } of this.all('SELECT DISTINCT recipient FROM events')) {
        this.run('DELETE FROM events WHERE recipient=? AND seq <= COALESCE((SELECT seq FROM events WHERE recipient=? ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)', recipient, recipient, this.retention.retainedEvents);
      }
      this.run('DELETE FROM chains WHERE expires<?', cutoff);
      this.run('DELETE FROM chains WHERE expires<? AND created < COALESCE((SELECT created FROM chains ORDER BY created DESC LIMIT 1 OFFSET ?), 0)', now, this.retention.retainedChains);
      this.run('DELETE FROM refusals WHERE rowid NOT IN (SELECT rowid FROM refusals ORDER BY rowid DESC LIMIT ?)', this.retention.retainedRefusals);
    });
    this.prunedAt = now;
  }

  /** Event-only pruning for the watch loop: events are cheap rows and can be dropped more often. */
  pruneEvents(recipient) {
    const now = this.now();
    // Per recipient: one session's poller must not starve another window.
    if (now - (this.eventsPrunedAt.get(recipient) ?? 0) < 60000) return;
    this.transaction(() => {
      this.run('DELETE FROM events WHERE recipient=? AND time<?', recipient, now - this.retention.retentionMs);
      // Scoped to one recipient: a busy session must not age out another session's notifications.
      this.run('DELETE FROM events WHERE recipient=? AND seq <= COALESCE((SELECT seq FROM events WHERE recipient=? ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)', recipient, recipient, this.retention.retainedEvents);
    });
    this.eventsPrunedAt.set(recipient, now);
  }

  admit(recipient, request, auth) {
    const { text, mode = 'queue', kind = 'request', requestId, source = 'cli', inReplyTo, title } = request;
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64000) fail('invalid_text', 'Text must contain 1..64000 bytes');
    if (!['queue', 'steer', 'defer'].includes(mode) || !['request', 'notify', 'reply'].includes(kind)) fail('invalid_message', 'Invalid message kind or delivery mode');
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(requestId)) fail('invalid_key', 'A stable requestId / idempotency_key is required');
    if (typeof source !== 'string' || !/^[\p{L}\p{N}_.:@/-]{1,64}$/u.test(source)) fail('invalid_source', 'Invalid source label');
    if (auth && title !== undefined) fail('invalid_title', 'Agent messages cannot rename other sessions');
    if (kind === 'request' && inReplyTo || kind === 'reply' && !inReplyTo) fail('invalid_reply', 'Reply association does not match kind');
    return this.transaction(() => {
      if (auth) this.authenticate(auth);
      const sender = auth ? `session:${auth.sessionId}` : `external:${source}`;
      const fingerprint = digest({ recipient, text, mode, kind, inReplyTo, title });
      const previous = this.one('SELECT id,digest FROM messages WHERE sender=? AND idem=?', sender, requestId);
      if (previous) {
        if (previous.digest !== fingerprint) fail('idempotency_conflict', 'requestId already belongs to a different message');
        return { row: this.get(previous.id), duplicate: true };
      }
      this.expire(recipient);
      let contexts, original, late = false;
      if (inReplyTo) {
        original = this.get(inReplyTo);
        if (!auth || !original || original.kind !== 'request' || original.recipient !== auth.sessionId || original.envelope.from.kind !== 'session' || original.envelope.from.sessionId !== recipient) fail('invalid_reply', 'Only the request recipient may reply to its sender');
        if (kind === 'reply' && original.reply_id) fail('already_replied', 'This request already has a final reply');
        late = original.request_state !== 'open' || original.expires <= this.now();
        if (late && kind !== 'reply') fail('request_closed', 'Request is no longer open');
        // Return along the original delegation paths, not the reply transport path.
        contexts = original.envelope.contexts.map(c => ({ ...c, path: c.path.slice(0, -1) }));
        const causal = this.context(auth.sessionId).map(c => ({ ...c,
          path: c.path.includes(recipient) ? c.path.slice(0, c.path.indexOf(recipient) + 1) : [...c.path, recipient] }));
        contexts = mergeContexts(contexts, causal);
      } else if (auth) {
        contexts = this.context(auth.sessionId);
        if (!contexts.length) fail('no_task', 'No user-authorized task context; ask the user to start a task.');
        for (const c of contexts) {
          if (c.path.includes(recipient)) fail('cycle_detected', 'Cannot delegate to this task path or to yourself');
          if (c.path.length > limits.depth) fail('depth_exceeded', 'Session delegation depth limit reached');
        }
        contexts = contexts.map(c => ({ ...c, path: [...c.path, recipient] }));
      } else contexts = this.root(recipient);
      // Reply rights are reserved by the original request. Other messages charge every inherited chain.
      let expires = original?.expires ?? Infinity;
      for (const id of new Set(contexts.map(c => c.chainId))) {
        const chain = this.one('SELECT * FROM chains WHERE id=?', id);
        if (!chain) fail('invalid_chain', 'Missing task chain');
        expires = Math.min(expires, chain.expires);
        if (kind !== 'reply') {
          if (chain.expires <= this.now()) fail('chain_expired', 'Task chain expired; user must explicitly start a new task');
          if (chain.used >= limits.sends) fail('budget_exhausted', 'Task chain message budget exhausted');
          this.run('UPDATE chains SET used=used+1 WHERE id=?', id);
        }
      }
      if (kind === 'reply' && expires <= this.now()) late = true;
      const pending = this.one("SELECT COUNT(*) AS n,COALESCE(SUM(size),0) AS bytes FROM messages WHERE recipient=? AND delivery IN ('accepted','admitted')", recipient);
      if (!late && (pending.n >= limits.pending || pending.bytes + Buffer.byteLength(text) > limits.bytes)) fail('mailbox_full', 'Recipient mailbox is full');
      const id = randomUUID();
      const envelope = { version: 1, messageId: id, idempotencyKey: requestId,
        from: auth ? { kind: 'session', sessionId: auth.sessionId } : { kind: 'external', source }, toSessionId: recipient,
        kind, mode, text, contexts, chainIds: [...new Set(contexts.map(c => c.chainId))], inReplyTo: inReplyTo ?? null,
        parentMessageIds: auth ? this.all("SELECT id FROM messages WHERE recipient=? AND (delivery='consumed' OR batch IS NOT NULL) ORDER BY seq DESC LIMIT 32", auth.sessionId).map(r => r.id) : [],
        createdAt: this.now(), expiresAt: expires, ...(title === undefined ? {} : { title, titleBaseSeq: request.titleBaseSeq ?? -1 }) };
      if (Buffer.byteLength(json(envelope)) + 512 > 96000) fail('message_too_large', 'Message plus source metadata exceeds the delivery limit');
      this.run('INSERT INTO messages(id,sender,idem,digest,recipient,kind,mode,body,size,expires,delivery,request_state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        id, sender, requestId, fingerprint, recipient, kind, mode, json(envelope), Buffer.byteLength(text), expires, late ? 'late' : 'accepted', kind === 'request' ? 'open' : null);
      if (kind === 'reply') this.run('UPDATE messages SET reply_id=?,request_state=? WHERE id=?', id, late ? original.expires <= this.now() ? 'expired' : original.request_state : 'replied', original.id);
      this.event(recipient, late ? 'late-reply' : 'accepted', id, { kind, mode });
      return { row: this.get(id), duplicate: false };
    });
  }
  transition(auth, id, delivery, batch) {
    return this.transaction(() => {
      this.authenticate(auth); const row = this.get(id);
      if (!row || row.recipient !== auth.sessionId || ['cancelled', 'expired', 'late', 'consumed'].includes(row.delivery)) return;
      this.run('UPDATE messages SET delivery=?,batch=COALESCE(?,batch) WHERE id=?', delivery, batch ?? null, id);
      if (row.delivery !== delivery) this.event(auth.sessionId, delivery, id);
    });
  }
  freeze(auth) {
    this.authenticate(auth);
    return this.one('SELECT COALESCE(MAX(seq),0) AS seq FROM messages WHERE recipient=?', auth.sessionId).seq;
  }
  deferred(auth, cutoff, turn) {
    return this.transaction(() => {
      this.authenticate(auth); this.expire(auth.sessionId);
      const rows = this.all("SELECT id FROM messages WHERE recipient=? AND mode='defer' AND delivery IN ('accepted','admitted') AND seq<=? ORDER BY seq", auth.sessionId, cutoff);
      const selected = []; let bytes = 0;
      for (const { id } of rows) {
        const row = this.get(id); const framedBytes = Buffer.byteLength(row.body) + 512;
        if (bytes + framedBytes > 96000) break;
        bytes += framedBytes; this.run('UPDATE messages SET batch=? WHERE id=?', `${auth.generation}:${turn}`, id); selected.push(row);
      }
      return selected;
    });
  }
  cancel(auth, id, human = false) {
    return this.transaction(() => {
      this.authenticate(auth); const row = this.get(id);
      if (!row || !(row.sender === `session:${auth.sessionId}` || human && row.recipient === auth.sessionId)) fail('not_authorized', 'Only the sender or receiving user may cancel this message');
      if (['replied', 'expired', 'cancelled'].includes(row.request_state)) return this.public(row);
      this.run("UPDATE messages SET request_state=CASE WHEN kind='request' THEN 'cancelled' ELSE request_state END,delivery=CASE WHEN delivery IN ('accepted','admitted') THEN 'cancelled' ELSE delivery END WHERE id=?", id);
      this.event(row.recipient, 'cancelled', id); return this.public(this.get(id));
    });
  }
  pending(id) { return this.all("SELECT id FROM messages WHERE recipient=? AND delivery IN ('accepted','admitted') ORDER BY seq", id).map(r => this.get(r.id)); }
  list(id, after = 0, limit = 50) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid_cursor', 'Invalid mailbox cursor/limit');
    const rows = this.all('SELECT id FROM messages WHERE recipient=? AND seq>? ORDER BY seq LIMIT ?', id, after, limit).map(r => this.public(this.get(r.id)));
    return { messages: rows, cursor: rows.at(-1)?.seq ?? after };
  }
  counts(id) {
    const result = { queue: 0, steer: 0, defer: 0 };
    for (const r of this.all("SELECT mode,COUNT(*) AS n FROM messages WHERE recipient=? AND delivery IN ('accepted','admitted') AND expires>? GROUP BY mode", id, this.now())) result[r.mode] = r.n;
    return result;
  }
  events(id, after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) fail('invalid_cursor', 'Invalid mailbox event cursor');
    return this.all('SELECT * FROM events WHERE recipient=? AND seq>? ORDER BY seq LIMIT 100', id, after).map(e => ({ ...e, data: JSON.parse(e.data) }));
  }
  close() { this.db.close(); }
}
