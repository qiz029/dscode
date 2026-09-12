import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, redact } from './content.mjs';

export class MemoryStore {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(root, 'state.sqlite'));
    chmodSync(join(root, 'state.sqlite'), 0o600);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, revision TEXT NOT NULL, retry INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, revision TEXT NOT NULL, cwd TEXT NOT NULL, value TEXT NOT NULL, generated INTEGER NOT NULL, used INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL);`);
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, JSON.stringify(value)); }
  acquire(key, owner, ttl, now = Date.now()) {
    return this.db.prepare(`INSERT INTO leases VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires < ? OR leases.owner=excluded.owner`).run(key, owner, now + ttl, now).changes > 0;
  }
  owns(key, owner) { return !!this.db.prepare('SELECT 1 FROM leases WHERE key=? AND owner=? AND expires>=?').get(key, owner, Date.now()); }
  release(key, owner) { this.db.prepare('DELETE FROM leases WHERE key=? AND owner=?').run(key, owner); }
  cancelPipeline() { this.db.prepare('DELETE FROM leases WHERE key=?').run('pipeline'); }
  active(id) { return !!this.db.prepare('SELECT 1 FROM leases WHERE key=? AND expires>=?').get(`session:${id}`, Date.now()); }
  enabled(id) { return this.db.prepare('SELECT enabled FROM sessions WHERE id=?').get(id)?.enabled !== 0; }
  enable(id, enabled) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(id, +enabled); }
  pending(id, revision) { const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); return !job || job.revision !== revision || job.retry > 0 && job.retry < Date.now(); }
  failed(id, revision) {
    const count = (this.db.prepare('SELECT failures FROM jobs WHERE id=?').get(id)?.failures ?? 0) + 1;
    this.db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?,?,?)').run(id, revision, Date.now() + Math.min(86400000, 60000 * 2 ** Math.min(count, 10)), count);
  }
  save(id, revision, cwd, value) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO jobs VALUES (?,?,0,0)').run(id, revision);
      if (value.raw_memory.trim()) this.db.prepare(`INSERT INTO memories VALUES (?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,cwd=excluded.cwd,value=excluded.value,generated=excluded.generated`).run(id, revision, cwd, JSON.stringify(value), Date.now(), Date.now());
      else this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  candidates(days, limit) {
    return this.db.prepare(`SELECT m.* FROM memories m LEFT JOIN sessions s ON s.id=m.id WHERE COALESCE(s.enabled,1)=1 AND MAX(m.used,m.generated)>=? ORDER BY m.uses DESC,MAX(m.used,m.generated) DESC LIMIT ?`).all(Date.now() - days * 86400000, limit).map(row => ({ ...row, value: JSON.parse(row.value) }));
  }
  prune(days) { this.db.prepare('DELETE FROM memories WHERE MAX(used,generated)<?').run(Date.now() - days * 86400000); }
  recordCall(call) {
    const stats = this.get('usage', { calls: 0, inputTokens: 0, outputTokens: 0, unknownUsage: 0 });
    stats.calls++; stats.inputTokens += call.usage?.inputTokens ?? 0; stats.outputTokens += call.usage?.outputTokens ?? 0;
    if (!call.usage) stats.unknownUsage++;
    this.set('usage', { ...stats, last: call });
  }
  touch(ids) { for (const id of ids) this.db.prepare('UPDATE memories SET used=?,uses=uses+1 WHERE id=?').run(Date.now(), id); }
  note(text) { const id = `note:${randomUUID()}`; this.db.prepare('INSERT INTO notes VALUES (?,?,?)').run(id, redact(text.slice(0, 4000)), Date.now()); return id; }
  notes() { return this.db.prepare('SELECT * FROM notes ORDER BY created DESC LIMIT 32').all(); }
  publish(snapshot, fingerprint) {
    this.db.exec('BEGIN IMMEDIATE');
    try { this.set('snapshot', snapshot); this.set('fingerprint', fingerprint); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.materialize(snapshot);
  }
  materialize(snapshot = this.get('snapshot')) {
    if (!snapshot) return;
    const write = (path, text) => {
      const tmp = `${path}.${randomUUID()}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, path);
    };
    const cite = ids => ids.map(id => `source: ${id}`).join(', ');
    write(join(this.root, 'memory_summary.md'), snapshot.summary + '\n');
    write(join(this.root, 'MEMORY.md'), snapshot.entries.map(e => `## ${e.title}\n\n${e.body}\n\n${cite(e.sources)}`).join('\n\n') + '\n');
    write(join(this.root, 'raw_memories.md'), snapshot.candidates.map(c => `## ${c.id}\nWorkspace: ${c.cwd}\n\n${c.value.raw_memory}`).join('\n\n'));
    // These two directories contain generated files only. The DB snapshot is
    // authoritative; interrupted materialization is repaired on the next run.
    for (const dir of ['rollout_summaries', 'skills']) { rmSync(join(this.root, dir), { recursive: true, force: true }); mkdirSync(join(this.root, dir), { mode: 0o700 }); }
    for (const c of snapshot.candidates) write(join(this.root, 'rollout_summaries', digest(c.id) + '.md'), `Session: ${c.id}\nWorkspace: ${c.cwd}\nMessage sequences: ${c.value.evidence.join(', ')}\n\n${c.value.rollout_summary}\n`);
    for (const skill of snapshot.skills) {
      const dir = join(this.root, 'skills', digest(skill.title).slice(0, 16)); mkdirSync(dir, { mode: 0o700 });
      write(join(dir, 'SKILL.md'), `# ${skill.title}\n\n${skill.body}\n\n${cite(skill.sources)}\n`);
    }
  }
  clear() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec("DELETE FROM memories; DELETE FROM notes; DELETE FROM jobs; DELETE FROM kv WHERE key NOT IN ('use','generate'); DELETE FROM leases WHERE key='pipeline';");
      this.set('clearedAt', Date.now()); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    for (const file of ['MEMORY.md', 'memory_summary.md', 'raw_memories.md', 'rollout_summaries', 'skills']) rmSync(join(this.root, file), { recursive: true, force: true });
  }
  close() { this.db.close(); }
}
