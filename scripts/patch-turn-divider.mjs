import { replaceOnce } from './patch-runtime.mjs';

// The native-scrollback transcript renders each settled entry exactly once, so a
// finished turn appends its own rule and breathing rows instead of competing for
// a bounded viewport budget.
export function turnDividedLines(entry, columns, rendered) {
  if (entry?.turnEnded !== true) return rendered;
  // Full terminal width: the row renders with truncate-end, so it can never wrap.
  return [...rendered, { segments: [] }, { segments: [{ text: '─'.repeat(Math.max(1, columns)), style: 'dim' }] }, { segments: [] }];
}

const SETTLED_ENTRY = 'function settledEntryLines(entry, columns, showReasoning) {\n\treturn dscodeChatLines(entry, columns, showReasoning);\n}';

export function patchTurnDivider(text) {
  if (text.includes('// dscode-turn-divider-v2')) return text;
  return '// dscode-turn-divider-v2\n' + turnDividedLines.toString() + '\n' + replaceOnce(text, SETTLED_ENTRY, 'function settledEntryLines(entry, columns, showReasoning) {\n\treturn turnDividedLines(entry, columns, dscodeChatLines(entry, columns, showReasoning));\n}');
}
