import { replaceOnce } from './patch-runtime.mjs';

// The prompt is already wrapped into terminal-safe rows. Pad each physical
// row so its background remains a continuous block across wrapped lines.
export function userBackgroundRows(rows, columns, measure) {
  const width = Math.max(1, Math.floor(columns));
  return rows.map(row => {
    const used = row.segments.reduce((sum, segment) => sum + measure(segment.text), 0);
    return {
      ...row,
      background: 'user',
      segments: [...row.segments, { text: ' '.repeat(Math.max(0, width - used)), style: 'plain' }],
    };
  });
}

export function patchUserBackground(text) {
  if (text.includes('// dscode-user-background-v1')) return text;
  // The interaction patch's chat-line source already returns user rows through userBackgroundRows; older bundles still need the swap.
  if (!text.includes('userBackgroundRows(rows, columns, visibleColumns)')) text = replaceOnce(text,
    'return transcriptEntryLines(entry, columns, false, false, false);',
    'const rows = transcriptEntryLines(entry, columns, false, false, false);\n  return entry.kind === "user" && !entry.notice ? userBackgroundRows(rows, columns, visibleColumns) : rows;');
  const start = text.indexOf('function StyledRows({ lines }) {');
  const end = text.indexOf('\n}', start) + 2;
  if (start < 0 || end <= start) throw Error('Pinned StyledRows renderer drift');
  const original = text.slice(start, end);
  const styled = replaceOnce(original,
    'key: index,\n\t\twrap: "truncate-end"\n\t}, line.segments.length === 0',
    'key: index,\n    wrap: "truncate-end",\n    backgroundColor: line.background === "user" ? inkColor(getPalette().composerBand) : void 0,\n    color: line.background === "user" ? inkColor(getPalette().text) : void 0\n  }, line.segments.length === 0');
  text = replaceOnce(text, original, styled);
  return '// dscode-user-background-v1\n' + userBackgroundRows.toString() + '\n' + text;
}
