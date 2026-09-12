import { replaceOnce } from './patch-runtime.mjs';

// Embedded in the pinned TUI bundle, so published builds need no local imports.
export function imePosition(anchor, height, columns) {
  if (!anchor?.node || anchor.active === false || !Number.isFinite(height) || height < 1) return;
  let x = anchor.column, y = anchor.row;
  for (let node = anchor.node; node; node = node.parentNode) {
    if (node.yogaNode) {
      x += node.yogaNode.getComputedLeft();
      y += node.yogaNode.getComputedTop();
    }
  }
  if (y < 0 || y >= height) return;
  return { up: height - Math.floor(y), column: Math.max(1, Math.min(columns || 80, Math.floor(x) + 1)) };
}

export function imeWriter(stream, anchors) {
  const write = stream.write;
  let parked = false;
  const restore = () => {
    if (!parked) return;
    parked = false;
    write.call(stream, '\x1b8');
  };
  const wrapped = function (...args) { restore(); return write.apply(this, args); };
  if (stream.isTTY) stream.write = wrapped;
  return {
    park(height) {
      if (!stream.isTTY) return;
      restore();
      const target = imePosition(anchors.get(stream), height, stream.columns);
      if (!target) return;
      write.call(stream, `\x1b7\x1b[${target.up}A\x1b[${target.column}G`);
      parked = true;
    },
    dispose() {
      restore();
      if (stream.write === wrapped) stream.write = write;
    }
  };
}

export function patchIme(text) {
  if (text.includes('// dscode-ime-v1')) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  patch('const create = (stream, { showCursor = false } = {}) => {', 'const create = (stream, { showCursor = false } = {}) => {\n\tconst ime = imeWriter(stream, dscodeImeAnchors);');
  patch('if (output === previousOutput) return;', 'if (output === previousOutput) { ime.park(output.split("\\n").length - 1); return; }');
  patch('previousLineCount = output.split("\\n").length;', 'previousLineCount = output.split("\\n").length;\n\t\time.park(previousLineCount - 1);');
  patch('render.done = () => {\n\t\tpreviousOutput', 'render.done = () => {\n\t\time.dispose();\n\t\tpreviousOutput');
  // A cursor move can leave the painted output unchanged (e.g. blink off).
  patch('if (!hasStaticOutput && output !== this.lastOutput) this.throttledLog(output);', 'if (!hasStaticOutput) this.throttledLog(output);');
  patch('const staticEditor = (0, import_react.createElement)(Box, { flexDirection: "column" }, ...editorRows);', `const staticEditor = (0, import_react.createElement)(Box, {
    flexDirection: "column",
    ref: dscodeImeRef
  }, ...editorRows);`);
  patch('editorScrollRef.current = editorWindowStart;', 'editorScrollRef.current = editorWindowStart;\n  Object.assign(dscodeImeState.current, { row: caret.row - editorWindowStart, column: 2 + caret.column, active: active && !frozen && !preparingImages });');
  patch('const inputTerminalRows = useStdout().stdout?.rows ?? 30;', 'const inputTerminalRows = useStdout().stdout?.rows ?? 30;\n\tconst dscodeImeStdout = useStdout().stdout;\n  const dscodeImeState = (0, import_react.useRef)({});\n  const dscodeImeRef = (0, import_react.useCallback)(node => {\n    dscodeImeState.current.node = node;\n    if (node) dscodeImeAnchors.set(dscodeImeStdout, dscodeImeState.current);\n    else dscodeImeAnchors.delete(dscodeImeStdout);\n  }, [dscodeImeStdout]);');
  return '// dscode-ime-v1\nconst dscodeImeAnchors = new WeakMap();\n' + imePosition.toString() + '\n' + imeWriter.toString() + '\n' + text;
}
