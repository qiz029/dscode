import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { createDesktopTriggerScheduler } from '../plugins/triggers/desktop-scheduler.mjs';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { normalizeTrigger } from '../plugins/triggers/config.mjs';
import { readRuns } from '../plugins/triggers/log.mjs';

export const inject = ['agents', 'sessions', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'llm', 'goals', 'jobs'];
export function apply(ctx) { void run(ctx).catch(error => {
  console.error(error.stack);
  if (process.env.DSCODE_SCHEDULER_ELECTRON) process.send({ type: 'dscode-scheduler-failed' });
  else ctx.get('appExit')(1);
}); }
async function run(ctx) {
  await ctx.get('loader').await();
  const home = process.env.DSH_HOME, project = process.cwd(), phase = process.env.DSCODE_SCHEDULER_PHASE;
  const store = new JobStore(home), calls = new Map(), seen = [], stalls = new Set();
  const scheduler = createDesktopTriggerScheduler(ctx, { home });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const agent = ctx.agents.currentInitiator();
      if (options.model === 'stall') {
        stalls.add(agent.id);
        await new Promise((resolve, reject) => {
          const abort = () => { stalls.delete(agent.id); reject(options.signal.reason); };
          if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
        });
      }
      const goal = ctx.goals.get(agent);
      const count = (calls.get(goal.id) ?? 0) + 1; calls.set(goal.id, count);
      seen.push(JSON.stringify(options.messages));
      if (count >= 2) ctx.goals.complete(agent, { id: goal.id, revision: goal.revision });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DESKTOP_SCHEDULED_OK' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-scheduler-fixture'], new Adapter());
  const define = (id, extra = {}) => {
    const definition = normalizeTrigger({ id, workspace: project, source: { kind: 'external' }, preset: 'dscode', permission: 'workspace-write',
      session: { mode: 'new' }, model: 'desktop-scheduler-fixture/fixture', prompt: 'Handle {{event.text}}',
      goal: { objective: 'Complete in two turns', maxRounds: 4 }, limits: { timeoutSeconds: 15, minIntervalSeconds: 1 }, ...extra });
    mkdirSync(join(home, 'triggers'), { recursive: true });
    writeFileSync(join(home, 'triggers', id + '.json'), JSON.stringify(Object.fromEntries(Object.entries(definition).filter(([key]) => !['origin', 'path'].includes(key)))));
    return definition;
  };
  const queue = (id, text, dueAt = Date.now()) => store.create({ triggerId: id, project, workspace: project, payload: { text }, dueAt });
  const wait = async predicate => {
    const until = Date.now() + 20000;
    while (!predicate()) { assert(Date.now() < until, JSON.stringify(store.list())); await delay(25); }
  };
  const complete = job => wait(() => ['completed', 'failed'].includes(store.get(job.id).state)).then(() => assert.equal(store.get(job.id).state, 'completed', JSON.stringify(store.get(job.id))));
  const snapshot = join(home, 'scheduler-probe.json');
  const nativeCheckpoint = async state => {
    if (!process.env.DSCODE_SCHEDULER_ELECTRON) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { process.off('message', answer); reject(Error(`Native checkpoint timed out: ${state}`)); }, 20000);
      const answer = message => {
        if (message?.type !== 'dscode-scheduler-continue' || message.state !== state) return;
        clearTimeout(timer); process.off('message', answer); resolve();
      };
      process.on('message', answer);
      process.send({ type: 'dscode-scheduler-check', state });
    });
  };
  try {
    assert.equal(scheduler.status().running, false);
    if (phase === 'initial') {
      await nativeCheckpoint('stopped');
      await scheduler.start();
      await nativeCheckpoint('idle');
      await scheduler.stop();
      await nativeCheckpoint('stopped-again');
      const definition = define('desktop-persistent', { session: { mode: 'persistent' } });
      define('desktop-fresh'); define('desktop-stall', { model: 'desktop-scheduler-fixture/stall' });
      const first = queue(definition.id, 'SCHEDULER_FIRST_HOST');
      const cancelled = queue('desktop-fresh', 'MUST_NOT_RUN', Date.now() + 10000); store.cancel(cancelled.id);
      await scheduler.start();
      assert.equal(scheduler.status().running, true);
      const nativeJob = scheduler.status().job_id;
      assert.equal(ctx.jobs.get(nativeJob).status, 'running');
      assert(ctx.jobs.list().some(row => row.id === nativeJob && row.owner === undefined));
      await complete(first);
      const original = store.acceptEvent({ definition, project, eventId: 'stable-event', payload: { text: 'DEDUPLICATED_EVENT' } });
      const duplicate = store.acceptEvent({ definition, project, eventId: 'stable-event', payload: { text: 'DEDUPLICATED_EVENT' } });
      assert.equal(original.id, duplicate.id);
      await complete(original);
      assert.equal(store.get(first.id).sessionId, store.get(original.id).sessionId);
      assert.equal(readRuns(home, { triggerId: definition.id }).filter(row => row.eventId === 'stable-event').length, 1);
      const recurring = define('desktop-recurring', { source: { kind: 'interval', seconds: 3600 } });
      store.register(recurring, project, Date.now() - 10800000);
      await wait(() => store.list(recurring.id).some(row => row.state === 'completed'));
      assert.equal(store.list(recurring.id).length, 1, 'Missed intervals must coalesce');
      store.unregister(recurring.id, project);
      const script = define('desktop-script', { source: { kind: 'script', mode: 'daemon', command: [process.execPath, '-e',
        `const {spawnSync}=require('node:child_process'); for(let i=0;i<2;i++){const r=spawnSync('dscode',['trigger','emit','desktop-script','--event-id','script:once','--text','SCRIPT_QUEUE_EVENT'],{stdio:'inherit'});if(r.status!==0)process.exit(1)} setInterval(()=>{},1000);` ] } });
      store.register(script, project);
      await wait(() => store.list(script.id).some(row => row.state === 'completed'));
      assert.equal(store.list(script.id).length, 1, 'Repeated script ingress created a second job');
      const producerPid = store.source(script.id, project).pid;
      assert(Number.isSafeInteger(producerPid));
      const stalled = queue('desktop-stall', 'STOP_RUNNING');
      await wait(() => store.get(stalled.id).state === 'running' && stalls.size > 0);
      const pending = queue('desktop-fresh', 'AFTER_STOP', Date.now() + 1000);
      ctx.jobs.kill(nativeJob, undefined, 'Stop through native background-job control');
      assert.equal((await ctx.jobs.wait(nativeJob, 20000)).status, 'killed');
      assert.equal(scheduler.status().running, false);
      assert.throws(() => process.kill(producerPid, 0), error => error.code === 'ESRCH');
      assert.equal(store.source(script.id, project).status, 'stopped');
      store.controlSource(script, project, 'stop');
      assert.equal(stalls.size, 0); assert.equal(store.get(stalled.id).reason, 'interrupted');
      assert.equal(store.get(stalled.id).state, 'failed');
      assert.equal(store.get(pending.id).state, 'pending');
      await scheduler.start(); await complete(pending); await scheduler.stop();
      assert.equal(store.get(cancelled.id).state, 'cancelled');
      assert(!seen.some(text => text.includes('MUST_NOT_RUN')));
      assert.equal(ctx.agents.roots().length, 0);
      writeFileSync(snapshot, JSON.stringify({ firstSession: store.get(first.id).sessionId }));
    } else if (phase === 'crash') {
      await scheduler.start();
      const crash = queue('desktop-stall', 'CRASHED_RUN');
      await wait(() => store.get(crash.id).state === 'running' && stalls.size > 0);
      const pending = queue('desktop-persistent', 'SCHEDULER_SECOND_HOST', Date.now() + 1000);
      writeFileSync(snapshot, JSON.stringify({ ...JSON.parse(readFileSync(snapshot, 'utf8')), crash: crash.id, pending: pending.id }));
      console.log('DESKTOP_SCHEDULER_CRASH_READY');
      await new Promise(() => {}); // parent kills this exact Host after the durable claim
    } else if (phase === 'recover') {
      const saved = JSON.parse(readFileSync(snapshot, 'utf8'));
      assert.equal(store.get(saved.crash).state, 'running');
      assert.equal(store.get(saved.pending).state, 'pending');
      await scheduler.start();
      await complete({ id: saved.pending });
      assert.equal(store.get(saved.crash).state, 'failed');
      assert.equal(store.get(saved.crash).reason, 'interrupted');
      assert.equal(store.get(saved.pending).sessionId, saved.firstSession);
      assert(seen.some(text => text.includes('SCHEDULER_FIRST_HOST') && text.includes('SCHEDULER_SECOND_HOST')));
      assert.equal(stalls.size, 0, 'A crashed running job was automatically repeated');
      await scheduler.stop();
    } else if (phase === 'shutdown') {
      const script = define('shutdown-script', { source: { kind: 'script', mode: 'daemon', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] } });
      store.register(script, project);
      await scheduler.start();
      const running = queue('desktop-stall', 'QUIT_RUNNING');
      await wait(() => store.get(running.id).state === 'running' && stalls.size > 0 && store.source(script.id, project)?.pid);
      const pending = queue('desktop-fresh', 'AFTER_QUIT', Date.now() + 60000);
      writeFileSync(snapshot, JSON.stringify({ ...JSON.parse(readFileSync(snapshot, 'utf8')), shutdown: {
        running: running.id, pending: pending.id, producerPid: store.source(script.id, project).pid, sourceId: store.source(script.id, project).id,
      } }));
      assert.equal(ctx.jobs.get(scheduler.status().job_id).status, 'running');
      // No explicit scheduler.stop: the real Host must drain its disposal hook
      // and native job cancellation before exiting with a successful status.
      await nativeCheckpoint('shutdown');
    } else {
      throw Error(`Unknown scheduler probe phase: ${phase}`);
    }
    console.log('DESKTOP_SCHEDULER_PASSED ' + JSON.stringify({ phase, durableQueue: true, noAutomaticRestartOfInterruptedJob: true,
      ...(phase === 'initial' ? { scriptIngressDeduplicated: true, sourceProcessDrained: true, nativeJobCancellation: true } : {}), liveModelInference: false }));
  } finally { if (phase !== 'shutdown') await scheduler.dispose(); store.close(); }
  if (process.env.DSCODE_SCHEDULER_ELECTRON) {
    process.send({ type: 'dscode-scheduler-shutdown' });
  } else ctx.get('appExit')(0);
}
