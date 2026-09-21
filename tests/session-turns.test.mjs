// The module keeps only the budget gate: per-turn attribution was never wired
// to a surface and the session-metrics view folds the same ledger for /usage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeCostByTurn, evaluateBudget, parseBudget, turnAt, turnBounds, turnWindows } from '../plugins/session-metrics/turns.mjs';
import { usageLines, turnUsages } from '../packages/tui/src/render/usage.ts';

const events = [
  { type: 'turn/start', time: 0, data: { turn: 1 } },
  { type: 'turn/end', time: 10000, data: { turn: 1 } },
  { type: 'turn/start', time: 100000, data: { turn: 2 } },
];
const row = (time, cost, purpose = 'agent') => ({ kind: 'end', id: String(time), time, cost, purpose });

// The attribution fold is what the footer's last-turn figure and the /usage
// cost column read, and it must stay cheap enough to run once a second.
test('turn windows and the bounds a call is priced against', () => {
  assert.deepEqual(turnWindows(events), [
    { turn: 1, start: 0, end: 10000 },
    { turn: 2, start: 100000, end: Infinity },
  ]);
  // An open turn is bounded by the next turn's start, so an interrupted turn
  // cannot swallow the calls of the turn that follows it.
  assert.deepEqual(turnBounds([
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'turn/start', time: 100, data: { turn: 2 } },
  ]), [
    { turn: 1, start: 0, end: 100 },
    { turn: 2, start: 100, end: Infinity },
  ]);
  // The in-flight turn keeps running to infinity.
  assert.equal(turnBounds(events)[1].end, Infinity);
});

test('the binary window lookup finds the containing turn, never a neighbour', () => {
  const bounds = turnBounds([
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'turn/end', time: 100, data: { turn: 1 } },
    { type: 'turn/start', time: 200, data: { turn: 2 } },
    { type: 'turn/end', time: 300, data: { turn: 2 } },
    { type: 'turn/start', time: 400, data: { turn: 3 } },
  ]);
  assert.equal(turnAt(bounds, 0), 0);
  assert.equal(turnAt(bounds, 100), 0, 'the closing edge belongs to the turn that closed');
  assert.equal(turnAt(bounds, 101), -1, 'the gap between two turns holds no call');
  assert.equal(turnAt(bounds, 300), 1);
  assert.equal(turnAt(bounds, 5000), 2, 'the running turn is open-ended');
  assert.equal(turnAt([], 5), -1);
  // Cross-check the search against a linear scan over many windows.
  const many = Array.from({ length: 50 }, (_, index) => ({ type: 'turn/start', time: index * 1000, data: { turn: index + 1 } }));
  const wide = turnBounds(many);
  for (let time = 0; time < 50000; time += 137) {
    const linear = wide.findIndex(candidate => time >= candidate.start && time <= candidate.end);
    assert.equal(turnAt(wide, time), linear, `time ${time}`);
  }
});

test('cost is attributed to the turn that was running, and the last finished turn is exposed', () => {
  const attribution = attributeCostByTurn([row(50, 0.1), row(5000, 0.2), row(101000, 0.3), row(50000, 0.7)], events);
  assert.deepEqual(attribution.turns.map(turn => [turn.turn, Math.round(turn.cost * 100), turn.calls]), [[1, 30, 2], [2, 30, 1]]);
  assert.equal(Math.round(attribution.unattributed * 100), 70, 'a call in the gap is reported, never charged to a neighbour');
  assert.deepEqual([attribution.lastTurn.turn, Math.round(attribution.lastTurn.cost * 100)], [1, 30], 'the running turn is not the last COMPLETED one');
  const closedSecond = attributeCostByTurn([row(101000, 0.3)], [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'turn/end', time: 10000, data: { turn: 1 } },
    { type: 'turn/start', time: 100000, data: { turn: 2 } },
    { type: 'turn/end', time: 200000, data: { turn: 2 } },
  ]);
  assert.equal(closedSecond.lastTurn.turn, 2);
  // An unpriceable call marks its turn without inventing a cost.
  const unknown = attributeCostByTurn([row(50, 0.1), { kind: 'end', id: 'x', time: 60, cost: null }], events);
  assert.equal(unknown.turns[0].cost, 0.1);
  assert.equal(unknown.turns[0].unknown, true);
});

test('the budget gate holds at the warn share and fires over the limit', () => {
  assert.equal(evaluateBudget(0.79, 1).state, 'ok');
  assert.equal(evaluateBudget(0.80, 1).state, 'warn');
  assert.equal(evaluateBudget(0.99, 1).state, 'warn');
  assert.equal(evaluateBudget(1, 1).state, 'over', 'exactly at the limit stops');
  assert.equal(evaluateBudget(1.5, 1).state, 'over');
  assert.equal(evaluateBudget(0.80, 1).percent, 80);
  assert.equal(evaluateBudget(1.5, 1).percent, 150, 'over-budget keeps the real percentage');
  // No limit, or one that cannot be spent against, never gates.
  for (const limit of [0, -1, null, undefined, NaN, 'nope']) assert.equal(evaluateBudget(5, limit).state, 'unset');
  assert.equal(evaluateBudget(NaN, 1).state, 'ok', 'an unknown spend is zero, not over budget');
  assert.equal(evaluateBudget(0.5, 1, { warnPercent: 50 }).state, 'warn', 'the warn share is configurable');
});

test('the budget value accepts a positive number and rejects everything else', () => {
  assert.equal(parseBudget(' 2.5 '), 2.5);
  assert.equal(parseBudget('3'), 3);
  assert.equal(parseBudget(4), 4);
  for (const value of ['0', '-1', 'abc', '', '   ', 0, -2, NaN, undefined, null, {}]) assert.equal(parseBudget(value), null);
});

// The /usage panel prices each turn from the same ledger the footer reads.

test('the usage panel prices each turn and marks an incomplete price', () => {
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'turn/end', time: 100, data: { turn: 1 } },
    { type: 'turn/start', time: 200, data: { turn: 2 } },
    { type: 'turn/end', time: 300, data: { turn: 2 } },
  ];
  const usage = { uncachedInputTokens: 100, outputTokens: 20, totalTokens: 120 };
  const turns = turnUsages(events, () => usage, [
    { turn: 1, cost: 0.0421, unknown: false },
    { turn: 2, cost: 0.5, unknown: true },
  ]);
  assert.deepEqual(turns.map(turn => [turn.turn, turn.cost.cost, turn.cost.unknown]), [[1, 0.0421, false], [2, 0.5, true]]);
  const text = usageLines({ turns }, 120).map(line => line.segments.map(segment => segment.text).join('')).join('\n');
  assert.match(text, /\$0\.0421/, 'a priced turn reads its cost');
  assert.match(text, /\$0\.5000\+/, 'an incompletely priced turn is marked');
  // A session with no ledger shows `--` instead of inventing a price.
  const noCost = turnUsages(events, () => usage);
  assert.equal(noCost.every(turn => turn.cost === undefined), true);
  const bare = usageLines({ turns: noCost }, 120).map(line => line.segments.map(segment => segment.text).join('')).join('\n');
  assert.match(bare, /--/);
});

test('a boundary without a time cannot orphan a turn, and unpriced spend outside a window stays visible', () => {
  // A start with no time used to store a NaN edge, which made the ascending
  // search false and silently reported every call of that turn as unattributed.
  const attribution = attributeCostByTurn(
    [row(50, 0.1)],
    [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'turn/start', time: 5, data: { turn: 1 } },
      { type: 'turn/end', time: 100, data: { turn: 1 } },
    ],
  );
  assert.deepEqual(attribution.turns.map(turn => [turn.turn, Math.round(turn.cost * 100)]), [[1, 10]]);
  assert.equal(attribution.lastTurn.turn, 1);
  // Spend that no window can price is flagged, not counted as nothing.
  const outside = attributeCostByTurn([{ kind: 'end', id: 'x', time: 50000, cost: null }], events);
  assert.equal(outside.unattributedUnknown, true);
  assert.equal(outside.unattributed, 0);
  const priced = attributeCostByTurn([row(50000, 0.25)], events);
  assert.equal(priced.unattributedUnknown, false);
  assert.equal(priced.unattributed, 0.25);
});
