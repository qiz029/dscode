import { replaceOnce } from './patch-runtime.mjs';

export const LARGE_PASTE_CHARS = 200;

export function collapseLargePaste(text, draft, pastes) {
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

export function expandLargePastes(value, pastes) {
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
    expanded += value.slice(offset, found) + pastes.get(match);
    offset = found + match.length;
  }
  return expanded + value.slice(offset);
}

export function pasteAtomicEdit(before, edit, pastes) {
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

export function pasteCursorEdge(value, previous, next, pastes) {
  for (const marker of pastes.keys()) {
    const start = value.indexOf(marker);
    if (start < 0) continue;
    const end = start + marker.length;
    if (next > start && next < end) return next < previous ? start : end;
  }
  return next;
}

export function patchLargePaste(text) {
  if (text.includes('// dscode-large-paste-v1')) {
    if (text.includes(`const LARGE_PASTE_CHARS = ${LARGE_PASTE_CHARS};`)) return text;
    return replaceOnce(text, 'const LARGE_PASTE_CHARS = 1000;', `const LARGE_PASTE_CHARS = ${LARGE_PASTE_CHARS};`);
  }
  const start = text.indexOf('function Input(');
  const end = text.indexOf('\n}\n/** Build one settled row', start) + 2;
  if (start < 0 || end <= start) throw Error('Pinned TUI Input drift');
  const original = text.slice(start, end);
  let input = original;
  const patch = (from, to) => { input = replaceOnce(input, from, to); };
  patch('const cursorRef = (0, import_react.useRef)(cursor);', 'const cursorRef = (0, import_react.useRef)(cursor);\n  const pendingPastesRef = (0, import_react.useRef)(new Map());');
  patch('const safe = sanitizeDraftText(historyFill.text);', 'const safe = sanitizeDraftText(historyFill.text);\n    pendingPastesRef.current.clear();');
  patch('}, [value]);\n\t(0, import_react.useEffect)(() => {\n\t\tif (stdin === void 0)', '}, [value]);\n  (0, import_react.useEffect)(() => {\n    for (const marker of pendingPastesRef.current.keys()) if (!value.includes(marker)) pendingPastesRef.current.delete(marker);\n  }, [value]);\n\t(0, import_react.useEffect)(() => {\n\t\tif (stdin === void 0)');
  patch('const applyEdit = (edit) => {\n\t\tif (edit.killed', 'const applyEdit = (edit) => {\n    edit = pasteAtomicEdit(valueRef.current, edit, pendingPastesRef.current);\n\t\tif (edit.killed');
  patch('if (next === cursorRef.current) return;\n\t\tcursorRef.current = next;', 'if (next === cursorRef.current) return;\n    next = pasteCursorEdge(valueRef.current, cursorRef.current, next, pendingPastesRef.current);\n\t\tcursorRef.current = next;');
  patch('const edit = insertText(nextValue, nextCursor, token.text);\n\t\t\t\tnextValue = edit.value;\n\t\t\t\tnextCursor = edit.cursor;', 'const edit = pasteAtomicEdit(nextValue, insertText(nextValue, nextCursor, collapseLargePaste(token.text, nextValue, pendingPastesRef.current)), pendingPastesRef.current);\n\t\t\t\tnextValue = edit.value;\n\t\t\t\tnextCursor = edit.cursor;');
  patch('nextCursor = moveToLineStart(nextValue, nextCursor, false);', 'nextCursor = pasteCursorEdge(nextValue, nextCursor, moveToLineStart(nextValue, nextCursor, false), pendingPastesRef.current);');
  patch('nextCursor = moveToLineEnd(nextValue, nextCursor, false);', 'nextCursor = pasteCursorEdge(nextValue, nextCursor, moveToLineEnd(nextValue, nextCursor, false), pendingPastesRef.current);');
  patch('if (edit.killed !== void 0 && edit.killed !== "") killRef.current = edit.killed;\n\t\t\tnextValue = edit.value;', 'const atomic = pasteAtomicEdit(nextValue, edit, pendingPastesRef.current);\n      if (atomic.killed !== void 0 && atomic.killed !== "") killRef.current = atomic.killed;\n\t\t\tnextValue = atomic.value;');
  patch('nextCursor = edit.cursor;\n\t\t}\n\t\tvalueRef.current = nextValue;', 'nextCursor = atomic.cursor;\n\t\t}\n\t\tvalueRef.current = nextValue;');
  patch('cursorRef.current = next;\n\t\t\tsetCursor(next);\n\t\t\tresetCursorBlink();\n\t\t\tpreferredColumnRef.current = preferred;', 'const edge = pasteCursorEdge(currentValue, currentCursor, next, pendingPastesRef.current);\n      cursorRef.current = edge;\n      setCursor(edge);\n\t\t\tresetCursorBlink();\n\t\t\tpreferredColumnRef.current = preferred;');
  patch('const trimmed = liveValue.trim();\n\t\t\tconst text = submissionPayload(liveValue);', 'const expandedValue = expandLargePastes(liveValue, pendingPastesRef.current);\n      const trimmed = expandedValue.trim();\n      const text = submissionPayload(expandedValue);');
  patch('else if (action === "clear-draft") {\n            valueRef.current = "";', 'else if (action === "clear-draft") {\n            pendingPastesRef.current.clear();\n            valueRef.current = "";');
  patch('if (controller.signal.aborted || prepareEpochRef.current !== epoch) return;\n\t\t\t\t\tprepareAbortRef.current = void 0;\n\t\t\t\t\tsetPreparingImages(false);\n\t\t\t\t\tvalueRef.current = "";', 'if (controller.signal.aborted || prepareEpochRef.current !== epoch) return;\n\t\t\t\t\tprepareAbortRef.current = void 0;\n\t\t\t\t\tsetPreparingImages(false);\n          pendingPastesRef.current.clear();\n\t\t\t\t\tvalueRef.current = "";');
  patch('\t\t\tvalueRef.current = "";\n\t\t\tcursorRef.current = 0;\n\t\t\tsetValue("");\n\t\t\tsetCursor(0);\n\t\t\tresetCursorBlink();', '\t\t\tpendingPastesRef.current.clear();\n\t\t\tvalueRef.current = "";\n\t\t\tcursorRef.current = 0;\n\t\t\tsetValue("");\n\t\t\tsetCursor(0);\n\t\t\tresetCursorBlink();');
  patch('applyEdit(insertText(valueRef.current, cursorRef.current, text));\n\t\t}\n\t}, true);', 'applyEdit(insertText(valueRef.current, cursorRef.current, collapseLargePaste(text, valueRef.current, pendingPastesRef.current)));\n\t\t}\n\t}, true);');
  return '// dscode-large-paste-v1\n' + [collapseLargePaste, expandLargePastes, pasteAtomicEdit, pasteCursorEdge].map(fn => fn.toString()).join('\n') + `\nconst LARGE_PASTE_CHARS = ${LARGE_PASTE_CHARS};\n` + replaceOnce(text, original, input);
}
