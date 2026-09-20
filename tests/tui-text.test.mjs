import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from '../packages/tui/src/render/text.ts';

// The email preview wraps its body with this helper before rendering the rows, so
// these pin the display contract rather than a taste: rows never exceed the budget
// unless a single cluster cannot fit in it at all, and the wrap never drops a
// character or loops on a cluster wider than the budget.

test('wrapping fills each row to the column budget and breaks on newlines', () => {
  assert.deepEqual(wrapText('abcdef', 3), ['abc', 'def']);
  assert.deepEqual(wrapText('ab\ncd', 10), ['ab', 'cd']);
  assert.deepEqual(wrapText('', 5), ['']);
  assert.deepEqual(wrapText('line\n', 5), ['line', '']);
});

test('wide CJK clusters are budgeted at their display width, not one cell each', () => {
  assert.deepEqual(wrapText('你好世界', 4), ['你好', '世界']);
  // An odd budget keeps the row under it instead of splitting a double-width cell.
  assert.deepEqual(wrapText('你好', 3), ['你', '好']);
});

test('a cluster wider than the budget keeps a row of its own instead of looping', () => {
  assert.deepEqual(wrapText('你好', 1), ['你', '好']);
});

test('combining and joined emoji stay in one piece', () => {
  const cluster = '👩‍👩‍👧‍👦';
  assert.deepEqual(wrapText(`a${cluster}b`, 2), ['a', cluster, 'b']);
});
