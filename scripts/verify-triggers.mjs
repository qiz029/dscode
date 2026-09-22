import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { root } from './harness.mjs';
import { runTriggerCli } from './trigger.mjs';
import { runScheduler } from '../plugins/triggers/scheduler.mjs';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { normalizeTrigger } from '../plugins/triggers/config.mjs';
import { readRuns } from '../plugins/triggers/log.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-trigger-probe-'));
const overlay = join(root, 'config', 'harness.local.yml');
const trace = join(home, 'trace.jsonl');
// This probe runs in scripts/checks.mjs's isolated checkout; never overwrite a
// developer's overlay, even when invoked directly by mistake.
try {
  writeFileSync(overlay, `- id: dscode-memory\n  config:\n    generate: false\n- insert:\n    - id: trigger-fixture\n      name: ${JSON.stringify(join(root, 'scripts/trigger-fixture.mjs'))}\n`, { flag: 'wx' });
} catch (error) { rmSync(home, { recursive: true, force: true }); throw error; }
const previousTrace = process.env.DSCODE_TRIGGER_TRACE;
process.env.DSCODE_TRIGGER_TRACE = trace;
try {
  mkdirSync(join(home, 'triggers'));
  const define = (id, mode) => writeFileSync(join(home, 'triggers', `${id}.json`), JSON.stringify({
    id, workspace: home, source: { kind: 'external' }, session: { mode }, prompt: 'Handle event: {{event.text}}',
    model: 'trigger-fixture/fixture', goal: { objective: 'Complete this event in two turns', maxRounds: 4 },
    limits: { timeoutSeconds: 20, minIntervalSeconds: 1 },
  }));
  define('persistent', 'persistent');
  define('fresh', 'new');
  for (const id of ['persistent', 'fresh']) {
    for (const [index, marker] of ['FIRST_TRIGGER_MARKER', 'SECOND_TRIGGER_MARKER'].entries()) {
      if (id === 'fresh' && index > 0) await sleep(1100);
      const code = await runTriggerCli(['fire', id, '--event-id', `event-${index}`, '--text', marker], { home, project: home });
      assert.equal(code, 0, `${id} run ${index} failed`);
    }
    const runs = readRuns(home, { triggerId: id }).filter(r => r.outcome !== 'skipped').reverse();
    assert.equal(runs.length, 2);
    assert(runs.every(r => r.outcome === 'completed' && r.rounds >= 1), JSON.stringify(runs));
    assert.equal(runs[0].sessionId === runs[1].sessionId, id === 'persistent');
    const requests = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const second = requests.find(r => r.sessionId === runs[1].sessionId && JSON.stringify(r.messages).includes('SECOND_TRIGGER_MARKER'));
    assert(second, 'the second run reached the model');
    assert.equal(JSON.stringify(second.messages).includes('FIRST_TRIGGER_MARKER'), id === 'persistent', 'history follows the configured session mode');
    const goals = new Set(requests.filter(r => r.sessionId === runs[1].sessionId).map(r => r.goalId));
    assert.equal(goals.size, id === 'persistent' ? 2 : 1, 'each event has its own goal');
  }
  // Exercise the actual scheduler -> worker CLI -> Host boundary as well.
  assert.equal(await runTriggerCli(['schedule', 'persistent', '--after', '0.1s', '--text', 'DELAY_TRIGGER_MARKER'], { home, project: home }), 0);
  const jobs = new JobStore(home);
  try {
    const delayed = jobs.list()[0];
    assert.equal(await runTriggerCli(['schedule', 'fresh', '--after', '1s', '--text', 'CANCELLED_MARKER'], { home, project: home }), 0);
    const cancelled = jobs.list().find(job => job.triggerId === 'fresh');
    assert.equal(await runTriggerCli(['cancel', cancelled.id], { home, project: home }), 0);
    await sleep(1100);
    assert.equal(await runTriggerCli(['scheduler', 'tick'], { home, project: home }), 0);
    const result = jobs.get(delayed.id);
    assert.equal(result.state, 'completed', JSON.stringify(result) + '\n' + readFileSync(join(home, 'triggers', 'jobs', `${delayed.id}.log`), 'utf8'));
    assert.equal(result.sessionId, readRuns(home, { triggerId: 'persistent' }).find(run => run.eventId === 'event-0').sessionId);
    assert.equal(jobs.get(cancelled.id).state, 'cancelled');
    const recurring = {
      id: 'clock', workspace: home, source: { kind: 'calendar', cron: '* * * * *', timezone: 'UTC' },
      model: 'trigger-fixture/fixture', prompt: 'Handle scheduled event',
      goal: { objective: 'Finish this event in two turns', maxRounds: 4 }, limits: { timeoutSeconds: 20 },
    };
    writeFileSync(join(home, 'triggers', 'clock.json'), JSON.stringify(recurring));
    jobs.register(normalizeTrigger(recurring), home, Date.now() - 300000);
    assert.equal(await runTriggerCli(['scheduler', 'tick'], { home, project: home }), 0);
    const cron = jobs.list('clock');
    assert.equal(cron.length, 1, 'missed cron occurrences coalesce');
    assert.equal(cron[0].state, 'completed', JSON.stringify(cron[0]));
    const scripted = { ...recurring, id: 'scripted', source: { kind: 'script', mode: 'poll', everySeconds: 3600, timeoutSeconds: 10, command: [process.execPath, '-e', `const {spawnSync}=require('node:child_process'); const r=spawnSync('dscode',['trigger','emit','scripted','--event-id','scripted:1','--text','SCRIPT_TRIGGER_MARKER'],{stdio:'inherit'}); process.exit(r.status ?? 1)`] } };
    writeFileSync(join(home, 'triggers', 'scripted.json'), JSON.stringify(scripted));
    jobs.register(normalizeTrigger(scripted), home);
    const controller = new AbortController();
    const scheduler = runScheduler({ home, dscodePath: join(root, 'bin', 'dscode.mjs'), signal: controller.signal });
    try {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && jobs.list('scripted')[0]?.state !== 'completed') await sleep(100);
      assert.equal(jobs.list('scripted')[0]?.state, 'completed', JSON.stringify(jobs.source('scripted', home)));
      const scriptRun = readRuns(home, { triggerId: 'scripted' })[0];
      assert.equal(scriptRun.eventId, 'scripted:1');
      assert(scriptRun.sessionId);
    } finally { controller.abort(); await scheduler; }
  } finally { jobs.close(); }
  console.log('TRIGGER_PROBE_PASSED: real Hosts, two-turn goals, durable resume with prior context, and isolated new sessions; durable delay, cancellation, recovered cron and sandboxed script ingress through worker processes; local fixture model, no provider calls');
} finally {
  if (previousTrace === undefined) delete process.env.DSCODE_TRIGGER_TRACE;
  else process.env.DSCODE_TRIGGER_TRACE = previousTrace;
  rmSync(overlay, { force: true });
  rmSync(socketDirectory(home), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
