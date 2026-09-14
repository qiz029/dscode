import { replaceOnce } from './patch-runtime.mjs';

export function transcriptWindow(lines, rows, offset) {
  if (rows <= 0) return [];
  const end = Math.max(0, lines.length - Math.max(0, offset));
  return lines.slice(Math.max(0, end - rows), end);
}

export function mouseWheelDirection(unit) {
  const match = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(unit);
  if (!match) return null;
  if (match[2] !== 'M') return 0;
  const button = Number(match[1]) & ~(4 | 8 | 16);
  return button === 64 ? 1 : button === 65 ? -1 : 0;
}

const MOUSE_TOGGLE_SOURCE = `let dscodeMouseEnabled = true;
function dscodeSetMouse(enabled) {
  dscodeMouseEnabled = enabled;
  if (process.stdout.isTTY === true) process.stdout.write(enabled ? DSCODE_MOUSE_ENABLE : DSCODE_MOUSE_DISABLE);
  return enabled;
}
`;
const MOUSE_CATALOG_ANCHOR = '\t{\n\t\tlabel: "/verbose",\n\t\tdescription: "toggle thinking and tool call details in the chat"\n\t},\n';
const MOUSE_CATALOG_ENTRY = '\t{\n\t\tlabel: "/mouse",\n\t\tdescription: "toggle mouse capture: off to select and copy text, on for wheel scrolling"\n\t},\n';
const MOUSE_DISPATCH_ANCHOR = '\t\t\tif (text === "/todos") {\n\t\t\t\topenTodos();';
const MOUSE_DISPATCH_ENTRY = '\t\t\tif (text === "/mouse") {\n\t\t\t\tnotify(dscodeSetMouse(!dscodeMouseEnabled) ? "mouse on: the wheel scrolls the chat · hold Option (iTerm2) or Fn (Terminal) while dragging to select text" : "mouse off: select and copy freely · PageUp/PageDown scroll the chat · /mouse turns capture back on");\n\t\t\t\treturn;\n\t\t\t}\n';

/** /mouse releases the terminal mouse so text can be selected and copied; safe to apply repeatedly. */
function patchMouseToggle(text) {
  if (text.includes('// dscode-scroll-v2')) return text;
  text = replaceOnce(text, 'const dscodeWheelListeners = new Set();\n', 'const dscodeWheelListeners = new Set();\n' + MOUSE_TOGGLE_SOURCE);
  text = replaceOnce(text, MOUSE_CATALOG_ANCHOR, MOUSE_CATALOG_ANCHOR + MOUSE_CATALOG_ENTRY);
  text = replaceOnce(text, MOUSE_DISPATCH_ANCHOR, MOUSE_DISPATCH_ENTRY + MOUSE_DISPATCH_ANCHOR);
  return '// dscode-scroll-v2\n' + text;
}

export function patchScroll(text) {
  const oldCatch = 'if (process.stdin.isTTY === true) process.stdin.setRawMode?.(false);\n\t\t\tthrow error;';
  const safeCatch = 'if (process.stdout.isTTY === true) process.stdout.write(DSCODE_MOUSE_DISABLE);\n\t\t\tif (process.stdin.isTTY === true) process.stdin.setRawMode?.(false);\n\t\t\tthrow error;';
  if (text.includes('// dscode-scroll-v1')) return patchMouseToggle(text.includes(safeCatch) ? text : replaceOnce(text, oldCatch, safeCatch));
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  patch('onEditorRows, onMenuRows, sessionKey }) {', 'onEditorRows, onMenuRows, onTranscriptScroll, sessionKey }) {');
  patch('ctrlCArmedRef.current = false;\n        if (preparingImages)', 'ctrlCArmedRef.current = false;\n        if (key.pageUp || key.pageDown) { onTranscriptScroll?.(key.pageUp ? 1 : -1, true); return; }\n        if (preparingImages)');
  patch('const settledTail = (0, import_react.useMemo)(() => visibleSettledLines(view.entries, settled, transcriptCapacity, terminalColumns, showReasoning, settledEntryLines), [settled, view.entries[settled - 1], transcriptCapacity, terminalColumns, showReasoning]);', `const allSettledLines = (0, import_react.useMemo)(() => visibleSettledLines(view.entries, settled, Infinity, terminalColumns, showReasoning, settledEntryLines), [settled, view.entries[settled - 1], terminalColumns, showReasoning]);
  const settledTail = allSettledLines.slice(-transcriptCapacity);`);
  patch('const renderedSettled = settledViewportRows > 0 ? settledTail.slice(-settledViewportRows) : [];', `const [scrollOffset, setScrollOffset] = (0, import_react.useState)(0);
  const previousHistory = (0, import_react.useRef)({ sessionKey: props.sessionKey, count: allSettledLines.length });
  const sameHistory = previousHistory.current.sessionKey === props.sessionKey;
  const growth = sameHistory ? Math.max(0, allSettledLines.length - previousHistory.current.count) : 0;
  const maxScrollOffset = Math.max(0, allSettledLines.length - settledViewportRows);
  const effectiveScrollOffset = sameHistory ? Math.min(maxScrollOffset, scrollOffset === 0 ? 0 : scrollOffset + growth) : 0;
  (0, import_react.useEffect)(() => {
    previousHistory.current = { sessionKey: props.sessionKey, count: allSettledLines.length };
    if (scrollOffset !== effectiveScrollOffset) setScrollOffset(effectiveScrollOffset);
  }, [props.sessionKey, allSettledLines.length, effectiveScrollOffset]);
  const scrollTranscript = (direction, page = false) => {
    if (!transcriptVisible || settledViewportRows <= 0) return;
    const step = page ? Math.max(1, settledViewportRows - 1) : 3;
    setScrollOffset(current => Math.max(0, Math.min(maxScrollOffset, (current === scrollOffset ? effectiveScrollOffset : current) + direction * step)));
  };
  (0, import_react.useEffect)(() => {
    const listener = direction => scrollTranscript(direction);
    dscodeWheelListeners.add(listener);
    return () => dscodeWheelListeners.delete(listener);
  });
  const renderedSettled = transcriptWindow(allSettledLines, settledViewportRows, effectiveScrollOffset);`);
  patch('onMenuRows: handleMenuRows\n', 'onMenuRows: handleMenuRows,\n        onTranscriptScroll: scrollTranscript\n');
  patch('for (const unit of splitter.push(String(chunk))) stream.write(unit);', 'for (const unit of splitter.push(String(chunk))) if (!dscodeHandleMouseUnit(unit)) stream.write(unit);');
  patch('process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_ENABLE : "") + BRACKETED_PASTE_ENABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_ENABLE : ""));', 'process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_ENABLE : "") + BRACKETED_PASTE_ENABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_ENABLE : "") + (process.stdout.isTTY === true ? DSCODE_MOUSE_ENABLE : ""));');
  patch('process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_DISABLE : "") + BRACKETED_PASTE_DISABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_DISABLE : ""));', 'process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_DISABLE : "") + BRACKETED_PASTE_DISABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_DISABLE : "") + (process.stdout.isTTY === true ? DSCODE_MOUSE_DISABLE : ""));');
  patch(oldCatch, safeCatch);
  return patchMouseToggle(`// dscode-scroll-v1
${transcriptWindow.toString()}
${mouseWheelDirection.toString()}
const DSCODE_MOUSE_ENABLE = "\\x1b[?1000h\\x1b[?1006h";
const DSCODE_MOUSE_DISABLE = "\\x1b[?1006l\\x1b[?1000l";
const dscodeWheelListeners = new Set();
function dscodeHandleMouseUnit(unit) {
  const direction = mouseWheelDirection(unit);
  if (direction === null) return false;
  if (direction !== 0) for (const listener of dscodeWheelListeners) listener(direction);
  return true;
}
` + text);
}
