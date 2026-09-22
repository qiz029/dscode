import { SourceSupervisor } from './sources.mjs';
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobStore } from './jobs.mjs';
import { loadTriggerDefinitions } from './config.mjs';
import { acquireTriggerLease } from './lease.mjs';
import { alivePid } from './run.mjs';
import { readRuns } from './log.mjs';

export function launchJobWorker({ home, dscodePath, job }) {
  const directory = join(home, 'triggers', 'jobs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, `${job.id}.log`), 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [dscodePath, 'trigger', 'run-job', job.id], {
      cwd: home, env: { ...process.env, DSH_HOME: home, DSCODE_HOME: home },
      stdio: ['ignore', fd, fd],
    });
  } finally { closeSync(fd); }
  // Workers may finish after the scheduler exits. Their trigger leases and
  // durable claims still exclude a replacement scheduler from double-running.
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 130));
  });
}

/** One scan; active promises are tracked separately so model latency cannot stop the clock. */
export async function schedulerTick({ home, store, active, dscodePath, now = Date.now(), spawnWorker = launchJobWorker, report = console.error }) {
  const definitions = new Map();
  const resolve = saved => {
    if (!definitions.has(saved.project)) {
      const found = loadTriggerDefinitions({ home, workspace: saved.project });
      for (const problem of found.problems) report(`${problem.path}: ${problem.message}`);
      definitions.set(saved.project, found.definitions);
    }
    return definitions.get(saved.project).find(d => d.id === saved.triggerId);
  };
  store.materialize(resolve, now);
  for (const job of store.running()) {
    if (alivePid(job.pid)) continue;
    const lease = await acquireTriggerLease(home, job.triggerId);
    if (!lease) continue; // its orphaned Host still owns the descriptor
    try {
      const result = readRuns(home, { triggerId: job.triggerId, limit: 0 }).find(run => run.runId === job.runId);
      store.finish(job.id, result ?? { exitCode: 130, reason: 'interrupted' }, now);
    } finally { lease.release(); }
  }
  const busy = new Set([...active.values()].map(entry => entry.triggerId));
  for (const job of store.pending(now)) {
    if (active.size >= 4) break;
    if (busy.has(job.triggerId)) continue;
    busy.add(job.triggerId);
    const promise = Promise.resolve().then(() => spawnWorker({ home, dscodePath, job })).then(code => {
      if (code && store.get(job.id)?.state === 'pending') store.defer(job.id, 'worker_start_failed', Date.now() + 30000);
    }).catch(error => {
      report(`scheduler ${job.id}: ${error.message}`);
      store.defer(job.id, 'worker_start_failed', Date.now() + 30000);
    }).finally(() => { active.delete(job.id); });
    active.set(job.id, { triggerId: job.triggerId, promise });
  }
}

export async function runScheduler({ home, dscodePath, once = false, signal, spawnWorker, report = console.error }) {
  const lease = await acquireTriggerLease(home, '_scheduler');
  if (!lease) throw new Error('the scheduler is already running for this state directory');
  let store, sources;
  const active = new Map();
  try {
    store = new JobStore(home);
    sources = new SourceSupervisor({ home, store, report });
    do {
      if (!once) sources.tick();
      await schedulerTick({ home, store, active, dscodePath, spawnWorker, report });
      if (once) break;
      await sleep(1000, undefined, { signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
    } while (!signal?.aborted);
    await sources.close();
    await Promise.allSettled([...active.values()].map(entry => entry.promise));
    return 0;
  } finally {
    await sources?.close();
    await Promise.allSettled([...active.values()].map(entry => entry.promise));
    store?.close();
    lease.release();
  }
}
