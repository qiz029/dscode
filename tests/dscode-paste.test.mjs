import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseLargePaste, expandLargePastes, pasteAtomicEdit, pasteCursorEdge, LARGE_PASTE_CHARS } from '../packages/tui/src/dscode/paste.ts';
import { deleteBackward } from '../packages/tui/src/render/editor.ts';

// The composer collapses a large paste into one marker. These pin the contract the
// renderer relies on: a marker is atomic for every edit and cursor move, so a paste
// can never be half-deleted, and the full text survives a round trip.

const markerFor = count => `[Pasted Content ${count} chars]`;

test('a short paste stays literal and a large one collapses to a marker', () => {
  assert.equal(collapseLargePaste('short', '', new Map()), 'short');
  const pastes = new Map();
  const text = 'x'.repeat(LARGE_PASTE_CHARS + 100);
  const marker = collapseLargePaste(text, '', pastes);
  assert.equal(marker, markerFor(LARGE_PASTE_CHARS + 100));
  assert.equal(pastes.get(marker), text, 'the body is kept verbatim under the marker');
});

test('a marker already in the draft or the map is suffixed, never reused', () => {
  const pastes = new Map();
  const text = 'y'.repeat(LARGE_PASTE_CHARS + 1);
  const first = collapseLargePaste(text, '', pastes);
  assert.equal(collapseLargePaste(text, first, pastes), first + ' #2');
  assert.equal(collapseLargePaste(text, '', pastes), first + ' #3');
});

test('an over-long shell command keeps its first line visible to the router', () => {
  const command = '!' + 'x'.repeat(LARGE_PASTE_CHARS + 50);
  assert.equal(collapseLargePaste(command, '', new Map()), command);
  assert.equal(collapseLargePaste('/' + 'x'.repeat(LARGE_PASTE_CHARS + 50), '', new Map()).startsWith('/'), true);
});

test('collapsing normalizes newlines and strips control characters', () => {
  assert.equal(collapseLargePaste('a\r\nb\tc\u0007', '', new Map()), 'a\nb  c');
});

test('expanding replaces every marker and prefers the longest match', () => {
  const pastes = new Map([['[P]', 'short'], ['[P] long', 'longer']]);
  assert.equal(expandLargePastes('x [P] long y', pastes), 'x longer y');
  assert.equal(expandLargePastes('plain', pastes), 'plain');
});

test('one backspace inside a marker deletes the whole marker, never a fragment', () => {
  const marker = markerFor(3);
  const pastes = new Map([[marker, 'abc']]);
  const before = 'keep ' + marker + ' tail';
  const edit = deleteBackward(before, before.indexOf(marker) + 2);
  const after = pasteAtomicEdit(before, edit, pastes);
  assert.equal(after.value.includes(marker), false, 'the marker is gone');
  assert.equal(after.value.includes(marker.slice(0, 5)), false, 'no fragment survives');
  assert.equal(pastes.has(marker), false, 'the collapsed body is released with it');
  assert.equal(after.value, 'keep  tail', 'the marker leaves one gap, not a fragment');
  // A backspace just BEFORE the marker is an ordinary edit: the marker stays whole.
  const beforeMarker = deleteBackward(before, before.indexOf(marker));
  const kept = pasteAtomicEdit(before, beforeMarker, new Map([[marker, 'abc']]));
  assert.equal(kept.value.includes(marker), true, 'the marker survives an edit outside it');
});

test('a cursor inside a marker snaps to its edge in the direction of travel', () => {
  const marker = markerFor(3);
  const pastes = new Map([[marker, 'abc']]);
  const value = 'x ' + marker;
  const start = value.indexOf(marker);
  const end = start + marker.length;
  assert.equal(pasteCursorEdge(value, start, start + 3, pastes), end, 'moving right leaves the marker');
  assert.equal(pasteCursorEdge(value, end, end - 2, pastes), start, 'moving left leaves the marker');
  assert.equal(pasteCursorEdge('x plain', 1, 2, pastes), 2, 'a cursor outside every marker is untouched');
});
