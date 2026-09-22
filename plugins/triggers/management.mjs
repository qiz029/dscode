// Agent-facing management uses the same definitions, jobs and scheduler as the CLI.
import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { loadTriggerDefinitions, normalizeTrigger } from './config.mjs';
import { JobStore } from './jobs.mjs';
import { normalizeEvent } from './spool.mjs';
import { dueTime } from './schedule.mjs';
import { acquireTriggerLease } from './lease.mjs';
import { schedulerService } from './scheduler-service.mjs';

const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const required = (value, label) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`); return value; };
const clean = definition => Object.fromEntries(Object.entries(definition).filter(([key]) => !['origin', 'path', 'overrides'].includes(key)));

/** No shell, inherited input or unbounded launchctl wait. */
function launchctl(args, { ignoreFailure = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('/bin/launchctl', args, { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('error', error => { clearTimeout(timer); if (ignoreFailure) resolveRun(1); else reject(error); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0 || ignoreFailure) resolveRun(code ?? 1); else reject(new Error(`launchctl failed (${code})`)); });
  });
}

export class TriggerManagement {
  constructor({ home, dscodePath, platform = process.platform, now = Date.now, service = schedulerService, runLaunchctl = launchctl }) {
    Object.assign(this, { home, dscodePath, platform, now, service, runLaunchctl });
  }
  workspace(agent) {
    const cwd = agent?.session?.header?.cwd;
    if (!cwd || !isAbsolute(cwd)) throw new Error('A session bound to a workspace is required');
    return resolve(cwd);
  }
  definitions(project) { return loadTriggerDefinitions({ home: this.home, workspace: project }); }
  definition(project, id) {
    required(id, 'trigger_id');
    const definition = this.definitions(project).definitions.find(item => item.id === id);
    if (!definition) throw new Error(`No trigger "${id}"`);
    if (resolve(definition.workspace) !== project) throw new Error('The trigger belongs to another workspace');
    return definition;
  }
  runnable(definition) {
    if (!['read-only', 'workspace-write'].includes(definition.permission) || definition.preset !== 'dscode') {
      throw new Error('Agent-managed scheduling requires the dscode preset and read-only or workspace-write permission');
    }
  }
  withStore(fn) {
    const store = new JobStore(this.home);
    try { return fn(store); } finally { store.close(); }
  }
  async status() {
    const lease = await acquireTriggerLease(this.home, '_scheduler');
    const running = !lease;
    lease?.release();
    return { running, ...(!running ? { next_step: 'Use trigger_scheduler(action="install") on macOS, or run dscode trigger scheduler start under a service manager.' } : {}) };
  }
  write(project, definition, existing) {
    const directory = join(project, '.dsh', 'triggers');
    // Do not turn a project-local tool into an arbitrary-file writer via symlinks.
    for (const path of [join(project, '.dsh'), directory]) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Trigger configuration directories must not be symlinks');
    }
    mkdirSync(directory, { recursive: true });
    const path = existing?.path ?? join(directory, `${definition.id}.yml`);
    if (relative(directory, dirname(path)) !== '' || (existsSync(path) && lstatSync(path).isSymbolicLink())) throw new Error('Only regular project-local definitions can be changed');
    const body = path.endsWith('.json') ? JSON.stringify(clean(definition), null, 2) + '\n' : stringify(clean(definition));
    const temp = join(directory, `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, body, { flag: 'wx', mode: 0o600 });
      if (existing) renameSync(temp, path);
      else linkSync(temp, path); // Never overwrite a concurrently created definition.
    } finally { rmSync(temp, { force: true }); }
    return path;
  }
  async manage(args, agent) {
    const project = this.workspace(agent);
    const { action, trigger_id: id } = args;
    if (action === 'list') {
      const found = this.definitions(project);
      return { definitions: found.definitions.filter(d => resolve(d.workspace) === project), problems: found.problems, schedules: this.withStore(s => s.schedules().filter(row => row.project === project)), sources: this.withStore(s => s.sources().filter(row => row.project === project)), scheduler: await this.status() };
    }
    if (action === 'get') return { definition: this.definition(project, id) };
    if (!['create', 'update', 'enable', 'disable', 'register', 'unregister'].includes(action)) throw new Error('Unknown trigger action');
    let definition;
    if (action === 'create' || action === 'update') {
      required(id, 'trigger_id');
      const found = this.definitions(project);
      const existing = found.definitions.find(d => d.id === id);
      if (action === 'create' && existing) throw new Error('Trigger already exists; use update');
      if (action === 'update' && (!existing || existing.origin !== 'project')) throw new Error('Only existing project-local definitions can be updated');
      if (existing && resolve(existing.workspace) !== project) throw new Error('The trigger belongs to another workspace');
      // A broken JSON/YAML file must be repaired explicitly, never shadowed by a new extension.
      if (found.problems.some(p => ['yml', 'yaml', 'json'].some(ext => p.path === join(project, '.dsh', 'triggers', `${id}.${ext}`)))) throw new Error('Repair the unreadable definition before editing it');
      const patch = args.definition;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('definition is required for create/update');
      const allowed = ['prompt', 'source', 'goal', 'limits', 'session', 'enabled', 'permission', 'model', 'effort'];
      if (Object.keys(patch).some(key => !allowed.includes(key))) throw new Error(`definition accepts only ${allowed.join(', ')}`);
      const base = existing ? clean(existing) : {};
      if (patch.session) delete base.overlap;
      definition = normalizeTrigger({ ...base, ...patch, id, workspace: project, preset: 'dscode' }, { origin: 'project' });
      if (!['external', 'calendar', 'interval', 'script'].includes(definition.source.kind)) throw new Error('Agent-managed sources must be external, calendar, interval or script');
      this.runnable(definition);
      definition.path = this.write(project, definition, existing);
      // Creating/editing a recurring source also registers it; external has no cadence.
      this.withStore(s => definition.source.kind === 'external' ? s.unregister(id, project, this.now()) : s.register(definition, project, this.now()));
    } else {
      definition = this.definition(project, id);
      if (action === 'register') {
        this.runnable(definition);
        this.withStore(s => s.register(definition, project, this.now()));
      } else if (action === 'unregister') this.withStore(s => s.unregister(id, project, this.now()));
      else {
        if (definition.origin !== 'project') throw new Error('Only project-local definitions can be enabled or disabled');
        definition.enabled = action === 'enable';
        if (definition.enabled) this.runnable(definition);
        this.write(project, definition, definition);
      }
    }
    return { definition, action, scheduler: await this.status() };
  }
  async source(args, agent) {
    const project = this.workspace(agent);
    const definition = this.definition(project, args.trigger_id);
    if (definition.source.kind !== 'script') throw new Error('source management requires a script source');
    const source = this.withStore(s => {
      if (['status', 'logs'].includes(args.action)) return s.source(definition.id, project);
      this.runnable(definition);
      return s.controlSource(definition, project, args.action);
    });
    if (args.action === 'logs') return { log: source?.log ?? '' };
    return { source: source ?? { status: 'unregistered' }, scheduler: await this.status() };
  }
  async emit(args, agent) {
    const project = this.workspace(agent);
    const definition = this.definition(project, args.trigger_id);
    this.runnable(definition);
    const job = this.withStore(s => s.acceptEvent({ definition, project, payload: args.event ?? {}, eventId: args.eventId, now: this.now() }));
    return { job, scheduler: await this.status() };
  }
  async jobs(args, agent) {
    const project = this.workspace(agent);
    const now = this.now();
    if (args.action === 'list') {
      const limit = args.limit ?? 50;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be 1..100');
      return { jobs: this.withStore(s => s.list(args.trigger_id).filter(j => j.project === project && j.workspace === project).slice(0, limit)), scheduler: await this.status() };
    }
    if (args.action === 'cancel') {
      required(args.job_id, 'job_id');
      return this.withStore(s => {
        const job = s.get(args.job_id);
        if (!job || job.project !== project || job.workspace !== project) throw new Error('No job in this workspace');
        if (job.state !== 'cancelled') s.cancel(job.id, now);
        return { job: s.get(job.id) };
      });
    }
    if (args.action !== 'schedule') throw new Error('Unknown job action');
    const definition = this.definition(project, args.trigger_id);
    this.runnable(definition);
    const requestKey = required(args.idempotency_key, 'idempotency_key');
    if (requestKey.length > 200) throw new Error('idempotency_key must be at most 200 characters');
    const payload = args.event ?? {};
    normalizeEvent(definition.id, payload, { eventId: 'validation', now });
    // Lookup a retry before future-time validation: its original due time may have passed.
    const request = stable({ triggerId: definition.id, after: args.after, at: args.at, payload });
    const job = this.withStore(s => s.createOnce({ requestKey, request, triggerId: definition.id, project, workspace: project, payload, dueAt: () => dueTime(args, now), now }));
    return { job, scheduler: await this.status() };
  }
  async scheduler(args) {
    if (args.action === 'status') return this.status();
    if (args.action !== 'install') throw new Error('Scheduler action must be status or install');
    if (!this.dscodePath || !isAbsolute(this.dscodePath) || !existsSync(this.dscodePath)) throw new Error('Restart DSCODE to provide its launcher path, or install the scheduler through the CLI');
    const messages = [];
    await this.service('install', { home: this.home, dscodePath: this.dscodePath, platform: this.platform, launchctl: this.runLaunchctl, out: text => messages.push(text) });
    return { messages, scheduler: await this.status() };
  }
}
