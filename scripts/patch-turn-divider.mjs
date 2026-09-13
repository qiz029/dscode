import { replaceOnce } from './patch-runtime.mjs';

// Keep the separator in the transcript line list so viewport clipping and
// scroll offsets count it exactly like any other visible row.
export function turnDividedLines(entry, columns, rendered, remaining) {
  if (entry?.turnEnded !== true || (rendered.length > 0 && rendered.length >= remaining)) return rendered;
  const width = Math.max(1, Math.min(72, columns - 6));
  return [...rendered, { segments: [{ text: `  ${'─'.repeat(width)}`, style: 'dim' }] }];
}

export function patchTurnDivider(text) {
  if (text.includes('// dscode-turn-divider-v1')) return text;
  text = replaceOnce(text,
    'const lines = renderEntry(entries[index], Math.max(10, columns - 2), showReasoning);',
    'const lines = turnDividedLines(entries[index], columns, renderEntry(entries[index], Math.max(10, columns - 2), showReasoning), remaining);');
  text = replaceOnce(text,
    'for (const entry of appended) appendReplayEntry(acc, entry);\n\t\t\treturn true;\n\t\t}\n\t\tcase "llm/retry":',
    `for (const entry of appended) appendReplayEntry(acc, entry);
      for (let index = acc.entries.length - 1; index >= 0; index--) {
        const entry = acc.entries[index];
        if (entry === void 0 || entry.kind === "pending") continue;
        if (entry.turnEnded !== true) {
          acc.entries[index] = { ...entry, turnEnded: true };
          acc.ops += 1;
        }
        break;
      }
      return true;
    }
    case "llm/retry":`);
  return '// dscode-turn-divider-v1\n' + turnDividedLines.toString() + '\n' + text;
}
