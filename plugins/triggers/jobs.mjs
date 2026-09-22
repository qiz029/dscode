// The schedule cursor and generated job commit together. Claim/cancel are SQL
// compare-and-swap transitions; a running job is never automatically retried.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeEvent } from './spool.mjs';
import { nextFiring, dueFiring } from './schedule.mjs';

const key = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class JobStore {
  constructor(home) {
    const directory = join(home, 'triggers');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'jobs.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, triggerId TEXT NOT NULL, project TEXT NOT NULL, workspace TEXT NOT NULL, source TEXT NOT NULL, nextAt INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, triggerId TEXT NOT NULL, project TEXT NOT NULL, desired TEXT NOT NULL DEFAULT 'running', revision INTEGER NOT NULL DEFAULT 0, nextAt INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'waiting', pid INTEGER, error TEXT, log TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS event_receipts (id TEXT PRIMARY KEY, eventId TEXT NOT NULL, request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_requests (id TEXT PRIMARY KEY, request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, triggerId TEXT NOT NULL, project TEXT NOT NULL, workspace TEXT NOT NULL, kind TEXT NOT NULL, scheduleId TEXT, dueAt INTEGER NOT NULL, availableAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', reason TEXT, runId TEXT, sessionId TEXT, pid INTEGER, startedAt INTEGER, endedAt INTEGER, exitCode INTEGER);
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,availableAt,dueAt,seq);`);
  }
  close() { this.db.close(); }
  all(sql, ...args) { return this.db.prepare(sql).all(...args); }
  one(sql, ...args) { return this.db.prepare(sql).get(...args); }
  run(sql, ...args) { return this.db.prepare(sql).run(...args); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { return this.one('SELECT * FROM jobs WHERE id=?', id); }
  list(triggerId) { return this.all(`SELECT * FROM jobs ${triggerId ? 'WHERE triggerId=?' : ''} ORDER BY dueAt DESC,seq DESC`, ...(triggerId ? [triggerId] : [])); }
  pending(now) { return this.all(`SELECT j.* FROM jobs j WHERE j.state='pending' AND j.availableAt<=?
    AND NOT EXISTS (SELECT 1 FROM jobs older WHERE older.triggerId=j.triggerId AND older.state='pending' AND older.dueAt<=?
      AND (older.dueAt<j.dueAt OR (older.dueAt=j.dueAt AND older.seq<j.seq))) ORDER BY j.dueAt,j.seq`, now, now); }
  running() { return this.all("SELECT * FROM jobs WHERE state='running'"); }
  create({ triggerId, project, workspace, payload = {}, dueAt, kind = 'delay', scheduleId = null, id = `job-${randomUUID()}`, now = Date.now() }) {
    this.run('INSERT OR IGNORE INTO jobs(id,triggerId,project,workspace,kind,scheduleId,dueAt,availableAt,createdAt,payload) VALUES(?,?,?,?,?,?,?,?,?,?)', id, triggerId, project, workspace, kind, scheduleId, dueAt, dueAt, now, JSON.stringify(payload));
    return this.get(id);
  }
  acceptEvent({ definition, project, payload, eventId, now = Date.now(), maxPending = 100 }) {
    const event = normalizeEvent(definition.id, payload, { eventId, now });
    const { triggerId, receivedAt: _received, eventId: identity, ...body } = event;
    const request = JSON.stringify(body, (_k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
    if (Buffer.byteLength(request) > 131072) throw new Error('event body exceeds 128 KiB');
    const id = `event-${key([project, triggerId, identity])}`;
    return this.transaction(() => {
      const receipt = this.one('SELECT * FROM event_receipts WHERE id=?', id);
      if (receipt) {
        if (receipt.request !== request) throw new Error('eventId was already used for a different payload');
        return this.get(id);
      }
      const count = this.one("SELECT COUNT(*) AS n FROM jobs WHERE project=? AND triggerId=? AND state IN ('pending','running')", project, triggerId).n;
      if (count >= maxPending) throw new Error('QUEUE_FULL: retry this event later with the same eventId');
      this.run('INSERT INTO event_receipts(id,eventId,request) VALUES(?,?,?)', id, identity, request);
      return this.create({ id, triggerId, project, workspace: definition.workspace, payload: body, kind: 'event', dueAt: now, now });
    });
  }
  eventIdentity(id) { return this.one('SELECT eventId FROM event_receipts WHERE id=?', id)?.eventId; }
  sources() { return this.all('SELECT * FROM sources'); }
  source(triggerId, project) { return this.one('SELECT * FROM sources WHERE id=?', key([project, triggerId])); }
  registerSource(definition, project) {
    if (definition.source.kind !== 'script') throw new Error('source management requires a script source');
    const id = key([project, definition.id]);
    this.run('INSERT OR IGNORE INTO sources(id,triggerId,project) VALUES(?,?,?)', id, definition.id, project);
    return this.source(definition.id, project);
  }
  controlSource(definition, project, action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('source expects status, start, stop, restart or logs');
    const saved = this.registerSource(definition, project);
    this.run("UPDATE sources SET desired=?,revision=revision+?,nextAt=0,failures=0 WHERE id=?", action === 'stop' ? 'stopped' : 'running', Number(action === 'restart'), saved.id);
    return this.source(definition.id, project);
  }
  cancel(id, now = Date.now()) {
    if (!this.get(id)) throw new Error(`no job "${id}"`);
    if (!this.run("UPDATE jobs SET state='cancelled',reason='cancelled',endedAt=? WHERE id=? AND state='pending'", now, id).changes) {
      throw new Error(`job ${id} is ${this.get(id).state}; only pending jobs can be cancelled`);
    }
  }
  /** Tool retries reuse the first due time; a changed request cannot reuse its key. */
  createOnce({ requestKey, request, ...options }) {
    const id = `job-${key([options.project, requestKey])}`;
    return this.transaction(() => {
      const saved = this.one('SELECT request FROM job_requests WHERE id=?', id);
      if (saved) {
        if (saved.request !== request) throw new Error('idempotency_key was already used for a different job request');
        return this.get(id);
      }
      this.run('INSERT INTO job_requests(id,request) VALUES(?,?)', id, request);
      return this.create({ ...options, dueAt: typeof options.dueAt === 'function' ? options.dueAt() : options.dueAt, id });
    });
  }
  defer(id, reason, availableAt) { this.run("UPDATE jobs SET reason=?,availableAt=? WHERE id=? AND state='pending'", reason, availableAt, id); }
  claim(id, runId, now) { return this.run("UPDATE jobs SET state='running',reason=NULL,runId=?,pid=?,startedAt=? WHERE id=? AND state='pending' AND availableAt<=?", runId, process.pid, now, id, now).changes === 1; }
  finish(id, result, now = Date.now()) {
    const state = result.exitCode === 0 ? 'completed' : 'failed';
    this.run("UPDATE jobs SET state=?,reason=?,sessionId=?,endedAt=?,exitCode=? WHERE id=? AND state='running'", state, result.reason ?? null, result.sessionId ?? null, now, result.exitCode, id);
  }
  schedules() { return this.all('SELECT * FROM schedules'); }
  register(definition, project, now = Date.now()) {
    if (definition.source.kind === 'script') {
      this.run('DELETE FROM schedules WHERE id=?', key([project, definition.id]));
      return this.registerSource(definition, project);
    }
    this.run('DELETE FROM sources WHERE id=?', key([project, definition.id]));
    if (!['calendar', 'interval', 'poll'].includes(definition.source.kind)) throw new Error('only calendar, interval and poll sources have recurring jobs');
    const id = key([project, definition.id]);
    const source = JSON.stringify(definition.source);
    const old = this.one('SELECT * FROM schedules WHERE id=?', id);
    if (old?.workspace === definition.workspace && old.source === source) return old;
    const nextAt = nextFiring(definition.source, now);
    this.run('INSERT INTO schedules(id,triggerId,project,workspace,source,nextAt,enabled) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET workspace=excluded.workspace,source=excluded.source,nextAt=excluded.nextAt,enabled=excluded.enabled', id, definition.id, project, definition.workspace, source, nextAt, Number(definition.enabled));
    return this.one('SELECT * FROM schedules WHERE id=?', id);
  }
  unregister(triggerId, project, now = Date.now()) {
    const id = key([project, triggerId]);
    this.transaction(() => {
      this.run('DELETE FROM schedules WHERE id=?', id);
      this.run('DELETE FROM sources WHERE id=?', id);
      this.run("UPDATE jobs SET state='cancelled',reason='uninstalled',endedAt=? WHERE scheduleId=? AND state='pending'", now, id);
    });
  }
  /** Reloaded definitions drive enable/disable and source edits; absent definitions stop producing jobs. */
  materialize(resolveDefinition, now = Date.now()) {
    return this.transaction(() => {
      const created = [];
      for (const saved of this.schedules()) {
        const definition = resolveDefinition(saved);
        if (!definition || !['calendar', 'interval', 'poll'].includes(definition.source.kind)) continue;
        const source = JSON.stringify(definition.source);
        if (saved.source !== source || saved.workspace !== definition.workspace || Boolean(saved.enabled) !== definition.enabled) {
          this.run('UPDATE schedules SET source=?,workspace=?,enabled=?,nextAt=? WHERE id=?', source, definition.workspace, Number(definition.enabled), nextFiring(definition.source, now), saved.id);
          continue;
        }
        if (!definition.enabled) continue;
        const firing = dueFiring(definition.source, saved.nextAt, now);
        if (!firing) continue;
        if (!firing.skipped) created.push(this.create({
          id: `cron-${key([saved.id, source, firing.scheduledAt])}`, kind: 'cron', scheduleId: saved.id,
          triggerId: saved.triggerId, project: saved.project, workspace: saved.workspace,
          dueAt: firing.scheduledAt, now, payload: { source: definition.source.kind, fields: { scheduledAt: new Date(firing.scheduledAt).toISOString() } },
        }));
        this.run('UPDATE schedules SET nextAt=? WHERE id=?', firing.nextAt, saved.id);
      }
      return created;
    });
  }
}

export function formatJob(job) {
  return `${job.id} ${job.triggerId} ${job.state}${job.reason ? ` (${job.reason})` : ''} · due ${new Date(job.dueAt).toISOString()}${job.runId ? ` · run ${job.runId}` : ''}${job.sessionId ? ` · session ${job.sessionId}` : ''}`;
}
