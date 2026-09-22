import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTriggerDefinitions } from './config.mjs';

export class SourceSupervisor {
  constructor({ home, store, report = console.error }) { Object.assign(this, { home, store, report }); this.active = new Map(); this.observed = new Map(); }
  tick() {
    const desired = new Map();
    for (const saved of this.store.sources()) {
      const definition = loadTriggerDefinitions({ home: this.home, workspace: saved.project }).definitions.find(d => d.id === saved.triggerId);
      const signature = definition ? JSON.stringify([definition.workspace, definition.source, saved.revision]) : undefined;
      if (this.observed.has(saved.id) && this.observed.get(saved.id) !== signature) {
        this.store.run('UPDATE sources SET nextAt=0,failures=0 WHERE id=?', saved.id);
        saved.nextAt = 0;
      }
      this.observed.set(saved.id, signature);
      if (!definition?.enabled || definition.source.kind !== 'script' || saved.desired !== 'running') continue;
      desired.set(saved.id, { saved, definition, signature });
    }
    for (const id of this.observed.keys()) if (!this.store.one('SELECT id FROM sources WHERE id=?', id)) this.observed.delete(id);
    for (const [id, active] of this.active) {
      if (desired.get(id)?.signature !== active.signature) { active.stopping = true; if (active.child.connected) active.child.send('stop', () => {}); }
    }
    for (const [id, { saved, definition, signature }] of desired) {
      if (this.active.has(id) || saved.nextAt > Date.now() || this.active.size >= 16) continue;
      const child = fork(fileURLToPath(new URL('./source-host.mjs', import.meta.url)), [JSON.stringify({ home: this.home, project: saved.project, definition: { id: definition.id, workspace: definition.workspace, source: definition.source }, sourceId: id })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
      let error = '';
      child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-2000); });
      const promise = new Promise(resolve => {
        const finish = code => {
          if (code) { this.store.run("UPDATE sources SET status='backoff',pid=NULL,error=?,nextAt=? WHERE id=?", error || 'source guardian interrupted', Date.now() + 30000, id); this.report(error || `source ${saved.triggerId} interrupted`); }
          if (this.active.get(id)?.stopping) this.store.run('UPDATE sources SET nextAt=0 WHERE id=?', id);
          this.active.delete(id); resolve();
        };
        child.once('error', e => { error = e.message; if (!child.pid) finish(1); });
        child.once('exit', code => finish(code ?? 130));
      });
      this.active.set(id, { child, promise, signature });
    }
  }
  async close() {
    for (const { child } of this.active.values()) if (child.connected) child.send('stop', () => {});
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
  }
}
