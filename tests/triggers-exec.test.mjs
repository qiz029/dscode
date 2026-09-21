import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideStop } from '../plugins/triggers/run.mjs';
import { readRunResult, readRunSpec, renderPrompt, writeRunResult, writeRunSpec } from '../plugins/triggers/options.mjs';
import { triggerOverlay } from '../plugins/triggers/host.mjs';
import { readRuns } from '../plugins/triggers/log.mjs';
import { emitEvent, listEvents } from '../plugins/triggers/spool.mjs';
import { lockPath } from '../plugins/triggers/run.mjs';
import { parseTriggerArgs, runTriggerCli, USAGE } from '../scripts/trigger.mjs';

// The execution half: how a run ends, what crosses into the spawned Host, and
// what the CLI records. The Host itself needs a real Harness, so the CLI is
// driven with an injected spawn that returns the result the Host would report.

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
/** A few fields of one value, for compact assertions. */
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

const goal = overrides => ({ id: 'g1', revision: 1, objective: 'o', phase: 'active', maxGoalRounds: 20, roundsStarted: 0, activation: 'armed', createdAt: 0, updatedAt: 0, ...overrides });

test('a run stops on the goal end, a cap, a pause, or a timeout', () => {
  assert.deepEqual(decideStop({ goal: goal({}), limits: {} }), { stop: false });
  assert.deepEqual(decideStop({ goal: goal({ phase: 'complete' }), limits: {} }), { stop: true, outcome: 'completed', reason: null, exitCode: 0 });
  assert.deepEqual(decideStop({ goal: goal({ phase: 'blocked' }), limits: {} }), { stop: true, outcome: 'blocked', reason: 'goal_blocked', exitCode: 3 });
  assert.deepEqual(decideStop({ goal: goal({ phase: 'paused' }), limits: {} }), { stop: true, outcome: 'failed', reason: 'goal_paused', exitCode: 3 });
  assert.deepEqual(decideStop({ goal: goal({ roundsStarted: 20 }), limits: {} }), { stop: true, outcome: 'overrun', reason: 'round_cap', exitCode: 2 });
  assert.deepEqual(decideStop({ goal: goal({ roundsStarted: 3 }), costUsd: 1.5, limits: { maxCostUsd: 1 } }), { stop: true, outcome: 'overrun', reason: 'cost_cap', exitCode: 2 });
  // A run that needed a human says so when a cap or the timeout stops it...
  assert.deepEqual(decideStop({ goal: goal({ roundsStarted: 20 }), limits: {}, approvalsRejected: true }), { stop: true, outcome: 'overrun', reason: 'approval_required', exitCode: 2 });
  // ...but a goal that was actually reached is a completion, not a failure.
  assert.deepEqual(decideStop({ goal: goal({ phase: 'complete' }), limits: {}, approvalsRejected: true }), { stop: true, outcome: 'completed', reason: null, exitCode: 0 });
  // A cleared goal leaves nothing to continue for.
  assert.deepEqual(decideStop({ goal: undefined, limits: {} }), { stop: true, outcome: 'completed', reason: null, exitCode: 0 });
});

test('the prompt is the template plus the event it came from', () => {
  assert.equal(renderPrompt('review the diff'), 'review the diff');
  assert.equal(renderPrompt('look at {{event.fields.branch}} ({{event.source}})', { source: 'ci', fields: { branch: 'main' } }), 'look at main (ci)');
  assert.equal(renderPrompt('', { source: 'ci', title: 'build', text: 'it broke' }), 'Event (ci): build: it broke');
  // A template that never mentions the event still carries it.
  assert.equal(renderPrompt('review the diff', { source: 'ci', text: 'it broke' }), 'review the diff\n\nEvent (ci): it broke');
  assert.equal(renderPrompt('review {{event.text}}', { text: 'it broke' }), 'review it broke');
  assert.equal(renderPrompt('x {{event.fields.missing}} y', { fields: {} }), 'x  y');
});

test('the run spec and the run result survive the process boundary', () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-trigger-io-'));
  const specPath = join(root, 'run.json');
  const spec = { triggerId: 't', runId: 'r', workspace: '/work/repo', prompt: 'do it', goal: { objective: 'o', maxRounds: 5 }, limits: { timeoutSeconds: 60 } };
  writeRunSpec(specPath, spec);
  assert.deepEqual(readRunSpec(specPath), spec);
  assert.throws(() => writeRunSpec(join(root, 'bad.json'), { triggerId: 't', runId: 'r', workspace: '/w', prompt: 'p', goal: { objective: 'o', maxRounds: 0 } }), /positive goal\.maxRounds/);
  assert.throws(() => readRunSpec(join(root, 'missing.json')), /unreadable/);

  writeRunResult(`${specPath}.result.json`, { outcome: 'completed', reason: null, exitCode: 0, sessionId: 's1', cost: 0.4, rounds: 2 });
  assert.deepEqual(readRunResult(`${specPath}.result.json`), { outcome: 'completed', reason: null, exitCode: 0, sessionId: 's1', cost: 0.4, rounds: 2 });
  // A child that died before reporting leaves no result, and the parent decides.
  assert.equal(readRunResult(join(root, 'none.json')), undefined);
  assert.throws(() => writeRunResult(join(root, 'bad-result.json'), { outcome: 'completed' }), /needs an exitCode/);
  rmSync(root, { recursive: true, force: true });
});

test('the trigger overlay replaces the terminal with the host', () => {
  const overlay = triggerOverlay('/plugins/triggers/host.mjs');
  for (const id of ['tui-startup', 'tui-runner']) assert.match(overlay, new RegExp(`- id: ${id}\\n  disabled: true`));
  assert.match(overlay, /id: dscode-session-cards\n {2}config:\n {4}enabled: false/);
  assert.match(overlay, /- id: dscode-trigger-host\n {6}name: "\/plugins\/triggers\/host\.mjs"/);
});

function fixture(t, definition = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-trigger-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const project = join(root, 'project');
  const workspace = join(root, 'repo');
  mkdirSync(join(project, '.dsh', 'triggers'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(project, '.dsh', 'triggers', 'nightly.yml'), [
    'id: nightly',
    `workspace: ${workspace}`,
    'prompt: review the diff',
    'source: { kind: external }',
    'goal: { objective: keep the build green, maxRounds: 6 }',
    'limits: { timeoutSeconds: 30, maxRunsPerDay: 3, minIntervalSeconds: 60 }',
    ...Object.entries(definition).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
  ].join('\n') + '\n');
  const output = { out: '', err: '' };
  const capture = { write: text => { output.out += text; } };
  const captureErr = { write: text => { output.err += text; } };
  return { root, home, project, workspace, output, capture, captureErr };
}

test('the CLI records a run the host completed and releases its lock', async t => {
  const f = fixture(t);
  const specs = [];
  const code = await runTriggerCli(['run', 'nightly'], {
    home: f.home, project: f.project, now: NOW, stdout: f.capture, stderr: f.captureErr,
    spawnRun: async ({ spec }) => {
      specs.push(spec);
      return { code: 0, result: { outcome: 'completed', reason: null, exitCode: 0, sessionId: 'session-9', cost: 0.5, rounds: 2 } };
    },
  });
  assert.equal(code, 0);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].prompt, 'review the diff');
  assert.deepEqual(specs[0].goal, { objective: 'keep the build green', maxRounds: 6 });
  assert.equal(specs[0].workspace, f.workspace);
  const runs = readRuns(f.home, { triggerId: 'nightly' });
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].outcome, runs[0].exitCode, runs[0].sessionId, runs[0].cost, runs[0].rounds], ['completed', 0, 'session-9', 0.5, 2]);
  assert.throws(() => readFileSync(lockPath(f.home, 'nightly'), 'utf8'), 'the lock is released');
  assert.match(f.output.out, /nightly .* completed exit 0 \$0\.50 2r · session-9/);
});

test('a repeat inside the minimum interval is skipped, not run', async t => {
  const f = fixture(t);
  let spawns = 0;
  const deps = { home: f.home, project: f.project, stdout: f.capture, stderr: f.captureErr, spawnRun: async () => { spawns += 1; return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, now: NOW }), 0);
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, now: NOW + 1000 }), 0);
  assert.equal(spawns, 1, 'the second run never spawned');
  assert.match(f.output.err, /skipped nightly: too_soon/);
  const runs = readRuns(f.home, { triggerId: 'nightly' });
  assert.deepEqual(runs.map(run => run.outcome), ['skipped', 'completed']);
});

test('an emitted event travels into the prompt, and fire posts its own', async t => {
  const f = fixture(t);
  const specs = [];
  const deps = { home: f.home, project: f.project, now: NOW, stdout: f.capture, stderr: f.captureErr, spawnRun: async ({ spec }) => { specs.push(spec); return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };
  assert.equal(await runTriggerCli(['emit', 'nightly', '--text', 'the build failed'], { ...deps, eventId: 'e1' }), 0);
  assert.equal(listEvents(f.home, 'nightly').length, 1);
  assert.equal(await runTriggerCli(['run', 'nightly'], deps), 0);
  assert.equal(listEvents(f.home, 'nightly').length, 0, 'the event is consumed when the run starts');
  assert.match(specs.at(-1).prompt, /review the diff\n\nEvent \(cli\): the build failed/);

  assert.equal(await runTriggerCli(['fire', 'nightly', '--text', 'fire me'], { ...deps, now: NOW + 120000, eventId: 'e2' }), 0);
  assert.equal(readRuns(f.home, { triggerId: 'nightly' })[0].eventId, 'e2');
  assert.match(specs.at(-1).prompt, /fire me/);
});

test('a failed host is recorded with its own outcome and exit code', async t => {
  const f = fixture(t);
  const code = await runTriggerCli(['run', 'nightly'], {
    home: f.home, project: f.project, now: NOW, stdout: f.capture, stderr: f.captureErr,
    spawnRun: async () => ({ code: 3, result: { outcome: 'blocked', reason: 'goal_blocked', exitCode: 3, rounds: 6 } }),
  });
  assert.equal(code, 3);
  const run = readRuns(f.home, { triggerId: 'nightly' })[0];
  assert.deepEqual([run.outcome, run.reason, run.exitCode, run.rounds], ['blocked', 'goal_blocked', 3, 6]);
  // A host that dies without reporting still leaves an explanation.
  const g = fixture(t);
  const fallen = await runTriggerCli(['run', 'nightly'], { home: g.home, project: g.project, now: NOW, stdout: g.capture, stderr: g.captureErr, spawnRun: async () => ({ code: 2, result: undefined }) });
  assert.equal(fallen, 2);
  assert.deepEqual(readRuns(g.home, { triggerId: 'nightly' })[0].reason, 'round_cap');
});

test('the read-only commands print what the layers hold, and bad input gives usage', async t => {
  const f = fixture(t);
  const deps = { home: f.home, project: f.project, now: NOW, stdout: f.capture, stderr: f.captureErr, spawnRun: async () => ({ code: 0, result: { outcome: 'completed', exitCode: 0 } }) };
  assert.equal(await runTriggerCli(['list'], deps), 0);
  assert.match(f.output.out, /^on +nightly/m);
  assert.equal(await runTriggerCli(['show', 'nightly'], { ...deps, stdout: (f.output.out = '', f.capture) }), 0);
  assert.match(f.output.out, /keep the build green \(max 6 rounds\)/);
  assert.equal(await runTriggerCli(['emit', 'nightly', '--text', 'later'], { ...deps, eventId: 'e9' }), 0);
  f.output.out = '';
  assert.equal(await runTriggerCli(['events', 'nightly'], deps), 0);
  assert.match(f.output.out, /later/);
  f.output.out = '';
  assert.equal(await runTriggerCli(['log', 'nightly'], deps), 0);
  assert.match(f.output.out, /No runs recorded|completed/);

  const missing = fixture(t);
  assert.equal(await runTriggerCli(['run', 'nope'], { ...deps, home: missing.home, project: missing.project, stdout: missing.capture, stderr: missing.captureErr }), 1);
  assert.match(missing.output.err, /no trigger "nope"/);
  assert.equal(await runTriggerCli(['bogus'], { ...deps, stdout: f.capture, stderr: f.captureErr }), 1);
  assert.match(f.output.err, /unknown command "bogus"/);
  assert.equal(await runTriggerCli(['run', 'nightly', '--wat'], { ...deps, stdout: f.capture, stderr: f.captureErr }), 1);
  assert.match(f.output.err, /unknown option "--wat"/);
  assert.deepEqual(pick(parseTriggerArgs(['--help']), ['command', 'help', 'error']), { command: '--help', help: true, error: undefined });
  assert.deepEqual(pick(parseTriggerArgs(['log', 'nightly', '--failed']), ['command', 'id', 'failed']), { command: 'log', id: 'nightly', failed: true });
  assert.match(USAGE, /^Commands:$/m);
  assert.match(USAGE, /^ {2}run <id>/m);
});

test('a disabled definition and a missing workspace never spawn', async t => {
  const disabled = fixture(t, { enabled: false });
  let spawns = 0;
  const deps = { home: disabled.home, project: disabled.project, now: NOW, stdout: disabled.capture, stderr: disabled.captureErr, spawnRun: async () => { spawns += 1; return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };
  assert.equal(await runTriggerCli(['run', 'nightly'], deps), 0);
  assert.match(disabled.output.err, /skipped nightly: disabled/);
  assert.equal(spawns, 0);

  const gone = fixture(t);
  rmSync(gone.workspace, { recursive: true, force: true });
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, home: gone.home, project: gone.project, stdout: gone.capture, stderr: gone.captureErr }), 0);
  assert.match(gone.output.err, /skipped nightly: workspace_missing/);
  assert.equal(spawns, 0);
});

test('signal handlers do not accumulate across runs', async () => {
  const { watchSignals } = await import('../scripts/trigger.mjs');
  const killed = [];
  const child = { kill: signal => killed.push(signal) };
  const before = process.listenerCount('SIGTERM');
  const releases = [watchSignals(child), watchSignals(child)];
  assert.equal(process.listenerCount('SIGTERM'), before + 2);
  for (const release of releases) release();
  assert.equal(process.listenerCount('SIGTERM'), before, 'every listener this call added is removed');
  const release = watchSignals(child);
  process.emit('SIGTERM');
  release();
  assert.deepEqual(killed, ['SIGTERM']);
});

test('a host that never starts leaves the event pending and frees the lock', async t => {
  const f = fixture(t);
  await runTriggerCli(['emit', 'nightly', '--text', 'keep me'], { home: f.home, project: f.project, now: NOW, eventId: 'e-keep', stdout: f.capture, stderr: f.captureErr });
  const code = await runTriggerCli(['run', 'nightly'], {
    home: f.home, project: f.project, now: NOW + 120000, stdout: f.capture, stderr: f.captureErr,
    spawnRun: async () => { throw new Error('the harness refused to start'); },
  });
  assert.equal(code, 1);
  assert.match(f.output.err, /harness refused to start/);
  assert.deepEqual(listEvents(f.home, 'nightly').map(event => event.eventId), ['e-keep'], 'the event is still pending');
  assert.deepEqual(readRuns(f.home, { triggerId: 'nightly' }), [], 'no run was recorded');
  assert.throws(() => readFileSync(lockPath(f.home, 'nightly'), 'utf8'), 'the lock is released for the next attempt');
});

test('an interrupted host is recorded as interrupted, not as a model error', async t => {
  const f = fixture(t);
  const code = await runTriggerCli(['run', 'nightly'], { home: f.home, project: f.project, now: NOW, stdout: f.capture, stderr: f.captureErr, spawnRun: async () => ({ code: 130, result: undefined }) });
  assert.equal(code, 130);
  assert.deepEqual(pick(readRuns(f.home, { triggerId: 'nightly' })[0], ['outcome', 'reason', 'exitCode']), { outcome: 'failed', reason: 'interrupted', exitCode: 130 });
});

test('bad input is refused with a message that names what was wrong', async t => {
  const f = fixture(t);
  const deps = { home: f.home, project: f.project, now: NOW, stdout: f.capture, stderr: f.captureErr, spawnRun: async () => ({ code: 0, result: { outcome: 'completed', exitCode: 0 } }) };
  const broken = join(f.root, 'event.json');
  writeFileSync(broken, '{"text": ');
  assert.equal(await runTriggerCli(['emit', 'nightly', '--event', broken], deps), 1);
  assert.match(f.output.err, /event\.json is not a valid event body/);
  writeFileSync(broken, '');
  assert.equal(await runTriggerCli(['emit', 'nightly', '--event', broken], deps), 1);
  assert.match(f.output.err, /is empty: an event body is required/);
  writeFileSync(broken, '[1,2]');
  assert.equal(await runTriggerCli(['emit', 'nightly', '--event', broken], deps), 1);
  assert.match(f.output.err, /must be a JSON object/);

  // Naming an identity that is not waiting must not run with an empty payload.
  let spawns = 0;
  const counting = { ...deps, spawnRun: async () => { spawns += 1; return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };
  assert.equal(await runTriggerCli(['run', 'nightly', '--event-id', 'never-posted'], counting), 1);
  assert.match(f.output.err, /no pending event "never-posted"/);
  assert.equal(spawns, 0);
  // A posted event with that identity is found and delivered.
  emitEvent(f.home, 'nightly', { source: 'cli', text: 'the build failed' }, { eventId: 'posted', now: NOW });
  assert.equal(await runTriggerCli(['run', 'nightly', '--event-id', 'posted'], counting), 0);
  assert.equal(spawns, 1);
});

test('a host killed by a signal still leaves a usable record', async t => {
  const f = fixture(t);
  // `spawnHost` normally turns a signal into 130; a caller that passes null must
  // not make the record un-writable (an integer exit code is required).
  const code = await runTriggerCli(['run', 'nightly'], { home: f.home, project: f.project, now: NOW, stdout: f.capture, stderr: f.captureErr, spawnRun: async () => ({ code: null, result: undefined }) });
  assert.equal(code, 130);
  const run = readRuns(f.home, { triggerId: 'nightly' })[0];
  assert.deepEqual(pick(run, ['outcome', 'reason', 'exitCode']), { outcome: 'failed', reason: 'interrupted', exitCode: 130 });
});
