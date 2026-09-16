import { replaceOnce, replaceOrAdopt } from './patch-util.mjs';
import { catalogAnchor } from './patch-command-catalog.mjs';

// Chat rendering: quiet by default; /verbose (or Ctrl/Alt+R) shows thinking and tool calls in dim text.
export const CHAT_LINES_SOURCE = `function dscodeChatLines(entry, columns, verbose = false) {
  const width = Math.max(1, Math.floor(columns));
  if (entry.kind === "tool") {
    if (!verbose) return [];
    const state = entry.state === "running" ? " · running" : entry.state === "error" ? " · error" : "";
    const lines = hangingStyledLines([lineSegment("Tool Call: " + entry.name, "dim"), lineSegment(entry.preview ? " " + entry.preview : "", "dim"), lineSegment(state, entry.state === "error" ? "error" : "dim")], width, "· ", "dim", "  ", "dim");
    if (entry.summary) lines.push(...hangingTextLines("Output: " + entry.summary, width, "  ", entry.state === "error" ? "error" : "dim", "    "));
    lines.push({ segments: [] });
    return lines;
  }
  if (entry.kind === "assistant") {
    const thinking = verbose && entry.reasoning ? [...dscodeThinkingLines(entry.reasoning, width), { segments: [] }] : [];
    if (!entry.text && !entry.interrupted) return thinking;
    return [...thinking, ...transcriptEntryLines({ ...entry, reasoning: "" }, columns, false, false, false)];
  }
  const rows = transcriptEntryLines(entry, columns, false, false, false);
  return entry.kind === "user" && !entry.notice ? [...userBackgroundRows(rows, columns, visibleColumns), { segments: [] }] : rows;
}
function dscodeThinkingLines(reasoning, width) {
  const lines = hangingTextLines("Thinking: " + reasoning.replace(/\\s+/g, " ").trim(), width, "· ", "dimItalic", "  ");
  const cap = 8;
  return lines.length <= cap ? lines : [...lines.slice(0, cap), ...textLines("  … " + (lines.length - cap) + " more lines · Ctrl+O opens the full history", width, "dim")];
}
`;
const CATALOG_ANCHOR = '\t{\n\t\tlabel: "/todos",\n\t\tdescriptionKey: "cmd.todos"\n\t},\n';
const CATALOG_ENTRY = catalogAnchor('verbose');
const DISPATCH_ANCHOR = '\t\t\tif (text === "/todos") {\n\t\t\t\topenTodos();';
const DISPATCH_ENTRY = '\t\t\tif (text === "/verbose") {\n\t\t\t\ttoggleReasoning();\n\t\t\t\treturn;\n\t\t\t}\n';
const TOGGLE_V1 = '\t\ttoggleReasoning: () => {\n\t\t\tsetShowReasoning((current) => !current);\n\t\t\trefreshScreen();\n\t\t},';
const TOGGLE_V2 = '\t\ttoggleReasoning: () => {\n\t\t\tconst next = !showReasoning;\n\t\t\tsetShowReasoning(next);\n\t\t\tnotify(next ? "verbose on: thinking and tool calls are shown in the chat" : "verbose off");\n\t\t\trefreshScreen();\n\t\t},';
const TOGGLE_V3 = '\t\ttoggleReasoning: () => {\n\t\t\tconst next = !showReasoning;\n\t\t\tsetShowReasoning(next);\n\t\t\tnotify(dscodeT(next ? "verbose.on" : "verbose.off"));\n\t\t\trefreshScreen();\n\t\t},';
const TOGGLE_V4 = '\t\ttoggleReasoning: () => {\n\t\t\tconst next = !showReasoning;\n\t\t\tsetShowReasoning(next);\n\t\t\tdscodeSaveFlag("verbose", next);\n\t\t\tnotify(dscodeT(next ? "verbose.on" : "verbose.off"));\n\t\t\trefreshScreen();\n\t\t},';
const VERBOSE_STATE_V1 = '\tconst [showReasoning, setShowReasoning] = (0, import_react.useState)(false);';
const VERBOSE_STATE_V2 = '\tconst [showReasoning, setShowReasoning] = (0, import_react.useState)(() => dscodeLoadFlag("verbose"));';

/** Upgrade an already-patched bundle to the verbose chat rendering; safe to apply repeatedly. */
/** Persisted verbose state and the latest toggle body; plain swaps keep every generation idempotent. */
function withVerbosePersistence(text) {
  text = text.replace(TOGGLE_V2, TOGGLE_V4).replace(TOGGLE_V3, TOGGLE_V4).replace(VERBOSE_STATE_V1, VERBOSE_STATE_V2);
  if (!text.includes(VERBOSE_STATE_V2) || !text.includes(TOGGLE_V4)) throw Error('Pinned TUI verbose state drift');
  return text;
}

function withCurrentChatLines(text) {
  const start = text.indexOf('function dscodeChatLines(');
  const endMarker = text.includes('function dscodeThinkingLines(') ? text.indexOf('\n}\n', text.indexOf('function dscodeThinkingLines(')) + 3 : text.indexOf('\n}\n', start) + 3;
  if (start < 0 || endMarker <= start) throw Error('Patched TUI chat lines drift');
  const current = text.slice(start, endMarker);
  return current === CHAT_LINES_SOURCE ? text : text.slice(0, start) + CHAT_LINES_SOURCE + text.slice(endMarker);
}

function patchVerbose(text) {
  if (text.includes('// dscode-interaction-v2')) return withVerbosePersistence(withCurrentChatLines(text));
  text = withCurrentChatLines(text);
  text = text.split('dscodeChatLines(entry, columns);').join('dscodeChatLines(entry, columns, showReasoning);');
  text = text.split('dscodeChatLines(entry, Math.max(1, terminalColumns - 2))').join('dscodeChatLines(entry, Math.max(1, terminalColumns - 2), showReasoning)');
  // The DSCODE catalog carries the /verbose row in the 1.2.0 generation.
  if (!text.includes(catalogAnchor('verbose'))) text = replaceOnce(text, CATALOG_ANCHOR, CATALOG_ANCHOR + CATALOG_ENTRY);
  text = replaceOnce(text, DISPATCH_ANCHOR, DISPATCH_ENTRY + DISPATCH_ANCHOR);
  text = replaceOnce(text, TOGGLE_V1, TOGGLE_V4);
  return withVerbosePersistence('// dscode-interaction-v2\n' + text);
}

// The live reasoning tail returns to verbose runs: upstream keeps rows for it,
// DSCODE used to zero them. The tail takes the live stream budget while the model
// is still thinking and gives way to the answer as soon as text arrives.
const LIVE_STREAMING_ACTIVE = 'const streamingActive = view.streaming !== "" || showReasoning && view.streamingReasoning !== "";';
const LIVE_REASONING_ROWS = 'const reasoningRows = !showReasoning || view.streamingReasoning === "" || view.streaming !== "" ? 0 : streamRows;';
const ZEROED_STREAMING_ACTIVE = 'const streamingActive = view.streaming !== "";';
const ZEROED_REASONING_ROWS = 'const reasoningRows = 0;';
/** Upgrade a bundle patched by an earlier DSCODE to the live reasoning tail. */
export function withLiveReasoning(text) {
  return text.replace(ZEROED_STREAMING_ACTIVE, LIVE_STREAMING_ACTIVE).replace(ZEROED_REASONING_ROWS, LIVE_REASONING_ROWS);
}
export function patchInteraction(text) {
  if (text.includes('// dscode-interaction-v1')) return patchVerbose(withLiveReasoning(text.replace('runSlash("/shell " + line.slice(1))', 'runSlash("/shell-exec " + line.slice(1))')));
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  // 1.2.0 decodes Shift+Enter to a newline itself; older bundles need the rewrite.
  text = replaceOrAdopt(text, 'if (ctrl) return "\\n";\n\t\tif (alt)', 'if (ctrl || shift) return "\\n";\n\t\tif (alt)', 'if (ctrl || shift) return "\\n";\n\t\tif (alt) return "\\x1B\\r";');
  patch('function normalizeKeyboardChunk(chunk) {', 'function normalizeKeyboardChunk(chunk) {\n\tchunk = chunk.replace(/\\x1b\\[27;2;13~/g, "\\n");');
  patch('if (key.return) {\n\t\t\tif (pasteBracketRef.current)', 'if (input === "\\n" || key.ctrl && input === "j" || key.return && key.shift) {\n\t\t\tapplyEdit(insertText(liveValue, liveCursor, "\\n"));\n\t\t\treturn;\n\t\t}\n\t\tif (key.return) {\n\t\t\tif (pasteBracketRef.current)');
  // 1.2.0 gave submission an explicit mode that starts at `queue`; DSCODE keeps the older
  // contract where a running turn is steered and an idle one just sends ("a running driver
  // consumes it at its next step boundary, an idle one starts a turn with it"), so Tab opts
  // into queueing instead of the other way round.
  patch('const [submitMode, setSubmitMode] = (0, import_react.useState)("queue");',
    'const [submitMode, setSubmitMode] = (0, import_react.useState)("steer");');
  patch('const currentMentions = mentions;\n\t\tif (images.length', 'const currentMentions = mentions;\n\t\tif (images.length === 0 && line.startsWith("!")) {\n\t\t\trunSlash("/shell-exec " + line.slice(1));\n\t\t\treturn;\n\t\t}\n\t\tif (images.length');
  patch('await sessions.flush(currentSession);\n\t\t\t\t}', 'await sessions.flush(currentSession);\n\t\t\t\t\tinternals.stderr.write("\\nResume this session: dscode resume " + currentSession.id + "\\n");\n\t\t\t\t}');
  // Keep the raw projection intact for export and the explicit history inspector.
  patch('function settledEntryLines(entry, columns, showReasoning) {\n\treturn transcriptEntryLines(entry, columns, showReasoning, false, showReasoning);', 'function settledEntryLines(entry, columns, showReasoning) {\n\treturn dscodeChatLines(entry, columns);');
  patch('transcriptEntryLines(entry, Math.max(1, terminalColumns - 2), showReasoning)', 'dscodeChatLines(entry, Math.max(1, terminalColumns - 2))');
  patch('const streamingActive = view.streaming !== "" || view.streamingReasoning !== "";', LIVE_STREAMING_ACTIVE);
  const reasoning = text.match(/const reasoningRows = [^\n]+;/)?.[0];
  if (!reasoning) throw Error('Missing reasoning allocation');
  patch(reasoning, LIVE_REASONING_ROWS);
  patch('text: "✻ Thinking… (Ctrl/Alt+R to expand)"', 'text: "Working…"');
  patch('transcriptVisible ? (0, import_react.createElement)(TodoPanel, { todos: view.todos }) : void 0', 'transcriptVisible && busy ? (0, import_react.createElement)(Text, { dimColor: true, wrap: "truncate-end" }, view.entries.filter(entry => entry.kind === "tool" && entry.state === "running").map(entry => "● " + entry.name).join(" · ")) : void 0');
  return patchVerbose('// dscode-interaction-v1\nfunction dscodeChatLines(entry, columns) {\n  if (entry.kind === "tool") return [];\n}\n' + text);
}
