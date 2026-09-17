process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { dscodeChatLines } from '../packages/tui/src/dscode/chat.ts';
import { visibleColumns } from '../packages/tui/src/render/markdown.ts';

/** The local HH:MM:SS label the renderer builds for an event time. */
const labelOf = time => {
  const at = new Date(time);
  const pad = value => String(value).padStart(2, '0');
  return pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds());
};
const rowText = row => row.segments.map(segment => segment.text).join('');
const toolEntry = time => ({
  kind: 'tool', time, callId: 'c1', ordinal: 1, name: 'bash', arguments: '{}', preview: 'echo hi',
  prompt: '', state: 'done', summary: '', detail: undefined, subs: [], subsDropped: 0,
});

test('agent tool rows carry a local time stamp in front of the block', () => {
  const time = Date.UTC(2026, 8, 17, 6, 30, 5);
  const label = labelOf(time) + ' ';
  const lines = dscodeChatLines(toolEntry(time), 80, true);
  assert(rowText(lines[0]).startsWith(label + '\u00b7 Tool Call: bash'), rowText(lines[0]));
  assert.equal(lines[0].segments[0].style, 'dim');
  // A row without an event time stays unstamped.
  const plain = dscodeChatLines(toolEntry(undefined), 80, true);
  assert.equal(rowText(plain[0]).startsWith('\u00b7 Tool Call: bash'), true, rowText(plain[0]));
  assert(plain.every(row => !rowText(row).includes(labelOf(time))));
});

test('a reply stamps its thinking block and its answer', () => {
  const time = Date.UTC(2026, 8, 17, 6, 30, 5);
  const label = labelOf(time) + ' ';
  const assistant = { kind: 'assistant', time, text: 'the answer', reasoning: 'weighing options' };
  const verbose = dscodeChatLines(assistant, 80, true);
  assert(rowText(verbose[0]).startsWith(label + '\u00b7 Thinking:'), rowText(verbose[0]));
  const answer = verbose.slice(verbose.findIndex(row => row.segments.length === 0) + 1).find(row => row.segments.length > 0);
  assert(rowText(answer).startsWith(label), rowText(answer));
  // Without verbose the folded thinking is absent and the answer still carries its stamp.
  const terse = dscodeChatLines(assistant, 80, false);
  assert(rowText(terse[0]).startsWith(label), rowText(terse[0]));
});

/** A stamped block must stay inside the terminal width: an overflowing row would cost an
 * extra screen row per block, which is exactly the composer jitter this renderer avoids. */
test('a stamped block still fits the terminal width', () => {
  const time = Date.UTC(2026, 8, 17, 6, 30, 5);
  const assistant = { kind: 'assistant', time, text: 'x'.repeat(200), reasoning: 'y'.repeat(120) };
  const cells = line => line.segments.reduce((sum, segment) => sum + visibleColumns(segment.text), 0);
  for (const verbose of [true, false]) {
    const lines = dscodeChatLines(assistant, 60, verbose);
    assert(lines.every(line => cells(line) <= 60), lines.map(cells).join(','));
  }
  const tool = dscodeChatLines({ ...toolEntry(time), preview: 'z'.repeat(120) }, 60, true);
  assert(tool.every(line => cells(line) <= 60), tool.map(cells).join(','));
});
