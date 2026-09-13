import { replaceOnce } from './patch-runtime.mjs';

// The upstream Static transcript owns terminal scrollback. A fixed composer
// needs one bounded, live viewport instead, while the session store keeps the
// complete transcript for Ctrl+O and /export.
export function visibleSettledLines(entries, settled, budget, columns, showReasoning, renderEntry) {
  if (budget <= 0) return [];
  const chunks = [];
  let remaining = budget;
  for (let index = settled - 1; index >= 0 && remaining > 0; index--) {
    const lines = renderEntry(entries[index], Math.max(10, columns - 2), showReasoning);
    const kept = lines.slice(-remaining);
    if (kept.length) {
      chunks.unshift(kept);
      remaining -= kept.length;
    }
  }
  return chunks.flat();
}

export function patchViewport(text) {
  if (text.includes('// dscode-viewport-v1')) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  const cacheStart = text.indexOf('\tconst settledRowsCache = (0, import_react.useRef)(void 0);');
  const cacheEnd = text.indexOf('\tconst synchronizedReplayPending =', cacheStart);
  if (cacheStart < 0 || cacheEnd < 0) throw Error('Pinned TUI viewport cache drift');
  text = text.slice(0, cacheStart) + text.slice(cacheEnd);
  const trimStart = text.indexOf('\tconst settledNeedsTrim = settledRowsCache.current?.needsTrim === true;');
  const trimEnd = text.indexOf('\tconst sessionHasImages =', trimStart);
  if (trimStart < 0 || trimEnd < 0) throw Error('Pinned TUI viewport trim drift');
  text = text.slice(0, trimStart) + text.slice(trimEnd);
  patch('const transcriptVisible = !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !jobsOpen && !statuslineOpen && !themeOpen && !historyOpen && !agentsOpen && !subagentOpen && !todosOpen && !verboseOpen && diffView === void 0 && !approvalPending && !questionPending;', '');
  patch('const MENU_RESERVE_ROWS = 5;', 'const transcriptVisible = !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !jobsOpen && !statuslineOpen && !themeOpen && !historyOpen && !agentsOpen && !subagentOpen && !todosOpen && !verboseOpen && diffView === void 0 && !approvalPending && !questionPending;');
  patch('const dynamicRows = Math.max(1, terminalRows - 8 - MENU_RESERVE_ROWS - composerGutterRows - (composerRows - 1) - Math.max(0, menuRows - MENU_RESERVE_ROWS));', `const settledBudget = transcriptVisible ? Math.max(0, terminalRows - 12 - composerGutterRows - (composerRows - 1) - menuRows) : 0;
  const settledViewportRows = busy || view.streaming !== "" ? Math.floor(settledBudget / 3) : settledBudget;
  const renderedSettled = (0, import_react.useMemo)(() => visibleSettledLines(view.entries, settled, settledViewportRows, terminalColumns, showReasoning, settledEntryLines), [settled, view.entries[settled - 1], settledViewportRows, terminalColumns, showReasoning]);
  const dynamicRows = Math.max(0, settledBudget - settledViewportRows);`);
  patch('const liveBudget = busy || streamingActive ? Math.max(1, Math.floor(dynamicRows / 3)) : Math.max(0, dynamicRows - (deepDivingVisible ? 1 : 0));', 'const liveBudget = dynamicRows === 0 ? 0 : busy || streamingActive ? Math.max(1, Math.floor(dynamicRows / 3)) : Math.max(0, dynamicRows - (deepDivingVisible ? 1 : 0));');
  patch('const answerRows = view.streaming === "" ? 0 : Math.max(1, streamRows - reasoningRows);', 'const answerRows = view.streaming === "" || dynamicRows === 0 ? 0 : Math.max(1, streamRows - reasoningRows);');
  patch('return (0, import_react.createElement)(Box, { flexDirection: "column" }, (0, import_react.createElement)(MemoStaticTranscript, {\n\t\tkey: refreshEpoch,\n\t\titems: settledRows\n\t}), transcriptVisible ?', `return (0, import_react.createElement)(Box, { flexDirection: "column", height: Math.max(1, terminalRows - 1) },
    terminalRows >= 10 ? (0, import_react.createElement)(Header, { resumed: props.resumed, cwd: props.cwd, branch: props.branch, title: view.title }) : (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright), bold: true }, "DSCODE"),
    transcriptVisible && settledViewportRows > 0 ? (0, import_react.createElement)(StyledRows, { lines: renderedSettled }) : void 0,
    transcriptVisible ?`);
  patch('}) : void 0, notice === void 0 ? void 0 : (0, import_react.createElement)(NoticeLine, {', '}) : void 0, (0, import_react.createElement)(Box, { flexGrow: 1 }), notice === void 0 ? void 0 : (0, import_react.createElement)(NoticeLine, {');
  patch('process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_ENABLE : "") + BRACKETED_PASTE_ENABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_ENABLE : ""));', `if (process.stdout.isTTY === true) process.stdout.write("\\x1B[r\\x1B[0m\\x1B[H\\x1B[2J\\x1B[3J\\x1B[H");
      process.stdout.write((keyboardEnhanced ? KEYBOARD_ENHANCE_ENABLE : "") + BRACKETED_PASTE_ENABLE + (focusReporting ? TERMINAL_FOCUS_REPORT_ENABLE : ""));`);
  return '// dscode-viewport-v1\n' + visibleSettledLines.toString() + '\n' + text;
}
