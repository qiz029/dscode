import { schedulerPath } from '../plugins/triggers/scheduler-service.mjs';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cronToCalendarInterval, crontabLine, launchAgent, agentPath } from '../plugins/triggers/launchd.mjs';
import { normalizeTrigger } from '../plugins/triggers/config.mjs';
import { readRuns } from '../plugins/triggers/log.mjs';
import { setEnabledFlag, scaffoldTrigger, runTriggerCli, parseTriggerArgs } from '../plugins/triggers/cli.mjs';
import { parse as parseYaml } from 'yaml';

// Installing a trigger into launchd, the poll predicate, and the file-editing
// commands. The launchctl call is injected: what matters here is the schedule
// text DSCODE produces and what it refuses to produce.

const NOW = Date.UTC(2026, 8, 21, 9, 0, 0);
/** A few fields of one value, for compact assertions. */
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const definition = (source, overrides = {}) => normalizeTrigger({
  id: 'nightly',
  workspace: '/work/repo',
  prompt: 'review the diff',
  source,
  goal: { objective: 'keep the build green' },
  ...overrides,
});

test('a cron expression maps to the launchd keys it can express, and no others', () => {
  assert.deepEqual(cronToCalendarInterval('0 9 * * *'), { Minute: 0, Hour: 9 });
  assert.deepEqual(cronToCalendarInterval('30 6 1 3 2'), { Minute: 30, Hour: 6, Day: 1, Month: 3, Weekday: 2 });
  // Launchd has no ranges, steps or lists; approximating them would schedule
  // something the user did not ask for.
  for (const cron of ['*/5 * * * *', '0 9-17 * * *', '0 9,17 * * *', '0 9 * *']) {
    assert.throws(() => cronToCalendarInterval(cron), /launchd cannot schedule|five fields/, cron);
  }
  assert.throws(() => cronToCalendarInterval('* * * * *'), /every minute/);
});

test('the plist carries the schedule for every source that has one', () => {
  const at = source => launchAgent(definition(source), { home: '/state', dscodePath: '/bin/dscode', project: '/proj' });
  const interval = at({ kind: 'interval', seconds: 300 });
  assert.match(interval, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(interval, /<key>ProgramArguments<\/key>\n {2}<array>\n {4}<string>\/bin\/dscode<\/string>\n {4}<string>trigger<\/string>\n {4}<string>run<\/string>\n {4}<string>nightly<\/string>\n {4}<string>--project<\/string>\n {4}<string>\/proj<\/string>/);
  assert.match(interval, /<key>WorkingDirectory<\/key><string>\/work\/repo<\/string>/);
  assert.match(interval, /<key>Label<\/key><string>ai\.dscode\.trigger\.nightly<\/string>/);

  assert.match(at({ kind: 'calendar', cron: '0 9 * * *' }), /<key>StartCalendarInterval<\/key>\n {2}<dict>\n {4}<key>Minute<\/key><integer>0<\/integer>\n {4}<key>Hour<\/key><integer>9<\/integer>\n {2}<\/dict>/);
  assert.match(at({ kind: 'watch', paths: ['/work/repo/.git/HEAD'] }), /<key>WatchPaths<\/key>\n {2}<array>\n {4}<string>\/work\/repo\/\.git\/HEAD<\/string>/);
  // A poll source is a scheduled cheap check, so it installs as an interval.
  assert.match(at({ kind: 'poll', everySeconds: 600, check: 'true' }), /<key>StartInterval<\/key><integer>600<\/integer>/);
  // Nothing to schedule: the producers post into the spool themselves.
  assert.throws(() => at({ kind: 'external' }), /nothing to schedule/);
});

test('a value with XML characters cannot break the plist', () => {
  const plist = launchAgent(definition({ kind: 'watch', paths: ['/work/a&b/<repo>'] }), { home: '/state', dscodePath: '/bin/dscode', project: '/proj' });
  assert.match(plist, /<string>\/work\/a&amp;b\/&lt;repo&gt;<\/string>/);
});

test('the crontab fallback says when it has no line to offer', () => {
  const line = source => crontabLine(definition(source), { dscodePath: '/bin/dscode', project: '/proj' });
  assert.equal(line({ kind: 'calendar', cron: '0 9 * * *' }), '0 9 * * * /bin/dscode trigger run nightly --project /proj');
  assert.equal(line({ kind: 'interval', seconds: 300 }), '*/5 * * * * /bin/dscode trigger run nightly --project /proj');
  assert.equal(line({ kind: 'poll', everySeconds: 600, check: 'true' }), '*/10 * * * * /bin/dscode trigger run nightly --project /proj');
  assert.match(line({ kind: 'external' }), /^# nightly: a "external" source has no crontab form/);
  assert.match(line({ kind: 'interval', seconds: 45 }), /^# nightly: 45s is not a whole number of minutes/);
});

test('enable and disable rewrite one line and leave the rest of the file alone', () => {
  const text = '# my trigger\nid: nightly\nworkspace: /work/repo\nprompt: review\nsource: { kind: external }\ngoal: { objective: x }\n';
  const disabled = setEnabledFlag(text, false);
  assert.match(disabled, /^id: nightly\nenabled: false\nworkspace/m);
  assert.equal(setEnabledFlag(text, true).includes('enabled: true'), true);
  assert.equal(setEnabledFlag(disabled, true).includes('enabled: false'), false);
  // An existing line is replaced in place, not duplicated.
  const twice = setEnabledFlag(setEnabledFlag(text, false), true);
  assert.equal(twice.split('\n').filter(line => line.startsWith('enabled:')).length, 1);
  assert.match(twice, /# my trigger\nid: nightly\nenabled: true\n/);
  assert.equal(setEnabledFlag('prompt: only\n', true), 'enabled: true\nprompt: only\n');
  const scaffold = scaffoldTrigger('fresh', { workspace: '/work/repo' });
  assert.match(scaffold, /^id: fresh\nworkspace: \/work\/repo\n/);
  assert.doesNotThrow(() => normalizeTrigger(parseYaml(scaffold), { origin: 'project' }));
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-trigger-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const project = join(root, 'project');
  const workspace = join(root, 'repo');
  mkdirSync(join(project, '.dsh', 'triggers'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const output = { out: '', err: '' };
  // The installer refuses a path launchd cannot execute, so the fixture points at
  // a real file (`node` itself); the plist text is asserted separately.
  const deps = { home, project, now: NOW, agentsDirectory: join(root, 'LaunchAgents'), dscodePath: process.execPath, stdout: { write: text => { output.out += text; } }, stderr: { write: text => { output.err += text; } } };
  return { root, home, project, workspace, output, deps };
}

test('install registers a recurrence and loads the shared scheduler; uninstall preserves the service', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: calendar, cron: "0 9 * * 1-5", timezone: UTC }\ngoal: { objective: keep it green }\n`);
  const calls = [];
  const deps = { ...f.deps, platform: 'darwin', launchctl: async args => { calls.push(args); return args[0] === 'print' ? 1 : 0; } };
  assert.equal(await runTriggerCli(['install', 'nightly'], deps), 0);
  const path = schedulerPath(f.home, deps.agentsDirectory);
  assert.match(readFileSync(path, 'utf8'), /<key>KeepAlive<\/key><true\/>/);
  assert.match(readFileSync(path, 'utf8'), /<string>scheduler<\/string><string>start<\/string>/);
  assert.deepEqual(calls.map(args => args[0]), ['bootout', 'print', 'bootstrap']);
  const store = new JobStore(f.home);
  t.after(() => store.close());
  assert.equal(store.schedules().length, 1);
  assert.equal(await runTriggerCli(['uninstall', 'nightly'], deps), 0);
  assert.equal(store.schedules().length, 0);
  assert.equal(existsSync(path), true, 'the shared service also serves other triggers and delay jobs');
});

test('without launchd installation prints the foreground scheduler command', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: interval, seconds: 600 }\ngoal: { objective: x }\n`);
  assert.equal(await runTriggerCli(['install', 'nightly'], { ...f.deps, platform: 'linux', launchctl: async () => { throw new Error('must not be called'); } }), 0);
  assert.match(f.output.out, /service manager/);
  assert.match(f.output.out, /trigger scheduler start/);
});

test('install needs a real program path and refuses to guess one', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: interval, seconds: 600 }\ngoal: { objective: x }\n`);
  const withoutPath = { ...f.deps, dscodePath: undefined, launchctl: async () => 0 };
  assert.equal(await runTriggerCli(['install', 'nightly'], withoutPath), 1);
  assert.match(f.output.err, /does not know its own dscode program path/);

  assert.equal(await runTriggerCli(['install', 'nightly'], { ...f.deps, dscodePath: '/nonexistent/dscode', launchctl: async () => 0 }), 1);
  assert.match(f.output.err, /is not an executable file/);

  // A file that exists but cannot be executed is not a program launchd can run.
  const notExecutable = join(f.root, 'not-executable');
  writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(await runTriggerCli(['install', 'nightly'], { ...f.deps, dscodePath: notExecutable, launchctl: async () => 0 }), 1);
  assert.match(f.output.err, /is not an executable file/);
  assert.equal(existsSync(agentPath(f.home, 'nightly')), false, 'nothing was written for either refusal');
});

test('an unschedulable source refuses to install instead of writing a plist', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: external }\ngoal: { objective: x }\n`);
  assert.equal(await runTriggerCli(['install', 'nightly'], f.deps), 1);
  assert.match(f.output.err, /nothing to schedule/);
  assert.equal(existsSync(agentPath(f.home, 'nightly')), false);
});

test('new writes a definition that enable, disable and list understand', async t => {
  const f = fixture(t);
  assert.equal(await runTriggerCli(['new', 'fresh', '--workspace', f.workspace], f.deps), 0);
  const path = join(f.project, '.dsh', 'triggers', 'fresh.yml');
  assert.equal(existsSync(path), true);
  // A starter definition must be valid, or the next command fails on it.
  assert.equal(await runTriggerCli(['list'], f.deps), 0);
  assert.match(f.output.out, /^on +fresh/m);
  assert.equal(await runTriggerCli(['new', 'fresh'], f.deps), 1, 'refuses to overwrite');
  assert.match(f.output.err, /already exists/);

  assert.equal(await runTriggerCli(['disable', 'fresh'], f.deps), 0);
  assert.match(readFileSync(path, 'utf8'), /enabled: false/);
  assert.equal(await runTriggerCli(['enable', 'fresh'], f.deps), 0);
  assert.match(readFileSync(path, 'utf8'), /enabled: true/);
});

test('a poll source only runs when its check says there is work', async t => {
  const f = fixture(t);
  const write = check => writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: poll, everySeconds: 300, check: "${check}" }\ngoal: { objective: x }\nlimits: { minIntervalSeconds: 1 }\n`);
  let spawns = 0;
  const deps = { ...f.deps, spawnRun: async () => { spawns += 1; return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };

  write('exit 1');
  assert.equal(await runTriggerCli(['run', 'nightly'], deps), 0);
  assert.equal(spawns, 0, 'a check with nothing to do starts no session');
  assert.match(f.output.err, /nothing to do for nightly \(check exited 1\)/);
  const skipped = readRuns(f.home, { triggerId: 'nightly' })[0];
  assert.deepEqual([skipped.outcome, skipped.reason], ['skipped', 'no_match']);

  write('echo found a new commit; exit 0');
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, now: NOW + 60 * 1000 }), 0);
  assert.equal(spawns, 1, 'the first match in a window runs');
  // A replayed scheduler tick in the SAME window is the same firing, so it does
  // not start a second session; only the next window re-evaluates the check.
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, now: NOW + 2 * 60 * 1000 }), 0);
  assert.equal(spawns, 1, 'the same window never runs twice');
  assert.equal(readRuns(f.home, { triggerId: 'nightly' })[0].reason, 'duplicate');
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, now: NOW + 6 * 60 * 1000 }), 0);
  assert.equal(spawns, 2, 'the next window runs');
  assert.equal(readRuns(f.home, { triggerId: 'nightly' })[0].outcome, 'completed');
});

test('a scheduled firing is identified by its cadence window, not by the clock', async t => {
  const { firingIdentity } = await import('../plugins/triggers/cli.mjs');
  const at = (source, now) => firingIdentity(definition(source), now);
  // Two invocations in one window are one firing; a tick in the next window is not.
  assert.equal(at({ kind: 'interval', seconds: 300 }, NOW), at({ kind: 'interval', seconds: 300 }, NOW + 4 * 60 * 1000));
  assert.notEqual(at({ kind: 'interval', seconds: 300 }, NOW), at({ kind: 'interval', seconds: 300 }, NOW + 6 * 60 * 1000));
  assert.equal(at({ kind: 'poll', everySeconds: 600, check: 'true' }, NOW), at({ kind: 'poll', everySeconds: 600, check: 'true' }, NOW + 9 * 60 * 1000));
  assert.equal(at({ kind: 'calendar', cron: '0 9 * * *' }, NOW), 'calendar:2026-09-21T09:00');
  assert.equal(at({ kind: 'watch', paths: ['/x'] }, NOW + 30 * 1000), 'watch:2026-09-21T09:00');
  assert.match(at({ kind: 'external' }, NOW), /^manual:/);

  // A scheduled source therefore de-duplicates a replayed tick.
  const f = fixture(t);
  writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: interval, seconds: 300 }\ngoal: { objective: x }\n`);
  let spawns = 0;
  const deps = { ...f.deps, now: NOW, spawnRun: async () => { spawns += 1; return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };
  assert.equal(await runTriggerCli(['run', 'nightly'], deps), 0);
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, now: NOW + 1000 }), 0);
  assert.equal(spawns, 1, 'the replayed tick starts nothing');
  assert.equal(readRuns(f.home, { triggerId: 'nightly' })[0].reason, 'duplicate');
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...deps, now: NOW + 5 * 60 * 1000 }), 0);
  assert.equal(spawns, 2, 'the next window runs');
});

test('the flag editor refuses a file it cannot edit safely', () => {
  // A second document could carry its own `id:`, which a line match would edit.
  assert.throws(() => setEnabledFlag('id: a\nprompt: p\n---\nid: b\n', false), /more than one YAML document/);
  // A leading document marker is the normal single-document form.
  assert.match(setEnabledFlag('---\nid: a\nprompt: p\n', false), /^---\nid: a\nenabled: false\n/m);
  // A quoted multi-line scalar can hold a column-0 `id:` line; editing inside it
  // would change the prompt, so the parsed comparison refuses the edit.
  const scalar = 'id: a\nprompt: "first line\nid: still the prompt"\n';
  assert.throws(() => setEnabledFlag(scalar, true), /would alter more than the enabled flag/);
  // The ordinary case still edits, and only the flag moves.
  const ordinary = 'id: a\nprompt: |\n  run the tests\ngoal: { objective: x }\n';
  const edited = setEnabledFlag(ordinary, true);
  assert.equal(edited.split('\n').filter(line => line.startsWith('enabled:')).length, 1);
  assert.equal(edited.replace('enabled: true\n', ''), ordinary);
});

test('a producer can name its own event and retry with the same identity', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: external }\ngoal: { objective: x }\n`);
  let spawns = 0;
  const deps = { ...f.deps, spawnRun: async () => { spawns += 1; return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };
  // The same id twice is one event: the run decision refuses the second.
  assert.equal(await runTriggerCli(['fire', 'nightly', '--text', 'go', '--event-id', 'build-7'], deps), 0);
  assert.equal(await runTriggerCli(['fire', 'nightly', '--text', 'go', '--event-id', 'build-7'], deps), 0);
  assert.equal(spawns, 1, 'the retry with the same identity starts nothing');
  assert.equal(readRuns(f.home, { triggerId: 'nightly' })[0].eventId, 'build-7');
  assert.equal(readRuns(f.home, { triggerId: 'nightly' })[0].reason, 'duplicate');
  assert.deepEqual(pick(parseTriggerArgs(['emit', 'nightly', '--event-id', 'x']), ['command', 'id', 'eventId']), { command: 'emit', id: 'nightly', eventId: 'x' });
});

test('log --failed hides the completions and the skips', async t => {
  const f = fixture(t);
  writeFileSync(join(f.project, '.dsh', 'triggers', 'nightly.yml'), `id: nightly\nworkspace: ${f.workspace}\nprompt: review\nsource: { kind: external }\ngoal: { objective: x }\nlimits: { minIntervalSeconds: 1 }\n`);
  const failing = { ...f.deps, spawnRun: async () => ({ code: 1, result: { outcome: 'failed', reason: 'model_error', exitCode: 1 } }) };
  assert.equal(await runTriggerCli(['run', 'nightly'], failing), 1);
  const ok = { ...f.deps, spawnRun: async () => ({ code: 0, result: { outcome: 'completed', exitCode: 0 } }) };
  assert.equal(await runTriggerCli(['run', 'nightly'], { ...ok, now: NOW + 60 * 1000 }), 0);

  f.output.out = '';
  assert.equal(await runTriggerCli(['log', 'nightly', '--failed'], f.deps), 0);
  assert.match(f.output.out, /failed \(model_error\)/);
  assert.doesNotMatch(f.output.out, /completed/);
  f.output.out = '';
  assert.equal(await runTriggerCli(['log', 'nightly'], f.deps), 0);
  assert.match(f.output.out, /completed/);
});
