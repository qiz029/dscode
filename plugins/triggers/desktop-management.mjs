import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopTriggerScheduler } from './desktop-scheduler.mjs';
import { TriggerManagement } from './management.mjs';
import { acquireTriggerLease } from './lease.mjs';

export const desktopSchedulerDescription = 'Desktop scheduler start enables delivery for all registered projects and remembers that choice for future Desktop launches. stop disables that choice, interrupts active trigger runs and drains script sources; pending jobs remain queued. Desktop must stay open to deliver jobs. No OS service is installed.';

/** Persistent user choice and serialized controls around one process-owned scheduler. */
export class DesktopTriggerControl {
  constructor(ctx, { home, owner = new DesktopTriggerScheduler(ctx, { home }) }) {
    this.home = home; this.owner = owner; this.enabled = false; this.closed = false;
    this.pending = Promise.resolve(); this.ready = Promise.resolve();
    this.path = join(home, 'config', 'desktop-scheduler.json');
    try {
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      if (value?.version !== 1 || typeof value.enabled !== 'boolean') throw Error('Invalid Desktop scheduler settings');
      this.enabled = value.enabled;
    } catch (error) { if (error.code !== 'ENOENT') this.error = error.message; }
  }
  enqueue(operation) {
    const result = this.pending.then(() => {
      if (this.closed) throw Error('Desktop scheduling is shutting down');
      return operation();
    });
    this.pending = result.catch(() => {});
    return result;
  }
  initialize(hostReady = Promise.resolve()) {
    // Loading all providers/preset hooks precedes automatic delivery. Do not
    // block the plugin apply callback on its own loader's readiness barrier.
    this.ready = Promise.resolve(hostReady).then(() => this.enqueue(async () => {
      if (this.enabled) await this.owner.start();
    })).catch(error => { this.error = error.message; });
    return this.ready;
  }
  save(enabled) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, enabled }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temp, this.path); this.enabled = enabled;
    } finally { rmSync(temp, { force: true }); }
  }
  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw Error('enabled must be a boolean');
    await this.ready;
    await this.enqueue(async () => {
      const previous = this.enabled;
      this.save(enabled); // A failed save cannot start autonomous work.
      this.error = undefined;
      try { if (enabled) await this.owner.start(); else await this.owner.stop(); }
      catch (error) {
        if (enabled && !previous) this.save(false);
        this.error = error.message; throw error;
      }
    });
    return this.status();
  }
  async status() {
    await this.ready;
    const local = this.owner.status();
    let external = false;
    if (!local.running && !local.stopping) {
      const lease = await acquireTriggerLease(this.home, '_scheduler');
      external = !lease; lease?.release();
    }
    return { ...local, enabled: this.enabled, running: local.running || external,
      owner: external ? 'external' : 'desktop', requires_open_application: !external,
      next_step: external ? 'Another process owns the queue; control it from its terminal or service manager.' : 'Use /trigger scheduler start or Settings > DSCODE schedules to enable delivery.',
      ...(this.error ? { error: this.error } : {}) };
  }
  async dispose() {
    this.closed = true;
    // Keep the user's saved choice; quit/unload only stops this process owner.
    await this.owner.dispose();
  }
}

export class DesktopTriggerManagement extends TriggerManagement {
  constructor({ control, ...options }) {
    super(options); this.control = control;
    this.schedulerActions = ['status', 'start', 'stop'];
    this.schedulerDescription = desktopSchedulerDescription;
  }
  workspace(agent) {
    if (this.control.closed) throw Error('Desktop scheduling is shutting down');
    return super.workspace(agent);
  }
  status() { return this.control.status(); }
  async scheduler({ action }) {
    if (action === 'status') return this.status();
    if (!['start', 'stop'].includes(action)) throw Error('Desktop scheduler action must be status, start or stop');
    return { scheduler: await this.control.setEnabled(action === 'start') };
  }
}
