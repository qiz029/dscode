import test from 'node:test';
import assert from 'node:assert/strict';
import { BTW_SEED_EVENT_LIMIT, btwBrief, btwSeed, btwTitle, createBtwFeed } from '../packages/tui/src/btw.ts';

const user = (seq, text) => ({ seq, type: 'user/message', time: seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
const answer = (seq, text) => ({ seq, type: 'assistant/message', time: seq, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] }, usage: { inputTokens: 1, outputTokens: 1 } } });
const turn = (seq, end = false) => ({ seq, type: end ? 'turn/end' : 'turn/start', time: seq, data: { turn: 1 } });
const log = () => [turn(0), user(1, 'do the thing'), answer(2, 'done'), turn(3, true)];

test('a side question inherits the main log up to the last completed turn', () => {
  const events = [...log(), turn(4), user(5, 'and also this')];
  const seed = btwSeed(events);
  assert.equal(seed.inherited, true);
  assert.deepEqual(seed.events.map(event => event.seq), [0, 1, 2, 3], 'the open turn stays behind');
});

test('an over-long conversation degrades to a brief instead of a trimmed seed', () => {
  const events = [...log(), ...Array.from({ length: BTW_SEED_EVENT_LIMIT }, (_, index) => user(index + 4, `noise ${index}`)), turn(BTW_SEED_EVENT_LIMIT + 4, true)];
  const seed = btwSeed(events);
  assert.equal(seed.inherited, false, 'a complete-turn prefix must stay contiguous from seq 0, so it cannot be trimmed');
  assert.deepEqual(seed.events, []);
});

test('a side question asked mid-turn runs unseeded rather than failing', () => {
  assert.deepEqual(btwSeed([turn(0), user(1, 'still running')]), { events: [], inherited: false });
});

test('the brief names the last request and answer, on one bounded line each', () => {
  const brief = btwBrief([turn(0), user(1, 'fix the parser\nin two files'), answer(2, 'patched both'), turn(3, true)]);
  assert.match(brief, /^Background from the main conversation/);
  assert.match(brief, /User last asked: fix the parser in two files/);
  assert.match(brief, /The agent last answered: patched both/);
  assert.equal(brief.split('\n').length, 3);
  const clipped = btwBrief([user(1, 'x'.repeat(500))], 120);
  assert.ok(clipped.length <= 220, clipped.length);
  const both = btwBrief([user(1, 'y'.repeat(4000)), answer(2, 'z'.repeat(4000))]);
  assert.ok(both.length <= 1_200, `the brief honors its limit, got ${both.length}`);
  assert.deepEqual(btwBrief([]), '');
});

test('a run title stays on one bounded line', () => {
  assert.equal(btwTitle('  what about\nthe cache?  '), 'what about ↵ the cache?');
  assert.equal(btwTitle('x'.repeat(400)).length, 160);
});

test('the feed folds a run transcript, settles once, and retires the oldest', () => {
  const feed = createBtwFeed(1);
  let changes = 0;
  const unsubscribe = feed.subscribe(() => { changes += 1; });
  feed.begin({ id: 's-1', question: 'why is it slow?', at: 1_000 });
  assert.deepEqual(feed.list().map(run => [run.id, run.status, run.title]), [['s-1', 'running', 'why is it slow?']]);
  feed.apply('s-1', user(1, 'why is it slow?'));
  feed.apply('s-1', answer(2, 'because of the cache'));
  feed.applyStreamFrame('s-2', { type: 'text-delta', text: 'ignored' });
  const view = feed.store('s-1')?.getView();
  assert.equal(view?.entries.length, 2, 'the child transcript folds into its own store');
  feed.settle('s-1', 'done');
  const settled = feed.list()[0];
  assert.equal(settled.status, 'done');
  assert.ok(settled.endedAt !== undefined);
  feed.settle('s-1', 'failed', 'too late');
  assert.equal(feed.list()[0].status, 'done', 'the first settlement wins');
  feed.begin({ id: 's-2', question: 'and this?', at: 2_000 });
  feed.settle('s-2', 'done');
  feed.begin({ id: 's-3', question: 'third', at: 3_000 });
  feed.settle('s-3', 'done');
  assert.deepEqual(feed.list().map(run => run.id), ['s-3'], 'the oldest settled run retires at the limit');
  feed.begin({ id: 's-4', question: 'fourth', at: 4_000 });
  assert.deepEqual(feed.list().map(run => run.id), ['s-4', 's-3'], 'a running run never retires');
  feed.drop('s-4');
  assert.deepEqual(feed.list().map(run => run.id), ['s-3']);
  const heard = changes;
  unsubscribe();
  feed.drop('s-3');
  assert.equal(changes, heard, 'unsubscribed listeners stop hearing');
});
