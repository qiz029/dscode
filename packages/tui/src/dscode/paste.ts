/**
 * dscode: large pastes collapse to one marker in the draft so the composer stays
 * readable, then expand back to the full text on submit. The marker is atomic for
 * every edit and cursor move, so a paste can never be half-deleted.
 *
 * @module dsh-code/dscode/paste
 */

import type { EditResult } from '../render/editor.ts'

/** Pastes longer than this collapse to a marker. */
export const LARGE_PASTE_CHARS = 200

export function collapseLargePaste(text: string, draft: string, pastes: Map<string, string>): string {
  const safe = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').replaceAll('\t', '  ');
  const count = [...safe].length;
  if (count <= LARGE_PASTE_CHARS) return safe;
  // Keep an executable-looking first line visible to the command router.
  if (draft.trim() === '' && /^\s*[!/]/u.test(safe)) return safe;
  const base = `[Pasted Content ${count} chars]`;
  let marker = base;
  for (let suffix = 2; draft.includes(marker) || pastes.has(marker); suffix++) marker = `${base} #${suffix}`;
  pastes.set(marker, safe);
  return marker;
}

export function expandLargePastes(value: string, pastes: ReadonlyMap<string, string>): string {
  const markers = [...pastes.keys()].sort((left, right) => right.length - left.length);
  let expanded = '';
  let offset = 0;
  while (offset < value.length) {
    let found = -1;
    let match;
    for (const marker of markers) {
      const at = value.indexOf(marker, offset);
      if (at >= 0 && (found < 0 || at < found)) {
        found = at;
        match = marker;
      }
    }
    if (match === undefined) break;
    expanded += value.slice(offset, found) + pastes.get(match)!;
    offset = found + match.length;
  }
  return expanded + value.slice(offset);
}

export function pasteAtomicEdit(before: string, edit: EditResult, pastes: Map<string, string>): EditResult {
  let prefix = 0;
  while (prefix < before.length && prefix < edit.value.length && before[prefix] === edit.value[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < edit.value.length - prefix && before[before.length - suffix - 1] === edit.value[edit.value.length - suffix - 1]) suffix++;
  let from = prefix, to = before.length - suffix;
  const inserted = edit.value.slice(prefix, edit.value.length - suffix);
  let touched = false;
  const originalPastes = new Map(pastes);
  for (const marker of pastes.keys()) {
    const start = before.indexOf(marker);
    if (start < 0) continue;
    const end = start + marker.length;
    if (from < end && to > start || from === to && from > start && from < end) {
      from = Math.min(from, start);
      to = Math.max(to, end);
      pastes.delete(marker);
      touched = true;
    }
  }
  if (touched) edit = { ...edit, value: before.slice(0, from) + inserted + before.slice(to), cursor: from + inserted.length,
    killed: edit.killed === undefined ? undefined : expandLargePastes(before.slice(from, to), originalPastes) };
  for (const marker of pastes.keys()) if (!edit.value.includes(marker) && before.includes(marker)) pastes.delete(marker);
  return edit;
}

export function pasteCursorEdge(value: string, previous: number, next: number, pastes: ReadonlyMap<string, string>): number {
  for (const marker of pastes.keys()) {
    const start = value.indexOf(marker);
    if (start < 0) continue;
    const end = start + marker.length;
    if (next > start && next < end) return next < previous ? start : end;
  }
  return next;
}
