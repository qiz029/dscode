import { existsSync } from 'node:fs';
import { JobStore, formatJob } from './jobs.mjs';
import { normalizeEvent } from './spool.mjs';
import { dueTime } from './schedule.mjs';
import { runScheduler } from './scheduler.mjs';
import { schedulerService } from './scheduler-service.mjs';
import { acquireTriggerLease } from './lease.mjs';
import { appendRun, readRuns } from './log.mjs';

export const JOB_COMMANDS = ['schedule', 'jobs', 'cancel', 'scheduler', 'run-job'];

export async function handleJobCommand(options, context) {
  const { home, project, now, platform, dscodePath, launchctl, out, err, deps, findDefinition, readEventBody } = context;
  if (options.command === 'scheduler') {
    if (!['start', 'tick', 'install', 'uninstall', 'status'].includes(options.id)) throw new Error('scheduler expects start, tick, install, uninstall or status');
    if (options.id === 'status') {
      const lease = await acquireTriggerLease(home, '_scheduler');
      out(lease ? 'scheduler stopped' : 'scheduler running');
      lease?.release();
      return 0;
    }
    if (!dscodePath || !existsSync(dscodePath)) throw new Error('the scheduler needs a valid dscode program path');
    if (['install', 'uninstall'].includes(options.id)) {
      await schedulerService(options.id, { home, dscodePath, platform, launchctl, agentsDirectory: deps.agentsDirectory, out });
      return 0;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
    try {
      out(`scheduler ${options.id}: ${home}`);
      return await runScheduler({ home, dscodePath, once: options.id === 'tick', signal: controller.signal, spawnWorker: deps.spawnWorker, report: err });
    } finally { for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, stop); }
  }
  const store = new JobStore(home);
  try {
    if (options.command === 'jobs') {
      const jobs = store.list(options.id || undefined);
      out(jobs.length ? jobs.map(formatJob).join('\n') : 'No jobs scheduled.');
      return 0;
    }
    if (options.command === 'cancel') {
      store.cancel(options.id, now);
      out(`cancelled ${options.id}`);
      return 0;
    }
    if (options.command === 'schedule') {
      const definition = findDefinition(home, project, options.id);
      const dueAt = dueTime(options, now);
      const payload = (await readEventBody(options, deps.stdin ?? process.stdin)) ?? {};
      normalizeEvent(definition.id, payload, { eventId: 'validation', now });
      if (options.eventId !== undefined) throw new Error('schedule assigns a jobId; --event-id is only for emit/fire/run');
      const job = store.create({ triggerId: definition.id, project, workspace: definition.workspace, payload, dueAt, now });
      out(formatJob(job));
      out('The scheduler delivers this job: dscode trigger scheduler install (or scheduler start).');
      return 0;
    }
    return await executeJob(store, options.id, context);
  } finally { store.close(); }
}

export async function executeJob(store, id, context) {
  const { home, now, deps, out, err, executeEvent, findDefinition } = context;
  const job = store.get(id);
  if (!job) throw new Error(`no job "${id}"`);
  if (job.state !== 'pending' || job.availableAt > now) { out(formatJob(job)); return 0; }
  const triggerLease = await acquireTriggerLease(home, job.triggerId);
  if (!triggerLease) { store.defer(id, 'already_running', now + 1000); return 0; }
  let handle;
  try {
    let definition;
    try { definition = findDefinition(home, job.project, job.triggerId); }
    catch (error) { store.defer(id, 'definition_missing', now + 30000); err(error.message); return 0; }
    if (definition.workspace !== job.workspace) {
      store.defer(id, 'workspace_changed', now + 30000);
      err(`job ${id} belongs to ${job.workspace}; cancel it and schedule a new job for the changed workspace`);
      return 0;
    }
    const eventId = store.eventIdentity(job.id) ?? `job:${job.id}`;
    const chosen = normalizeEvent(job.triggerId, { source: job.kind, ...JSON.parse(job.payload) }, { eventId, now: job.createdAt });
    const result = await executeEvent(definition, {
      home, now, deps, out, err, triggerLease, chosen, eventId, jobId: id, quietSkips: true,
      beforeRun: planned => { handle = planned; return store.claim(id, planned.runId, now); },
    });
    if (result.skip) {
      let availableAt = now + 30000;
      const runs = readRuns(home, { triggerId: job.triggerId, limit: 0 }).filter(r => r.outcome !== 'skipped');
      if (result.skip === 'too_soon' && runs[0]) availableAt = runs[0].startedAt + definition.limits.minIntervalSeconds * 1000;
      if (result.skip === 'over_daily_limit') {
        const withinDay = runs.filter(r => r.startedAt > now - 86400000).sort((a, b) => a.startedAt - b.startedAt);
        if (withinDay[0]) availableAt = withinDay[0].startedAt + 86400000;
      }
      if (result.skip === 'duplicate') {
        // Reconcile a durable run record after a crash before job-state update.
        const previous = runs.find(r => r.eventId === eventId);
        if (store.claim(id, previous.runId, now)) store.finish(id, previous, now);
      } else store.defer(id, result.skip, availableAt);
      return 0;
    }
    store.finish(id, result.record ?? { exitCode: result.code, reason: 'no_match' });
    return result.code;
  } catch (error) {
    if (handle && store.get(id).state === 'running') {
      const record = { ...handle, jobId: id, outcome: 'failed', reason: 'model_error', exitCode: 1, endedAt: Date.now(), cwd: job.workspace };
      appendRun(home, record);
      store.finish(id, record);
    }
    throw error;
  } finally { triggerLease.release(); }
}
