import { replaceOnce } from './patch-util.mjs';

// Keep the composer still. `step/start` blanks the streaming tail for one render, so a live
// column sized by its content collapses and the composer rides up with it — once per loop.
// Two changes: Ink's frame repaint anchors the BOTTOM (a shorter frame keeps its blank rows
// ABOVE and the block never shrinks, so the composer is only ever pushed down), and the rows the
// activity line and the compaction panel draw are subtracted from the live-region budget, so the
// frame can never reach the terminal height (Ink answers that by clearing the whole screen and
// the scrollback on every frame).
//
// This runs after patch-email, which rewrites the same live-column expression.

export const FRAME_MARKER = '// dscode-frame-v1';

export function patchFrame(text) {
  if (text.includes(FRAME_MARKER)) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  // The activity line occupies the todo slot while a turn runs, and turn/start empties view.todos.
  patch('todo: transcriptVisible && view.todos.length > 0,', 'todo: transcriptVisible && (view.todos.length > 0 || busy),');
  // The compaction panel draws over the tail, so the tail gives those rows back.
  patch('const streamRows = Math.max(1, dynamicRows - visibleLiveLines.length);',
    'const streamRows = Math.max(1, dynamicRows - dscodeCompactionRows - visibleLiveLines.length);');
  patch('\t}, dynamicRows);\n\tif (liveAudit.warning !== void 0',
    '\t}, Math.max(0, dynamicRows - dscodeCompactionRows));\n\tif (liveAudit.warning !== void 0');
  // Ink erases the previous frame and repaints the new one from its TOP, so a frame that gets
  // shorter (a step boundary blanks the streaming tail) leaves the composer higher, with blank
  // rows below it. Reserve those freed rows ABOVE the frame instead: the block keeps its height
  // and only ever grows, an equal repaint stays symmetric, and the next static write lands in the
  // reserved rows as real history. The composer is then only ever pushed DOWN by new output.
  patch('stream.write(eraseLines(previousLineCount) + output);\n\t\tpreviousLineCount = output.split("\\n").length;',
    'const dscodeLineCount = output.split("\\n").length;\n\t\tconst dscodePad = Math.max(0, previousLineCount - dscodeLineCount);\n\t\tstream.write(eraseLines(previousLineCount) + "\\n".repeat(dscodePad) + output);\n\t\tpreviousLineCount = dscodePad + dscodeLineCount;');
  return FRAME_MARKER + '\n' + text;
}
