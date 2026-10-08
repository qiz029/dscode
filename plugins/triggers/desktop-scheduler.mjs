// Desktop queue owner. Management/UI chooses when to start it; merely loading
// this module creates no jobs, timers, service registration or OS launch agent.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { runScheduler } from './scheduler.mjs';
import { runTriggerCli } from './cli.mjs';
import { loadTriggerDefinitions } from './config.mjs';
import { startTriggerSession } from './session-run.mjs';

export class DesktopTriggerScheduler {
  constructor(ctx, { home, jobs = ctx.get?.('jobs'), report = message => ctx.logger.warn(message) }) {
    this.ctx = ctx; this.home = home; this.report = report; this.jobs = jobs;
    this.task = undefined; this.ready = undefined; this.controller = undefined;
    this.stopping = false; this.error = undefined; this.disposed = false;
  }
  status() {
    return { running: !!this.task && this.started === true && !this.stopping,
      stopping: this.stopping, owner: 'desktop', requires_open_application: true,
      ...(this.jobId ? { job_id: this.jobId } : {}),
      ...(this.error ? { error: this.error } : {}) };
  }
  async start() {
    if (this.disposed) throw Error('Desktop scheduler has been disposed.');
    if (this.stopping) throw Error('Desktop scheduler is stopping; wait until it has drained before starting again.');
    if (this.task) { await this.ready; return this.status(); }
    const ready = Promise.withResolvers();
    this.ready = ready.promise;
    this.controller = new AbortController(); this.error = undefined; this.started = false;
    const signal = this.controller.signal;
    const launch = () => runScheduler({ home: this.home, signal,
      onReady: () => { this.started = true; ready.resolve(); },
      spawnWorker: request => this.execute(request.job, signal), report: this.report,
    });
    let task, detach;
    try {
      if (this.jobs) {
        detach = this.jobs.attachController('DSCODE Desktop scheduler');
        // Register before dispatching anything. Native quit/update inspection
        // sees this global job even while the queue has no live Agent. Its
        // cancellation hook drains both Agents and supervised script sources.
        this.jobId = this.jobs.start({ kind: 'dscode-scheduler', label: 'DSCODE scheduler — requires the application to stay open',
          run: handle => {
            handle.updateProgress('Waiting for scheduled work');
            task = launch();
            return { cancel: reason => this.requestStop(reason), done: task.then(
              () => ({ status: signal.aborted ? 'killed' : 'completed' }),
              error => ({ status: 'failed', detail: error.message }),
            ) };
          },
        });
      } else task = launch();
    } catch (error) {
      detach?.(); this.controller = undefined; this.ready = undefined;
      this.error = error.message;
      throw error;
    }
    this.task = task;
    // Completion is observed even when a UI no longer waits on its start request.
    void task.catch(error => { this.error = error.message; ready.reject(error); this.report(error.message); }).finally(() => {
      detach?.();
      if (this.task === task) { this.task = undefined; this.controller = undefined; this.started = false; this.stopping = false; }
    });
    await this.ready;
    return this.status();
  }
  async stop() {
    const task = this.task;
    if (!task) return this.status();
    this.requestStop();
    try { await task; } finally {
      if (this.task === task) { this.task = undefined; this.controller = undefined; this.started = false; this.stopping = false; }
    }
    return this.status();
  }
  requestStop(reason = 'Desktop scheduler stopped') {
    if (!this.controller) return;
    this.stopping = true;
    this.controller.abort(new Error(reason));
  }
  async dispose() {
    this.disposed = true;
    return this.stop();
  }
  async execute(job, signal) {
    if (signal.aborted) return 0; // leave unclaimed work pending for the next owner
    // Do not let manually edited files bypass the same bounds as agent-managed
    // definitions. CLI-only presets and elevated unattended modes stay excluded.
    const definition = loadTriggerDefinitions({ home: this.home, workspace: job.project }).definitions.find(row => row.id === job.triggerId);
    if (definition && (definition.preset !== 'dscode' || !['read-only', 'workspace-write'].includes(definition.permission))) {
      throw Error('Desktop scheduling requires the dscode preset and read-only or workspace-write permission');
    }
    const directory = join(this.home, 'triggers/jobs'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = { write: text => appendFileSync(join(directory, `${job.id}.log`), text, { mode: 0o600 }) };
    return runTriggerCli(['run-job', job.id], { home: this.home, project: job.project, stdout: log, stderr: log,
      spawnRun: async ({ spec }) => {
        if (spec.preset !== 'dscode' || !['read-only', 'workspace-write'].includes(spec.permission)) throw Error('Unsupported Desktop trigger preset or permission');
        const deadline = AbortSignal.timeout(spec.limits.timeoutSeconds * 1000);
        const combined = AbortSignal.any([signal, deadline]);
        const stopped = () => ({ outcome: deadline.aborted && !signal.aborted ? 'timedout' : 'failed',
          reason: deadline.aborted && !signal.aborted ? 'timeout' : 'interrupted', exitCode: deadline.aborted && !signal.aborted ? 124 : 130,
          sessionId: null, cost: null, rounds: null });
        if (combined.aborted) { const result = stopped(); return { code: result.exitCode, result }; }
        try {
          const run = await startTriggerSession(this.ctx, { spec, home: this.home, signal: combined,
            prepare: (scope, agent) => installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }),
          });
          let result = await run.done;
          if (result.reason === 'interrupted' && deadline.aborted && !signal.aborted) result = { ...result, outcome: 'timedout', reason: 'timeout', exitCode: 124 };
          return { code: result.exitCode, result };
        } catch (error) {
          if (!combined.aborted) throw error;
          const result = stopped(); return { code: result.exitCode, result };
        }
      },
    });
  }
}

/** Bind shutdown and plugin removal to the same drain as an explicit stop. */
export function createDesktopTriggerScheduler(ctx, options) {
  const scheduler = new DesktopTriggerScheduler(ctx, options);
  ctx.effect(() => () => scheduler.dispose(), 'dscode scheduler drain');
  return scheduler;
}
