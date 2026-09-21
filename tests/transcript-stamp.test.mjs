process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatLinesCache, dscodeChatLines } from '../packages/tui/src/dscode/chat.ts';
import { createTranscriptView, projectEvent } from '../packages/tui/src/render/projection.ts';
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

// Streaming re-renders the whole live region every frame while only
// `view.streaming` changes; the projection replaces an entry object whenever its
// content changes. The cache may therefore key on entry identity — but only if
// it computes exactly what the entry, the width and `verbose` say.
test('the live-region cache reuses an unchanged entry and follows every dependency', () => {
  const lines = createChatLinesCache();
  const entry = toolEntry(Date.UTC(2026, 8, 17, 6, 30, 5));
  const first = lines(entry, 80, true);
  assert.equal(lines(entry, 80, true), first, 'the same entry at the same width is reused, not re-flowed');
  assert.equal(lines(entry, 79, true) === first, false, 'a width change re-wraps');
  assert.equal(lines(entry, 80, false) === first, false, 'verbose changes the rows');
  assert.equal(lines(toolEntry(Date.UTC(2026, 8, 17, 6, 30, 5)), 80, true) === first, false, 'a replaced entry is a new key');
  // The cached answer is the uncached one, not a stale earlier width.
  assert.deepEqual(lines(entry, 80, true), dscodeChatLines(entry, 80, true));
});

test('the live-region cache keeps its contexts apart and wraps at the keyed width', () => {
  const lines = createChatLinesCache();
  const entry = { kind: 'assistant', text: 'wrap me '.repeat(40), reasoning: '', time: undefined, turnEnded: true };
  const wide = lines(entry, 100, false);
  const narrow = lines(entry, 40, false);
  assert.notEqual(wide, narrow);
  assert.equal(lines(entry, 100, false), wide, 'interleaving another width must not evict this one');
  assert.equal(lines(entry, 40, false), narrow);
  // A fractional column count keys the floored width and wraps at it too.
  const fractional = lines(entry, 80.7, false);
  assert.deepEqual(fractional, dscodeChatLines(entry, 80, false));
  assert.equal(lines(entry, 80, false), fractional);
});

test('the live-region cache returns the same row content, not a grown one', () => {
  const lines = createChatLinesCache();
  const entry = { kind: 'assistant', text: 'hello world '.repeat(30), reasoning: '', time: undefined, turnEnded: true };
  const first = lines(entry, 60, false);
  for (let frame = 0; frame < 40; frame += 1) {
    assert.equal(lines(entry, 60, false), first, `frame ${frame}`);
  }
  assert.deepEqual(first, dscodeChatLines(entry, 60, false));
});

// The cache's soundness rests on one projection invariant: a frame that only
// streams text must not replace the entries around it. This pins it against a
// real projection fold rather than the comment that claims it.
test('streaming frames leave settled entries identical for the cache to reuse', () => {
  const call = { type: 'tool/call', seq: 1, time: 1000, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' } };
  const result = { type: 'tool/result', seq: 2, time: 1200, data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } } };
  let view = createTranscriptView();
  view = projectEvent(view, call);
  view = projectEvent(view, result);
  const before = view.entries;
  const tool = before.find(entry => entry.kind === 'tool');
  assert(tool !== undefined);
  // Two live stream frames of an assistant answer arriving after the tool row.
  for (const text of ['first token', 'first token and more']) {
    view = projectEvent(view, { type: 'agent/assistant-stream', seq: 3, time: 1300, data: { agentId: 'a', frame: { type: 'chunk', chunk: { type: 'text-delta', text } } } });
  }
  assert.equal(view.entries.find(entry => entry.kind === 'tool'), tool, 'the unchanged tool entry keeps its identity');
  assert.equal(view.entries.filter(entry => entry.kind === 'tool').length, 1, 'no duplicate live row for the same call');
});
