import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '@deepseek-ai/dsh-command-goal';

// `/goal[20]` is a DSCODE runtime patch (scripts/patch-runtime.mjs) on the
// upstream human-facing goal command, applied by `npm run setup`/launch. These
// tests drive the REAL command handler against a fake goal service, so they pin
// the shorthand's behavior rather than the patch's text. Run provisioning first:
// on an unpatched tree the bracket forms fail loudly, which is the point.

/** A fake goal service recording every mutation the command issues. */
function harness(initial) {
  const calls = [];
  const view = goal => ({
    id: 'g1', revision: 1, objective: '', phase: 'active', maxGoalRounds: 10, roundsStarted: 0,
    activation: 'armed', createdAt: 0, updatedAt: 0, ...goal,
  });
  let current = initial === undefined ? undefined : view(initial);
  const goals = {
    get: () => current,
    create: (_agent, request) => { calls.push({ op: 'create', request }); current = view({ ...request, roundsStarted: 0 }); return current; },
    edit: (_agent, ref, request) => { calls.push({ op: 'edit', ref, request }); current = view({ ...current, ...request }); return current; },
    pause: () => { calls.push({ op: 'pause' }); current = view({ ...current, phase: 'paused' }); return current; },
    resume: () => { calls.push({ op: 'resume' }); current = view({ ...current, phase: 'active' }); return current; },
    clear: () => { calls.push({ op: 'clear' }); current = undefined; return { id: 'g1', revision: 2 }; },
  };
  let registered;
  apply({ commands: { register: entry => { registered = entry } }, goals });
  assert.equal(registered.name, 'goal');
  return {
    calls,
    current: () => current,
    run: rawInput => registered.handler({ agent: {}, rawInput, attachments: [] }),
  };
}

test('/goal[20] <objective> creates the goal with that round cap', () => {
  const h = harness(undefined);
  const result = h.run('[20] ship the trigger foundation');
  assert.equal(result.kind, 'success');
  assert.deepEqual(h.calls, [{ op: 'create', request: { objective: 'ship the trigger foundation', maxGoalRounds: 20 } }]);
  assert.match(result.text, /Rounds: 0\/20/);
});

test('/goal[20] re-caps the current goal without touching its objective', () => {
  const h = harness({ objective: 'keep the build green', maxGoalRounds: 5 });
  const result = h.run('[40]');
  assert.equal(result.kind, 'success');
  assert.deepEqual(h.calls, [{ op: 'edit', ref: { id: 'g1', revision: 1 }, request: { maxGoalRounds: 40 } }]);
  assert.match(result.text, /Rounds: 0\/40/);
  assert.match(result.text, /keep the build green/);
});

test('a cap with no goal is refused with usable text, not a silently dropped cap', () => {
  const h = harness(undefined);
  const result = h.run('[20]');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /No goal is currently set/);
  assert.match(result.text, /\[<rounds>\]/);
  assert.deepEqual(h.calls, []);
});

test('a control word after a cap is refused instead of becoming an objective', () => {
  for (const input of ['[20] pause', '[20] clear', '[20] edit']) {
    const h = harness({ objective: 'x' });
    const result = h.run(input);
    assert.equal(result.kind, 'error', input);
    assert.match(result.text, /positive whole number/);
    assert.deepEqual(h.calls, [], input);
  }
});

test('the upstream forms still behave: show, create, edit, pause, resume, clear', () => {
  const empty = harness(undefined);
  assert.match(empty.run('').text, /No goal is currently set/);
  empty.run('plain objective');
  assert.deepEqual(empty.calls, [{ op: 'create', request: { objective: 'plain objective' } }]);

  const active = harness({ objective: 'old', maxGoalRounds: 10 });
  const edited = active.run('edit new objective');
  assert.match(edited.text, /new objective/);
  assert.deepEqual(active.calls.at(-1), { op: 'edit', ref: { id: 'g1', revision: 1 }, request: { objective: 'new objective' } });

  const pausable = harness({ objective: 'x' });
  assert.equal(pausable.run('pause').kind, 'success');
  assert.deepEqual(pausable.calls, [{ op: 'pause' }]);

  const resumable = harness({ objective: 'x', phase: 'paused' });
  assert.equal(resumable.run('resume').kind, 'success');
  assert.deepEqual(resumable.calls, [{ op: 'resume' }]);

  const clearable = harness({ objective: 'x' });
  assert.equal(clearable.run('clear').kind, 'success');
  assert.deepEqual(clearable.calls, [{ op: 'clear' }]);
});

test('a second goal is refused while one is active, as upstream does', () => {
  const h = harness({ objective: 'active work' });
  const result = h.run('[20] another objective');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /already active/);
  assert.deepEqual(h.calls, []);
});
