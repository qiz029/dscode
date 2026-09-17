import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The published Ink release this frame patch was validated against.
 *
 * Ink erases the previous frame and repaints the new one from its TOP, so a frame
 * that gets shorter (a step boundary blanks the streaming tail) leaves the composer
 * higher, with blank rows below it. Reserving those freed rows ABOVE the frame keeps
 * the block height stable, so the composer is only ever pushed down by new output
 * instead of riding up once per loop.
 *
 * This is a dependency-internal patch: the repaint lives in Ink, not in the vendored
 * terminal, so it stays here beside the other dependency patches (patch-runtime.mjs)
 * rather than in packages/tui.
 */
export const INK_VERSION = '5.2.1';
const MARKER = 'dscode-frame-v1';

export function patchInkFrame(root, { required = true } = {}) {
  const dir = join(root, 'node_modules/ink');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    const note = `ink is not installed under ${root}: the frame-anchor patch was not applied.`;
    if (required) throw new Error(note);
    process.emitWarning(note);
    return 'missing';
  }
  if (manifest.version !== INK_VERSION) throw new Error('Revalidate the Ink frame patch before upgrading ink');
  const path = join(dir, 'build/log-update.js');
  const before = readFileSync(path, 'utf8');
  if (before.includes(MARKER)) return 'unchanged';
  const NL = String.raw`\n`;
  const from = `        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);\n        previousLineCount = output.split('${NL}').length;`;
  if (before.split(from).length !== 2) throw new Error('Pinned Ink frame repaint drift: ' + path);
  const to = `        const dscodeLineCount = output.split('${NL}').length;\n        const dscodePad = Math.max(0, previousLineCount - dscodeLineCount); // ${MARKER}\n        stream.write(ansiEscapes.eraseLines(previousLineCount) + '${NL}'.repeat(dscodePad) + output);\n        previousLineCount = dscodePad + dscodeLineCount;`;
  writeFileSync(path, before.replace(from, to));
  return 'patched';
}

if (process.argv[1] && process.argv[1].endsWith('patch-ink.mjs')) {
  const root = process.argv[2] ?? join(import.meta.dirname, '..');
  console.log(`ink frame patch: ${patchInkFrame(root)}`);
}
