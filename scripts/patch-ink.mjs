import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceOnce } from './patch-util.mjs';

/**
 * The published Ink release this frame patch was validated against.
 *
 * Ink erases the previous frame and repaints the new one from its TOP, so a frame
 * that gets shorter (a step boundary blanks the streaming tail) leaves the composer
 * higher, with blank rows below it. Reserving those freed rows ABOVE the frame keeps
 * the block height stable, so the composer is only ever pushed down by new output
 * instead of riding up once per loop.
 *
 * A static flush is the other half of the same problem: Ink writes new history with
 * log.clear(), which resets the repaint ledger, and then repaints the frame at its
 * natural height, so a live region that had shrunk rides up right after every flush.
 * The ledger now keeps the cleared height and ink.js reports how many rows the static
 * write consumed, so the rest stays reserved.
 *
 * This is a dependency-internal patch: the repaint lives in Ink, not in the vendored
 * terminal, so it stays here beside the other dependency patches (patch-runtime.mjs)
 * rather than in packages/tui.
 */
export const INK_VERSION = '5.2.1';
const MARKER_V2 = 'dscode-frame-v2';

const PRISTINE_BODY = "        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);\n        previousLineCount = output.split('\\n').length;";
const V1_BODY = "        const dscodeLineCount = output.split('\\n').length;\n        const dscodePad = Math.max(0, previousLineCount - dscodeLineCount); // dscode-frame-v1\n        stream.write(ansiEscapes.eraseLines(previousLineCount) + '\\n'.repeat(dscodePad) + output);\n        previousLineCount = dscodePad + dscodeLineCount;";
const V2_BODY = "        const dscodeLineCount = output.split('\\n').length;\n        // dscode-frame-v2: the rows a static flush freed stay reserved, so the block cannot\n        // shrink under the composer; without a row count the caller kept v1 behaviour.\n        const dscodeFloor = dscodeStaticRows === void 0 ? 0 : Math.max(0, dscodeReserved - dscodeStaticRows);\n        const dscodePad = Math.max(0, Math.max(previousLineCount, dscodeFloor) - dscodeLineCount);\n        stream.write(ansiEscapes.eraseLines(previousLineCount) + '\\n'.repeat(dscodePad) + output);\n        previousLineCount = dscodePad + dscodeLineCount;\n        dscodeReserved = 0;";
const DECLARE_FROM = "    let previousLineCount = 0;\n    let previousOutput = '';";
const DECLARE_TO = "    let previousLineCount = 0;\n    let dscodeReserved = 0;\n    let previousOutput = '';";
const RENDER_FROM = "    const render = (str) => {";
const RENDER_TO = "    const render = (str, dscodeStaticRows) => {";
const CLEAR_FROM = "    render.clear = () => {\n        stream.write(ansiEscapes.eraseLines(previousLineCount));\n        previousOutput = '';";
const CLEAR_TO = "    render.clear = () => {\n        stream.write(ansiEscapes.eraseLines(previousLineCount));\n        dscodeReserved = previousLineCount;\n        previousOutput = '';";
const DONE_FROM = "    render.done = () => {\n        previousOutput = '';\n        previousLineCount = 0;";
const DONE_TO = "    render.done = () => {\n        previousOutput = '';\n        previousLineCount = 0;\n        dscodeReserved = 0;";
const INK_LOG_FROM = "            this.log(output);";
const INK_LOG_TO = "            this.log(output, staticOutput.split('\\n').length - 1); // dscode-frame-v2";

/** Repaint ledger: the rows a cleared frame freed stay reserved for the next one. */
export function patchInkLogUpdate(text) {
  if (text.includes(MARKER_V2)) return text;
  text = replaceOnce(text, DECLARE_FROM, DECLARE_TO);
  text = replaceOnce(text, RENDER_FROM, RENDER_TO);
  text = replaceOnce(text, text.includes(V1_BODY) ? V1_BODY : PRISTINE_BODY, V2_BODY);
  text = replaceOnce(text, CLEAR_FROM, CLEAR_TO);
  return replaceOnce(text, DONE_FROM, DONE_TO);
}

/** Report the rows a static flush consumed so the ledger can reserve the rest. */
export function patchInkApp(text) {
  if (text.includes(MARKER_V2)) return text;
  return replaceOnce(text, INK_LOG_FROM, INK_LOG_TO);
}

export function patchInkFrame(root, { required = true } = {}) {
  const dir = join(root, 'node_modules/ink');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    const note = "ink is not installed under " + root + ": the frame-anchor patch was not applied.";
    if (required) throw new Error(note);
    process.emitWarning(note);
    return 'missing';
  }
  if (manifest.version !== INK_VERSION) throw new Error('Revalidate the Ink frame patch before upgrading ink');
  let patched = false;
  for (const [file, patch] of [['build/log-update.js', patchInkLogUpdate], ['build/ink.js', patchInkApp]]) {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = patch(before);
    if (after === before) continue;
    writeFileSync(path, after);
    patched = true;
  }
  return patched ? 'patched' : 'unchanged';
}

if (process.argv[1] && process.argv[1].endsWith('patch-ink.mjs')) {
  const root = process.argv[2] ?? join(import.meta.dirname, '..');
  console.log(`ink frame patch: ${patchInkFrame(root)}`);
}
