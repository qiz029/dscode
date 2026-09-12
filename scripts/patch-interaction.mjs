import { replaceOnce } from './patch-runtime.mjs';

export function patchInteraction(text) {
  if (text.includes('// dscode-interaction-v1')) return text.replace('runSlash("/shell " + line.slice(1))', 'runSlash("/shell-exec " + line.slice(1))');
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  patch('if (ctrl) return "\\n";\n\t\tif (alt)', 'if (ctrl || shift) return "\\n";\n\t\tif (alt)');
  patch('function normalizeKeyboardChunk(chunk) {', 'function normalizeKeyboardChunk(chunk) {\n\tchunk = chunk.replace(/\\x1b\\[27;2;13~/g, "\\n");');
  patch('if (key.return) {\n\t\t\tif (pasteBracketRef.current)', 'if (input === "\\n" || key.ctrl && input === "j" || key.return && key.shift) {\n\t\t\tapplyEdit(insertText(liveValue, liveCursor, "\\n"));\n\t\t\treturn;\n\t\t}\n\t\tif (key.return) {\n\t\t\tif (pasteBracketRef.current)');
  patch('const currentMentions = mentions;\n\t\tif (images.length', 'const currentMentions = mentions;\n\t\tif (images.length === 0 && line.startsWith("!")) {\n\t\t\trunSlash("/shell-exec " + line.slice(1));\n\t\t\treturn;\n\t\t}\n\t\tif (images.length');
  patch('await sessions.flush(currentSession);\n\t\t\t\t}', 'await sessions.flush(currentSession);\n\t\t\t\t\tinternals.stderr.write("\\nResume this session: dscode resume " + currentSession.id + "\\n");\n\t\t\t\t}');
  // Keep the raw projection intact for export and the explicit history inspector.
  patch('function settledEntryLines(entry, columns, showReasoning) {\n\treturn transcriptEntryLines(entry, columns, showReasoning, false, showReasoning);', 'function settledEntryLines(entry, columns, showReasoning) {\n\treturn dscodeChatLines(entry, columns);');
  patch('transcriptEntryLines(entry, Math.max(1, terminalColumns - 2), showReasoning)', 'dscodeChatLines(entry, Math.max(1, terminalColumns - 2))');
  patch('const streamingActive = view.streaming !== "" || view.streamingReasoning !== "";', 'const streamingActive = view.streaming !== "";');
  const reasoning = text.match(/const reasoningRows = [^\n]+;/)?.[0];
  if (!reasoning) throw Error('Missing reasoning allocation');
  patch(reasoning, 'const reasoningRows = 0;');
  patch('text: "✻ Thinking… (Ctrl/Alt+R to expand)"', 'text: "Working…"');
  patch('transcriptVisible ? (0, import_react.createElement)(TodoPanel, { todos: view.todos }) : void 0', 'transcriptVisible && busy ? (0, import_react.createElement)(Text, { dimColor: true, wrap: "truncate-end" }, view.entries.filter(entry => entry.kind === "tool" && entry.state === "running").map(entry => "● " + entry.name).join(" · ")) : void 0');
  return '// dscode-interaction-v1\nfunction dscodeChatLines(entry, columns) {\n  if (entry.kind === "tool") return [];\n  if (entry.kind === "assistant") {\n    if (!entry.text && !entry.interrupted) return [];\n    entry = { ...entry, reasoning: "" };\n  }\n  return transcriptEntryLines(entry, columns, false, false, false);\n}\n' + text;
}
