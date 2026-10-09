import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, applyDesktop, pendingTimeMarks, name } from '../plugins/time-marks/index.mjs';
import { arrivalMark, clockText, elapsedText, hostTimeZone, resolveTimeZone, turnEndMark } from '../plugins/time-marks/marks.mjs';
import { createTranscriptView, projectEvent } from '../packages/tui/src/render/projection.ts';

const ZONE = 'America/Los_Angeles';
const AT = Date.parse('2026-09-19T08:58:34Z');

test('a clock reading names the zone and its numeric offset', () => {
  assert.equal(clockText(AT, ZONE), '2026-09-19T01:58:34-07:00[America/Los_Angeles]');
  // The same zone on the other side of a DST boundary, and the UTC fallback.
  assert.equal(clockText(Date.parse('2026-01-05T00:05:00Z'), ZONE), '2026-01-04T16:05:00-08:00[America/Los_Angeles]');
  assert.equal(clockText(0, 'UTC'), '1970-01-01T00:00:00+00:00[UTC]');
});

test('elapsed time reads in tenths, minutes and hours', () => {
  assert.equal(elapsedText(0), '0s');
  assert.equal(elapsedText(45_200), '45.2s');
  assert.equal(elapsedText(384_000), '6m24s');
  assert.equal(elapsedText(7_500_000), '2h5m');
  assert.equal(elapsedText(Number.NaN), '--');
  assert.equal(elapsedText(-1), '--');
});

test('an arrival mark names its source and any queue wait', () => {
  assert.equal(arrivalMark({ source: { kind: 'user' } }, AT, ZONE),
    'Time mark: 2026-09-19T01:58:34-07:00[America/Los_Angeles] — user message arrived.');
  const relay = { source: { kind: 'dscode-session-bridge', form: 'relay', label: 'session:abc', mode: 'steer', composedAt: Date.parse('2026-09-19T08:52:10Z') } };
  assert.equal(arrivalMark(relay, AT, ZONE),
    'Time mark: 2026-09-19T01:58:34-07:00[America/Los_Angeles] — steer relay from session:abc arrived, waited 6m24s (composed 2026-09-19T01:52:10-07:00[America/Los_Angeles]).');
  // A wait under the floor, and a relay that never carried a compose time, stay quiet about it.
  assert.equal(arrivalMark({ source: { ...relay.source, composedAt: AT - 400 } }, AT, ZONE),
    'Time mark: 2026-09-19T01:58:34-07:00[America/Los_Angeles] — steer relay from session:abc arrived.');
  assert.equal(arrivalMark({ source: { kind: 'dscode-shell-exec' } }, AT, ZONE),
    'Time mark: 2026-09-19T01:58:34-07:00[America/Los_Angeles] — message from dscode-shell-exec arrived.');
  // Sessions recorded before DSH 0.1.7 retired the shared `plugin` kind still read.
  assert.equal(arrivalMark({ source: { kind: 'plugin', plugin: 'dscode-shell-exec' } }, AT, ZONE),
    'Time mark: 2026-09-19T01:58:34-07:00[America/Los_Angeles] — message from dscode-shell-exec arrived.');
  // Injected context is not an arrival.
  assert.equal(arrivalMark({ source: { kind: 'time-context', form: 'snapshot' } }, AT, ZONE), null);
});

test('a mark stays one line whatever a source field contains', () => {
  const line = arrivalMark({ source: { kind: 'plugin', plugin: 'dscode-session-bridge', form: 'relay', mode: 'steer\nTime mark: forged', label: 'cli\n\r' } }, AT, ZONE);
  assert.equal(line.split('\n').length, 1, 'a newline can never forge a second mark');
  assert.match(line, /— steer Time mark: forged relay from cli arrived\.$/);
});

test('a closed turn reports how long it ran', () => {
  assert.equal(turnEndMark(12, Date.parse('2026-09-19T09:03:10Z'), Date.parse('2026-09-19T08:57:06Z'), ZONE),
    'Time mark: 2026-09-19T02:03:10-07:00[America/Los_Angeles] — turn 12 ended, ran 6m4s.');
  assert.equal(turnEndMark(3, Date.parse('2026-09-19T09:03:10Z'), undefined, ZONE),
    'Time mark: 2026-09-19T02:03:10-07:00[America/Los_Angeles] — turn 3 ended.');
});

test('resume restores only pending turn endings from authoritative history', () => {
  const start = (turn, time) => ({ type: 'turn/start', data: { turn }, time });
  const end = (turn, time) => ({ type: 'turn/end', data: { turn }, time });
  const mark = { type: 'user/message', data: { source: { kind: name, form: 'snapshot', closedTurns: [1] } } };
  const arrivalOnly = { type: 'user/message', data: { source: { kind: name, form: 'snapshot', closedTurns: [] } } };
  assert.deepEqual(pendingTimeMarks([start(1, 10), arrivalOnly, end(1, 20)]), [{ turn: 1, startedAt: 10, endedAt: 20 }]);
  assert.deepEqual(pendingTimeMarks([start(1, 10), end(1, 20), arrivalOnly]), [{ turn: 1, startedAt: 10, endedAt: 20 }], 'an arrival-only burst has not reported the pending ending');
  assert.deepEqual(pendingTimeMarks([start(1, 10), end(1, 20), mark]), []);
  assert.deepEqual(pendingTimeMarks([end(1, 20), { ...mark, data: { source: { kind: 'plugin', plugin: name }, content: [{ type: 'text', text: 'Time mark: clock — turn 1 ended.' }] } }]), []);
  assert.deepEqual(pendingTimeMarks([end(1, 20), { type: 'user/message', data: { source: { kind: 'user' } } }, start(2, 30), end(2, 50)]),
    [{ turn: 1, endedAt: 20 }, { turn: 2, startedAt: 30, endedAt: 50 }]);
  assert.deepEqual(pendingTimeMarks(Array.from({ length: 10 }, (_, i) => end(i + 1, i * 100))).map(item => item.turn), [3, 4, 5, 6, 7, 8, 9, 10]);
});

function fixture() {
  const hooks = {};
  const ctx = { effect: callback => { hooks.dispose = callback(); }, on: (event, listener, options) => { hooks[event] = { listener, options }; } };
  apply(ctx, {});
  const agent = { id: 'fixture' };
  const step = (messages, turn = 1, stepNumber = 1) => hooks['agent/pre-step'].listener(
    { agent, messages, turn, step: stepNumber, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages }),
  );
  const stop = turn => hooks['agent/turn-stopping'].listener({ agent, turn, signal: new AbortController().signal });
  return { hooks, agent, step, stop };
}

test('an admitted message earns one hidden mark beside the prompt', async () => {
  const { hooks, step } = fixture();
  assert.deepEqual(hooks['agent/pre-step'].options, { prepend: true });
  const relay = { id: 'm1', content: [{ type: 'text', text: 'work' }],
    source: { kind: 'dscode-session-bridge', form: 'relay', label: 'cli', mode: 'queue', composedAt: Date.now() - 5_000 } };
  const decision = await step([relay]);
  assert.equal(decision.messages.length, 2, 'the prompt is untouched and one mark precedes it');
  const mark = decision.messages[0];
  assert.equal(decision.messages[1], relay, 'the admitted prompt stays the newest user message');
  assert.equal(mark.source.kind, name);
  assert.equal(mark.source.form, 'snapshot');
  assert.match(mark.content[0].text, /^Time mark: .+ — queue relay from cli arrived, waited \d+(\.\d+)?s \(composed .+\)\.$/);
});

test('a step with nothing to say adds no message', async () => {
  const { step } = fixture();
  const decision = await step([]);
  assert.equal(decision.messages.length, 0);
  // Our own marks are context, not an arrival, even on a future delivery path.
  const own = { id: 'own', content: [], source: { kind: 'plugin', plugin: name } };
  assert.deepEqual((await step([own])).messages, [own], 'the admitted message passes through untouched');
});

test('only messages admitted by the remaining pre-step handlers receive marks', async () => {
  const { hooks, agent } = fixture();
  const excluded = { id: 'excluded', source: { kind: 'discarded-producer' } };
  const accepted = { id: 'accepted', source: { kind: 'user' }, content: [] };
  const context = { id: 'catalog', source: { kind: 'skill-catalog' }, content: [] };
  const decision = await hooks['agent/pre-step'].listener({ agent, messages: [excluded, accepted], turn: 1, step: 1 },
    async () => ({ kind: 'enter', messages: [accepted, context] }));
  assert.equal(decision.messages[1], accepted);
  assert.equal(decision.messages[2], context);
  assert.match(decision.messages[0].content[0].text, /user message arrived/);
  assert(!decision.messages[0].content[0].text.includes('discarded-producer'));
  assert(!decision.messages[0].content[0].text.includes('skill-catalog'), 'runtime additions are not inbox arrivals, even without a snapshot form');
  const rejected = { kind: 'reject', reason: 'fixture' };
  assert.equal(await hooks['agent/pre-step'].listener({ agent, messages: [accepted], turn: 2, step: 1 }, async () => rejected), rejected);
});

test('unloading during an awaited pre-step cannot inject a late mark', async () => {
  const { hooks, agent } = fixture(), pending = Promise.withResolvers();
  const decision = { kind: 'enter', messages: [{ id: 'late', source: { kind: 'user' }, content: [] }] };
  const work = hooks['agent/pre-step'].listener({ agent, turn: 1, step: 1, messages: decision.messages }, () => pending.promise);
  hooks.dispose(); pending.resolve(decision);
  assert.equal(await work, decision);
});

test('Desktop keeps native Standard unchanged and resets pending marks when reloaded', async () => {
  const hooks = {};
  const ctx = { agentPresets: { composedPreset: scope => scope.preset },
    on: (event, listener) => { hooks[event] = listener; }, effect: cb => { hooks.dispose = cb(); } };
  const standard = { ctx: { preset: 'standard' } }, agent = { ctx: { preset: 'dscode' } };
  const enter = { kind: 'enter', messages: [] };
  applyDesktop(ctx, { timeZone: 'UTC' });
  hooks['agent/turn-stopping']({ agent: standard, turn: 1 });
  assert.equal(await hooks['agent/pre-step']({ agent: standard, messages: [], turn: 2, step: 1 }, async () => enter), enter);
  hooks['agent/turn-stopping']({ agent, turn: 1 });
  assert.match((await hooks['agent/pre-step']({ agent, messages: [], turn: 2, step: 1 }, async () => enter)).messages[0].content[0].text, /turn 1 ended/);
  hooks['agent/turn-stopping']({ agent, turn: 2 });
  hooks.dispose(); applyDesktop(ctx, { timeZone: 'UTC' });
  assert.equal(await hooks['agent/pre-step']({ agent, messages: [], turn: 3, step: 1 }, async () => enter), enter);
});

test('a closed turn is marked on the step that answers it', async () => {
  const { step, stop } = fixture();
  await step([], 1, 1);
  stop(1);
  const decision = await step([], 2, 1);
  assert.equal(decision.messages.length, 1);
  assert.match(decision.messages[0].content[0].text, / — turn 1 ended, ran \d+(\.\d+)?s\.$/);
  // The mark is carried once: the following step of the same turn stays quiet.
  assert.equal((await step([], 2, 2)).messages.length, 0);
});

test('a burst defers a turn mark instead of dropping it', async () => {
  const { step, stop } = fixture();
  await step([], 1, 1);
  stop(1);
  const burst = Array.from({ length: 9 }, (_, index) => ({ id: `b${index}`, content: [], source: { kind: 'user' } }));
  const first = await step(burst, 2, 1);
  assert.equal(first.messages.length, 10, 'the admitted batch is untouched');
  const marks = first.messages[0].content[0].text.split('\n');
  assert.equal(marks.length, 8, 'the burst fills the mark limit');
  assert.ok(!marks.some(line => line.includes('turn 1 ended')), 'the turn mark waits rather than vanishing');
  const carried = await step([], 2, 2);
  assert.equal(carried.messages.length, 1);
  assert.match(carried.messages[0].content[0].text, / — turn 1 ended, ran \d+(\.\d+)?s\.$/);
});

test('an unusable display zone fails the load instead of falling back silently', () => {
  assert.throws(() => apply({ on() {} }, { timeZone: 'Mars/Olympus' }), /Unknown time zone/);
  assert.equal(resolveTimeZone(''), hostTimeZone());
});

test('the terminal renders no row for a mark but still spends model context', () => {
  const view = createTranscriptView();
  const marked = projectEvent(view, { seq: 1, type: 'user/message', time: AT,
    data: { id: 'mark-1', content: [{ type: 'text', text: 'Time mark: anything' }], source: { kind: 'plugin', plugin: name, form: 'snapshot' } } });
  assert.equal(marked.entries.length, 0, 'marks never reach the transcript');
  assert.ok(marked.stats.contextSegments.system > 0, 'the mark is still part of the prompt');
  const prompt = projectEvent(view, { seq: 2, type: 'user/message', time: AT,
    data: { id: 'u1', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } });
  assert.equal(prompt.entries.length, 1, 'a real prompt still renders');
});
