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

const MARKER = '// dscode-scroll-v3\n';

// The wheel scrolls by default so it works without any setup; /mouse releases capture when the terminal's own selection is wanted, and the choice is remembered per machine.
const MOUSE_STATE_V1 = 'let dscodeMouseEnabled = true;\n';
const MOUSE_STATE_V2 = 'let dscodeMouseEnabled = dscodeLoadFlag("mouse", false);\n';
const MOUSE_STATE_V3 = 'let dscodeMouseEnabled = dscodeLoadFlag("mouse", true);\n';
const MOUSE_ENABLE_V1 = '(process.stdout.isTTY === true ? DSCODE_MOUSE_ENABLE : "")';
const MOUSE_ENABLE_V2 = '(process.stdout.isTTY === true && dscodeMouseEnabled ? DSCODE_MOUSE_ENABLE : "")';
const MOUSE_TOGGLE_SOURCE = `${MOUSE_STATE_V3}function dscodeSetMouse(enabled) {
  dscodeMouseEnabled = enabled;
  if (process.stdout.isTTY === true) process.stdout.write(enabled ? DSCODE_MOUSE_ENABLE : DSCODE_MOUSE_DISABLE);
  return enabled;
}
`;
const MOUSE_CATALOG_ANCHOR = '\t{\n\t\tlabel: "/verbose",\n\t\tdescription: "toggle thinking and tool call details in the chat"\n\t},\n';
const MOUSE_CATALOG_ENTRY = '\t{\n\t\tlabel: "/mouse",\n\t\tdescription: "toggle mouse capture: off to select and copy text, on for wheel scrolling"\n\t},\n';
const MOUSE_DISPATCH_ANCHOR = '\t\t\tif (text === "/todos") {\n\t\t\t\topenTodos();';
const MOUSE_DISPATCH_V2 = '\t\t\tif (text === "/mouse") {\n\t\t\t\tnotify(dscodeSetMouse(!dscodeMouseEnabled) ? "mouse on: the wheel scrolls the chat · hold Option (iTerm2) or Fn (Terminal) while dragging to select text" : "mouse off: select and copy freely · PageUp/PageDown scroll the chat · /mouse turns capture back on");\n\t\t\t\treturn;\n\t\t\t}\n';
const MOUSE_DISPATCH_V3 = '\t\t\tif (text === "/mouse") {\n\t\t\t\tnotify(dscodeT(dscodeSetMouse(!dscodeMouseEnabled) ? "mouse.on" : "mouse.off"));\n\t\t\t\treturn;\n\t\t\t}\n';
const MOUSE_DISPATCH_ENTRY = '\t\t\tif (text === "/mouse") {\n\t\t\t\tconst enabled = dscodeSetMouse(!dscodeMouseEnabled);\n\t\t\t\tdscodeSaveFlag("mouse", enabled);\n\t\t\t\tnotify(dscodeT(enabled ? "mouse.on" : "mouse.off"));\n\t\t\t\treturn;\n\t\t\t}\n';

// v1 and v2 notified every wheel unit on its own, so one trackpad flick queued a render per unit. v3 merges the units that land in the same frame.
const WHEEL_FRAME = 'const DSCODE_WHEEL_FRAME_MS = 16;\n';
const WHEEL_SET = 'const dscodeWheelListeners = new Set();\n';
const WHEEL_QUEUE = `let dscodeWheelPending = 0;
let dscodeWheelTimer = void 0;
function dscodeQueueWheel(direction) {
  dscodeWheelPending += direction;
  if (dscodeWheelTimer !== void 0) return;
  dscodeWheelTimer = setTimeout(() => {
    dscodeWheelTimer = void 0;
    const delta = dscodeWheelPending;
    dscodeWheelPending = 0;
    if (delta !== 0) for (const listener of dscodeWheelListeners) listener(delta);
  }, DSCODE_WHEEL_FRAME_MS);
}
`;
const WHEEL_NOTIFY_V1 = '  if (direction !== 0) for (const listener of dscodeWheelListeners) listener(direction);\n';
const WHEEL_NOTIFY = '  if (direction !== 0) dscodeQueueWheel(direction);\n';
const WHEEL_HELPERS = WHEEL_FRAME + WHEEL_SET + WHEEL_QUEUE + `function dscodeHandleMouseUnit(unit) {
  const direction = mouseWheelDirection(unit);
  if (direction === null) return false;
${WHEEL_NOTIFY}  return true;
}
`;
const SCROLL_STEP_V2 = `    const step = page ? Math.max(1, settledViewportRows - 1) : 3;
    setScrollOffset(current => Math.max(0, Math.min(maxScrollOffset, (current === scrollOffset ? effectiveScrollOffset : current) + direction * step)));`;
const SCROLL_STEP = `    const step = page ? Math.max(1, settledViewportRows - 1) : 1;
    const amount = direction * step;
    if (amount === 0) return;
    setScrollOffset(current => Math.max(0, Math.min(maxScrollOffset, (current === scrollOffset ? effectiveScrollOffset : current) + amount)));`;
const SCROLL_LISTENER_V2 = `  (0, import_react.useEffect)(() => {
    const listener = direction => scrollTranscript(direction);
    dscodeWheelListeners.add(listener);
    return () => dscodeWheelListeners.delete(listener);
  });`;
const SCROLL_LISTENER = `  const scrollRef = (0, import_react.useRef)(scrollTranscript);
  scrollRef.current = scrollTranscript;
  (0, import_react.useEffect)(() => {
    const listener = delta => scrollRef.current(delta);
    dscodeWheelListeners.add(listener);
    return () => dscodeWheelListeners.delete(listener);
  }, []);`;

/** /mouse toggles capture; the flag and the enable sequence are upgraded in place so already-patched bundles pick up the new default. */
function withMouseDefaults(text) {
  text = text.replace(MOUSE_DISPATCH_V2, MOUSE_DISPATCH_ENTRY).replace(MOUSE_DISPATCH_V3, MOUSE_DISPATCH_ENTRY).replace(MOUSE_STATE_V1, MOUSE_STATE_V3).replace(MOUSE_STATE_V2, MOUSE_STATE_V3).split(MOUSE_ENABLE_V1).join(MOUSE_ENABLE_V2);
  if (!text.includes(MOUSE_STATE_V3) || !text.includes(MOUSE_ENABLE_V2) || !text.includes(MOUSE_DISPATCH_ENTRY)) throw Error('Pinned TUI mouse toggle drift');
  return text;
}

function insertMouseToggle(text) {
  text = replaceOnce(text, WHEEL_HELPERS, WHEEL_HELPERS + MOUSE_TOGGLE_SOURCE);
  text = replaceOnce(text, MOUSE_CATALOG_ANCHOR, MOUSE_CATALOG_ANCHOR + MOUSE_CATALOG_ENTRY);
  text = replaceOnce(text, MOUSE_DISPATCH_ANCHOR, MOUSE_DISPATCH_ENTRY + MOUSE_DISPATCH_ANCHOR);
  return text;
}

function upgradeWheel(text) {
  text = replaceOnce(text, WHEEL_SET, WHEEL_FRAME + WHEEL_SET + WHEEL_QUEUE);
  text = replaceOnce(text, WHEEL_NOTIFY_V1, WHEEL_NOTIFY);
  text = replaceOnce(text, SCROLL_STEP_V2, SCROLL_STEP);
  return replaceOnce(text, SCROLL_LISTENER_V2, SCROLL_LISTENER);
}

export function patchScroll(text) {
  const oldCatch = 'if (process.stdin.isTTY === true) process.stdin.setRawMode?.(false);\n\t\t\tthrow error;';
  const safeCatch = 'if (process.stdout.isTTY === true) process.stdout.write(DSCODE_MOUSE_DISABLE);\n\t\t\tif (process.stdin.isTTY === true) process.stdin.setRawMode?.(false);\n\t\t\tthrow error;';
  if (text.includes(MARKER)) return text;
  if (text.includes('// dscode-scroll-v2')) {
    const upgraded = withMouseDefaults(upgradeWheel(text));
    return replaceOnce(upgraded, '// dscode-scroll-v2\n', MARKER);
  }
  if (text.includes('// dscode-scroll-v1')) {
    const upgraded = withMouseDefaults(insertMouseToggle(upgradeWheel(text.includes(safeCatch) ? text : replaceOnce(text, oldCatch, safeCatch))));
    return replaceOnce(upgraded, '// dscode-scroll-v1\n', MARKER);
  }
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
${SCROLL_STEP}
  };
${SCROLL_LISTENER}
  const renderedSettled = transcriptWindow(allSettledLines, settledViewportRows, effectiveScrollOffset);`);
  patch('onMenuRows: handleMenuRows\n', 'onMenuRows: handleMenuRows,\n        onTranscriptScroll: scrollTranscript\n');
  patch('for (const unit of splitter.push(String(chunk))) stream.write(unit);', 'for (const unit of splitter.push(String(chunk))) if (!dscodeHandleMouseUnit(unit)) stream.write(unit);');
  patch('process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_ENABLE : "") + BRACKETED_PASTE_ENABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_ENABLE : ""));', 'process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_ENABLE : "") + BRACKETED_PASTE_ENABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_ENABLE : "") + (process.stdout.isTTY === true ? DSCODE_MOUSE_ENABLE : ""));');
  patch('process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_DISABLE : "") + BRACKETED_PASTE_DISABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_DISABLE : ""));', 'process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_DISABLE : "") + BRACKETED_PASTE_DISABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_DISABLE : "") + (process.stdout.isTTY === true ? DSCODE_MOUSE_DISABLE : ""));');
  patch(oldCatch, safeCatch);
  const injected = `${transcriptWindow.toString()}
${mouseWheelDirection.toString()}
const DSCODE_MOUSE_ENABLE = "\\x1b[?1000h\\x1b[?1006h";
const DSCODE_MOUSE_DISABLE = "\\x1b[?1006l\\x1b[?1000l";
${WHEEL_HELPERS}`;
  return withMouseDefaults(insertMouseToggle(MARKER + injected + text));
}
