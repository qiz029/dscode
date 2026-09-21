import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, formatTrigger, loadTriggerDefinitions, normalizeTrigger } from '../plugins/triggers/config.mjs';

// The trigger definition layer: what a definition must say before any run can be
// attempted, and how user-level and project-level files are discovered. Nothing
// here runs an agent; see docs/triggers-design.md for the whole mechanism.

const definition = overrides => ({
  id: 'nightly-review',
  workspace: '/work/repo',
  prompt: 'review the diff and fix what is broken',
  source: { kind: 'calendar', cron: '0 9 * * *' },
  goal: { objective: 'the diff is reviewed and the tests pass' },
  ...overrides,
});

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-triggers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  const workspace = join(root, 'repo');
  mkdirSync(join(home, 'triggers'), { recursive: true });
  mkdirSync(join(workspace, '.dsh', 'triggers'), { recursive: true });
  return { home, workspace };
}

test('a definition normalizes with the documented defaults', () => {
  const normalized = normalizeTrigger(definition(), { origin: 'project', path: '/x/nightly-review.yml' });
  assert.equal(normalized.id, 'nightly-review');
  assert.equal(normalized.enabled, DEFAULTS.enabled);
  assert.equal(normalized.permission, DEFAULTS.permission);
  assert.equal(normalized.preset, DEFAULTS.preset);
  assert.equal(normalized.goal.maxRounds, DEFAULTS.maxGoalRounds);
  assert.deepEqual(normalized.limits, {
    timeoutSeconds: DEFAULTS.timeoutSeconds,
    maxRunsPerDay: DEFAULTS.maxRunsPerDay,
    minIntervalSeconds: DEFAULTS.minIntervalSeconds,
  });
  assert.equal(normalized.overlap, 'skip');
  assert.equal(normalized.notify, 'log');
  assert.equal(normalized.origin, 'project');
});

test('every source kind is validated on its own fields', () => {
  const source = raw => normalizeTrigger(definition({ source: raw })).source;
  assert.deepEqual(source({ kind: 'interval', seconds: 300 }), { kind: 'interval', seconds: 300 });
  assert.deepEqual(source({ kind: 'watch', paths: ['/work/repo/.git/HEAD'] }), { kind: 'watch', paths: ['/work/repo/.git/HEAD'] });
  assert.deepEqual(source({ kind: 'poll', everySeconds: 600, check: 'git fetch -q && git rev-list HEAD..@{u} | grep -q .' }), { kind: 'poll', everySeconds: 600, check: 'git fetch -q && git rev-list HEAD..@{u} | grep -q .' });
  assert.deepEqual(source({ kind: 'external' }), { kind: 'external' });
  for (const [raw, message] of [
    [{ kind: 'interval' }, /source\.seconds/],
    [{ kind: 'interval', seconds: 0 }, /source\.seconds/],
    [{ kind: 'calendar', cron: '0 9 * *' }, /five fields/],
    [{ kind: 'watch', paths: [] }, /source\.paths/],
    [{ kind: 'poll', everySeconds: 60 }, /source\.check/],
    [{ kind: 'whenever' }, /source\.kind must be one of/],
  ]) {
    assert.throws(() => source(raw), message, JSON.stringify(raw));
  }
});

test('an unattended definition refuses to be configured to ask for approval', () => {
  assert.throws(() => normalizeTrigger(definition({ permission: 'ask' })), /cannot ask for approval/);
  assert.equal(normalizeTrigger(definition({ permission: 'read-only' })).permission, 'read-only');
});

test('the goal, the id and the workspace are required and checked', () => {
  assert.throws(() => normalizeTrigger(definition({ goal: {} })), /goal\.objective/);
  assert.throws(() => normalizeTrigger(definition({ workspace: 'repo' })), /absolute path/);
  assert.throws(() => normalizeTrigger(definition({ id: 'Nightly Review' })), /id must start/);
  assert.throws(() => normalizeTrigger(definition({ prompt: '  ' })), /prompt/);
  assert.throws(() => normalizeTrigger(definition({ goal: { objective: 'x', maxRounds: 0 } })), /goal\.maxRounds/);
  assert.throws(() => normalizeTrigger(definition({ overlap: 'queue' })), /overlap must be "skip"/);
});

test('a cost cap is dollars and a misspelled field fails instead of falling back', () => {
  assert.equal(normalizeTrigger(definition({ limits: { maxCostUsd: 0.5 } })).limits.maxCostUsd, 0.5);
  assert.equal(normalizeTrigger(definition({ limits: { maxCostUsd: 2 } })).limits.maxCostUsd, 2);
  assert.throws(() => normalizeTrigger(definition({ limits: { maxCostUsd: 0 } })), /positive number/);
  assert.throws(() => normalizeTrigger(definition({ limits: { maxCostUsd: '1' } })), /positive number/);
  // `maxRound` instead of `maxRounds` would otherwise run 20 rounds, not 5.
  assert.throws(() => normalizeTrigger(definition({ goal: { objective: 'x', maxRound: 5 } })), /goal has no such field: maxRound/);
  assert.throws(() => normalizeTrigger(definition({ limmits: {} })), /the definition has no such field: limmits/);
  assert.throws(() => normalizeTrigger(definition({ source: { kind: 'interval', seconds: 60, cron: '0 9 * * *' } })), /source \(interval\) has no such field: cron/);
});

test('definitions load from the state dir and the project, project winning', t => {
  const { home, workspace } = scratch(t);
  writeFileSync(join(home, 'triggers', 'nightly-review.yml'), 'id: nightly-review\nworkspace: /work/repo\nprompt: from user\nsource: { kind: interval, seconds: 60 }\ngoal: { objective: user objective }\n');
  writeFileSync(join(home, 'triggers', 'user-only.json'), JSON.stringify({ id: 'user-only', workspace: '/work/repo', prompt: 'p', source: { kind: 'external' }, goal: { objective: 'g' } }));
  writeFileSync(join(workspace, '.dsh', 'triggers', 'nightly-review.yml'), 'id: nightly-review\nworkspace: ' + workspace + '\nprompt: from project\nsource: { kind: calendar, cron: "0 3 * * *" }\ngoal: { objective: project objective, maxRounds: 5 }\n');

  const { definitions, problems } = loadTriggerDefinitions({ home, workspace });
  assert.deepEqual(problems, []);
  assert.deepEqual(definitions.map(entry => entry.id), ['nightly-review', 'user-only']);
  const project = definitions.find(entry => entry.id === 'nightly-review');
  assert.equal(project.origin, 'project');
  assert.equal(project.overrides, true);
  assert.equal(project.goal.objective, 'project objective');
  assert.equal(project.goal.maxRounds, 5);
  assert.equal(definitions.find(entry => entry.id === 'user-only').origin, 'user');
});

test('one unreadable definition is reported without hiding the others', t => {
  const { home, workspace } = scratch(t);
  writeFileSync(join(home, 'triggers', 'good.yml'), 'id: good\nworkspace: /work/repo\nprompt: p\nsource: { kind: external }\ngoal: { objective: g }\n');
  writeFileSync(join(home, 'triggers', 'bad.yml'), 'id: bad\nworkspace: relative/path\nprompt: p\nsource: { kind: external }\ngoal: { objective: g }\n');
  writeFileSync(join(home, 'triggers', 'mismatch.yml'), 'id: something-else\nworkspace: /work/repo\nprompt: p\nsource: { kind: external }\ngoal: { objective: g }\n');
  writeFileSync(join(home, 'triggers', 'broken.yml'), 'id: [unclosed\n');
  const { definitions, problems } = loadTriggerDefinitions({ home, workspace });
  assert.deepEqual(definitions.map(entry => entry.id), ['good']);
  assert.equal(problems.length, 3);
  assert.match(problems.map(problem => problem.message).join('\n'), /absolute path/);
  assert.match(problems.map(problem => problem.message).join('\n'), /must match the file name/);
});

test('a missing directory is simply no definitions, not an error', t => {
  const { home, workspace } = scratch(t);
  rmSync(join(home, 'triggers'), { recursive: true, force: true });
  rmSync(join(workspace, '.dsh'), { recursive: true, force: true });
  assert.deepEqual(loadTriggerDefinitions({ home, workspace }), { definitions: [], problems: [] });
});

test('the listing text names the source, the folder and the cap', () => {
  const text = formatTrigger(normalizeTrigger(definition({ goal: { objective: 'ship it', maxRounds: 7 } })));
  assert.match(text, /^on +nightly-review/);
  assert.match(text, /cron 0 9 \* \* \*/);
  assert.match(text, /workspace: \/work\/repo/);
  assert.match(text, /ship it \(max 7 rounds\)/);
  assert.match(text, /dscode\/workspace-write/);
});

// The `/triggers` command itself: the plugin half that reads the layer above.
test('the /triggers command lists definitions and reports a bad file beside them', async t => {
  const { home, workspace } = scratch(t);
  writeFileSync(join(workspace, '.dsh', 'triggers', 'nightly-review.yml'), 'id: nightly-review\nworkspace: ' + workspace + '\nprompt: p\nsource: { kind: interval, seconds: 300 }\ngoal: { objective: keep the build green, maxRounds: 3 }\n');
  writeFileSync(join(workspace, '.dsh', 'triggers', 'broken.yml'), 'id: broken\nworkspace: relative\nprompt: p\nsource: { kind: external }\ngoal: { objective: g }\n');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });

  const { apply } = await import('../plugins/triggers/index.mjs');
  let registered;
  apply({ commands: { register: entry => { registered = entry } } });
  assert.equal(registered.name, 'triggers');
  const agent = { session: { header: { cwd: workspace } } };

  const listed = registered.handler({ agent, rawInput: '' });
  assert.equal(listed.kind, 'success');
  assert.match(listed.text, /nightly-review/);
  assert.match(listed.text, /keep the build green \(max 3 rounds\)/);
  assert.match(listed.text, /Unreadable definitions:/);
  assert.match(listed.text, /absolute path/);

  const shown = registered.handler({ agent, rawInput: 'show nightly-review' });
  assert.equal(shown.kind, 'success');
  assert.match(shown.text, /file: +\S*nightly-review\.yml/);
  assert.match(shown.text, /prompt: {4}p/);

  const missing = registered.handler({ agent, rawInput: 'show nope' });
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /No trigger "nope"/);

  // An unknown action or a stray argument is refused, never read as "list".
  for (const raw of ['delete nightly-review', 'show nightly-review extra']) {
    const refused = registered.handler({ agent, rawInput: raw });
    assert.equal(refused.kind, 'error', raw);
    assert.match(refused.text, /Usage: \/triggers/);
  }
  assert.equal(registered.handler({ agent, rawInput: 'list' }).kind, 'success');
});

test('a multi-line objective is folded so it cannot forge a listing row', () => {
  const normalized = normalizeTrigger(definition({ goal: { objective: 'line one\ngoal: forged 999' } }));
  const text = formatTrigger(normalized);
  assert.equal(text.split('\n').filter(line => /^\s*goal:/.test(line)).length, 1);
  assert.match(text, /line one goal: forged 999/);
});

test('an empty state says how to add a definition', async t => {
  const { home, workspace } = scratch(t);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  const { apply } = await import('../plugins/triggers/index.mjs');
  let registered;
  apply({ commands: { register: entry => { registered = entry } } });
  const text = registered.handler({ agent: { session: { header: { cwd: workspace } } }, rawInput: '' }).text;
  assert.match(text, /No triggers defined/);
  assert.match(text, /\.dsh\/triggers/);
});

// The listing half of the run log and the spool: what an operator sees without
// opening a file.
test('/triggers shows the last outcome, the run history and pending events', async t => {
  const { home, workspace } = scratch(t);
  writeFileSync(join(workspace, '.dsh', 'triggers', 'nightly-review.yml'), 'id: nightly-review\nworkspace: ' + workspace + '\nprompt: p\nsource: { kind: external }\ngoal: { objective: keep the build green }\n');
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; });
  const { appendRun } = await import('../plugins/triggers/log.mjs');
  const { emitEvent } = await import('../plugins/triggers/spool.mjs');
  appendRun(home, { triggerId: 'nightly-review', runId: 'r1', startedAt: Date.UTC(2026, 8, 21, 9), endedAt: Date.UTC(2026, 8, 21, 9, 4), outcome: 'completed', exitCode: 0, cost: 0.42, rounds: 3 });
  emitEvent(home, 'nightly-review', { source: 'ci', title: 'build', text: 'the build failed' }, { eventId: 'build-123', now: Date.UTC(2026, 8, 21, 10) });

  const { apply } = await import('../plugins/triggers/index.mjs');
  let registered;
  apply({ commands: { register: entry => { registered = entry } } });
  const agent = { session: { header: { cwd: workspace } } };

  const listed = registered.handler({ agent, rawInput: 'list' });
  assert.match(listed.text, /last: {6}2026-09-21 09:00:00 completed · exit 0/);

  const runs = registered.handler({ agent, rawInput: 'runs nightly-review' });
  assert.equal(runs.kind, 'success');
  assert.match(runs.text, /2026-09-21 09:00:00 completed exit 0 \$0\.42 3r/);

  const events = registered.handler({ agent, rawInput: 'events nightly-review' });
  assert.equal(events.kind, 'success');
  assert.match(events.text, /\[ci\] build-123 — build: the build failed/);

  for (const raw of ['runs', 'events', 'runs nightly-review extra']) {
    const refused = registered.handler({ agent, rawInput: raw });
    assert.equal(refused.kind, 'error', raw);
    assert.match(refused.text, /Usage: \/triggers/);
  }
  assert.match(registered.handler({ agent, rawInput: 'runs other' }).text, /No runs recorded for other/);
});

test('a trigger directory that cannot be read is reported, not read as empty', t => {
  // A permission failure must not look like "nothing defined": the user would add
  // duplicates instead of fixing the directory. Root ignores the mode, so the
  // assertion only holds for an ordinary user.
  if (process.getuid?.() === 0) return;
  const { home, workspace } = scratch(t);
  const directory = join(home, 'triggers');
  writeFileSync(join(directory, 'good.yml'), 'id: good\nworkspace: /work/repo\nprompt: p\nsource: { kind: external }\ngoal: { objective: g }\n');
  chmodSync(directory, 0o000);
  // Restore before asserting: the fixture's own cleanup runs first among the
  // after hooks, and it cannot descend into a directory it may not read.
  const { definitions, problems } = loadTriggerDefinitions({ home, workspace });
  chmodSync(directory, 0o700);
  assert.deepEqual(definitions, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /cannot read the trigger directory/);
  assert.match(problems[0].path, /triggers$/);
});
