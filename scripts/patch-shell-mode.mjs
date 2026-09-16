import { replaceOnce } from './patch-util.mjs';

// A draft that starts with `!` is a shell command: the composer is framed in the brand blue
// (a border, never a filled band), the bang leads the line (the prompt glyph steps aside), and
// Esc leaves the mode before anything else claims Escape. The text itself is untouched, so the
// same `!command` still runs as before.

export const SHELL_MODE_MARKER = '// dscode-shell-mode-v1';

export function patchShellMode(text) {
  if (text.includes(SHELL_MODE_MARKER)) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  // The draft decides three things: the prompt glyph, the frame, and — because the hint row is
  // part of the composer — the row count the App budgets the live region with.
  patch('const [value, setValue] = (0, import_react.useState)("");',
    'const [value, setValue] = (0, import_react.useState)("");\n\tconst dscodeShellDraft = String(value ?? "").startsWith("!");');
  patch('\t\tonEditorRows(editorRowCount);\n\t}, [editorRowCount, onEditorRows]);',
    '\t\tonEditorRows(editorRowCount + (dscodeShellDraft && !frozen ? 1 : 0));\n\t}, [editorRowCount, dscodeShellDraft, frozen, onEditorRows]);');
  patch('const promptGlyph = submitMode === "steer" ? "\u21b3" : waveTier === "flash" ? "\u203a" : waveTier === "deepseek" ? "\u00bb" : "\u276f";',
    'const promptGlyph = dscodeShellDraft ? " " : submitMode === "steer" ? "\u21b3" : waveTier === "flash" ? "\u203a" : waveTier === "deepseek" ? "\u00bb" : "\u276f";');
  // A shell draft is FRAMED, not filled: the rows pad to the border's interior, so the composer
  // keeps the terminal width and exactly the same row count as the filled band it replaces.
  patch('const bandFill = (consumed) => " ".repeat(Math.max(0, bandWidth - consumed));',
    'const dscodeBandFillWidth = dscodeShellDraft ? Math.max(0, bandWidth - 2) : bandWidth;\n\tconst bandFill = (consumed) => " ".repeat(Math.max(0, dscodeBandFillWidth - consumed));');
  patch('const band = (content) => (0, import_react.createElement)(Box, {',
    'const band = (content) => dscodeShellDraft ? (0, import_react.createElement)(Box, { flexDirection: "column", width: bandWidth, borderStyle: "round", borderColor: inkColor(getPalette().brandBright) }, content) : (0, import_react.createElement)(Box, {');
  // Claude Code marks bash mode with a `! for shell mode` status line under the input; DSCODE
  // keeps its filled band, so the same signal rides a hint row in the brand colour instead.
  // Esc leaves shell mode, but only after the composer's own Escape ladder has had its
  // say: an open completion menu and a live notice keep their key, and a running turn is
  // still interruptible with a second Esc.
  // Esc leaves shell mode, but only after the composer's own Escape ladder has had its say:
  // an open completion menu keeps the key, and a running turn stays interruptible with a
  // second Esc. The notice is dismissed by the exit itself.
  patch('\t\tif (key.escape) {\n\t\t\tif (menuActive) {\n\t\t\t\tsetDismissedMenuValue(liveValue);\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (hasNotice) {\n\t\t\t\tdismissNotice();\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (busy) interrupt();\n\t\t\treturn;\n\t\t}',
    '\t\tif (key.escape) {\n\t\t\tif (menuActive) {\n\t\t\t\tsetDismissedMenuValue(liveValue);\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (liveValue.startsWith("!")) {\n\t\t\t\t// Dropping the bang shifts every character left: keep the caret on the same letter.\n\t\t\t\tapplyEdit({ value: liveValue.slice(1), cursor: Math.max(0, liveCursor - 1) });\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (hasNotice) {\n\t\t\t\tdismissNotice();\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (busy) interrupt();\n\t\t\treturn;\n\t\t}');
  patch('}, menu, burstArmed ?',
    '}, menu, dscodeShellDraft ? (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, dscodeT("composer.shellMode")) : null, burstArmed ?');
  // Steer mode hardcodes its arrow in two render sites instead of using the promptGlyph, so a
  // shell draft has to claim both or the bang stops leading the line.
  patch('submitMode === "steer" ? "\u21b3 " : busy ? "\u2026 " : `${promptGlyph} `',
    'dscodeShellDraft ? `${promptGlyph} ` : submitMode === "steer" ? "\u21b3 " : busy ? "\u2026 " : `${promptGlyph} `');
  patch('index === 0 ? preparingImages ?',
    'index === 0 ? dscodeShellDraft ? (0, import_react.createElement)(Text, { color: promptColor }, `${promptGlyph} `) : preparingImages ?');
  return SHELL_MODE_MARKER + '\n' + text;
}
