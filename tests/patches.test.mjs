import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WELCOME_ART, WELCOME_ART_SMALL, welcomeArtRows } from '../packages/tui/src/dscode/welcome.ts';
import { patchInkLogUpdate } from '../scripts/patch-ink.mjs';

// The terminal is vendored source now, so these assert the source itself instead of a
// patched bundle: what used to be "the patch applied correctly" is "the source still
// carries the DSCODE behaviour".

test('the vendored terminal keeps the real terminal in charge of scrolling and selection', () => {
  const source = readFileSync(new URL('../packages/tui/src/app.ts', import.meta.url), 'utf8');
  assert(source.includes('MemoStaticTranscript'), 'settled history must ride Ink Static into the terminal scrollback');
  for (const marker of [
    'dscode-viewport-v1',
    'DSCODE_MOUSE_ENABLE',
    'height: Math.max(1, terminalRows - 1)',
    'dscodeMouseEnabled',
    'scrollTranscript',
    'dscodeQueueWheel',
  ]) {
    assert(!source.includes(marker), `the in-place viewport generation must be gone: ${marker}`);
  }
});

test('welcome art packs pixel pairs into half blocks with merged runs', () => {
  assert.deepEqual(welcomeArtRows(['.1223', '.1332'], { 1: 'deep', 2: 'mid', 3: 'bright' }), [[
    { glyph: ' ', text: ' ', color: '', background: '' },
    { glyph: '█', text: '█', color: 'deep', background: '' },
    { glyph: '▀', text: '▀▀', color: 'mid', background: 'bright' },
    { glyph: '▀', text: '▀', color: 'bright', background: 'mid' },
  ]]);
  assert.deepEqual(welcomeArtRows(['1', '.'], { 1: 'x' }), [[{ glyph: '▀', text: '▀', color: 'x', background: '' }]]);
  assert.deepEqual(welcomeArtRows(['.', '1'], { 1: 'x' }), [[{ glyph: '▄', text: '▄', color: 'x', background: '' }]]);
  for (const [art, size] of [[WELCOME_ART, 24], [WELCOME_ART_SMALL, 22]]) {
    assert.equal(art.length, size);
    assert(art.every(row => row.length === size && /^[.123]+$/.test(row)));
    assert.equal(welcomeArtRows(art, { 1: 'a', 2: 'b', 3: 'c' }).length, size / 2);
    const shape = art.slice(0, size - 1).map(row => row.replace(/[123]/g, '#'));
    assert.deepEqual(shape, [...shape].reverse(), 'snowflake shape mirrors vertically');
    // Column 0 and pixel row size-1 are the canvas margins; the flake itself is odd-sized and centred.
    assert.deepEqual(shape.map(row => row.slice(1)), shape.map(row => [...row.slice(1)].reverse().join('')), 'snowflake shape mirrors horizontally');
  }
});

test('the vendored terminal keeps the DSCODE shell mode on a !draft', () => {
  const source = readFileSync(new URL('../packages/tui/src/app.ts', import.meta.url), 'utf8');
  assert(source.includes('dscodeShellDraft'), 'a !draft must switch the composer into shell mode');
  assert(source.includes("dscodeT('composer.shellMode')"), 'shell mode must carry its hint row');
  assert.match(
    source,
    /borderStyle: 'round', borderColor: inkColor\(getPalette\(\)\.brandBright\)/,
    'the shell composer is framed in the brand colour, never filled',
  );
  // A shell draft is framed, not marked: the glyph stays a blank spacer while
  // the editor hides the routing bang and the caret follows one column left.
  assert.match(source, /promptGlyph = dscodeShellDraft \? ' '/, 'the prompt glyph must stay a blank spacer');
  assert.match(source, /const editorValue = dscodeShellDraft \? value\.slice\(1\) : value/, 'the editor must hide the shell bang');
  assert.match(
    source,
    /clampCursor\(editorValue, dscodeShellDraft \? Math\.max\(0, cursor - 1\) : cursor\)/,
    'the caret must follow the hidden bang',
  );
  assert.match(source, /verboseLine\(editorValue, /, 'the frozen line must hide the shell bang too');
  // Esc leaves the mode by dropping the bang, before the notice/interrupt ladder.
  assert.match(source, /liveValue\.startsWith\('!'\)[\s\S]{0,200}value: liveValue\.slice\(1\)/, 'Esc must leave shell mode');
});

// The repaint ledger is a dependency-internal patch, so its input is the published
// Ink text: these fixtures are the generations it must still recognise.
const PRISTINE_LEDGER = [
  'function create(stream) {',
  '    let previousLineCount = 0;',
  "    let previousOutput = '';",
  '    const render = (str) => {',
  '        const output = str;',
  '        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);',
  "        previousLineCount = output.split('\\n').length;",
  '    };',
  '    render.clear = () => {',
  '        stream.write(ansiEscapes.eraseLines(previousLineCount));',
  "        previousOutput = '';",
  '    };',
  '    render.done = () => {',
  "        previousOutput = '';",
  '        previousLineCount = 0;',
  '    };',
  '}',
].join('\n');

/** The v2 body exactly as the previous generation wrote it into ink. */
const V2_LEDGER = PRISTINE_LEDGER
  .replace("    let previousLineCount = 0;\n", "    let previousLineCount = 0;\n    let dscodeReserved = 0;\n")
  .replace('    const render = (str) => {', '    const render = (str, dscodeStaticRows) => {')
  .replace(
    "        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);\n        previousLineCount = output.split('\\n').length;",
    "        const dscodeLineCount = output.split('\\n').length;\n"
    + "        // dscode-frame-v2: the rows a static flush freed stay reserved, so the block cannot\n"
    + "        // shrink under the composer; without a row count the caller kept v1 behaviour.\n"
    + "        const dscodeFloor = dscodeStaticRows === void 0 ? 0 : Math.max(0, dscodeReserved - dscodeStaticRows);\n"
    + "        const dscodePad = Math.max(0, Math.max(previousLineCount, dscodeFloor) - dscodeLineCount);\n"
    + "        stream.write(ansiEscapes.eraseLines(previousLineCount) + '\\n'.repeat(dscodePad) + output);\n"
    + "        previousLineCount = dscodePad + dscodeLineCount;\n"
    + "        dscodeReserved = 0;",
  )
  .replace(
    "        stream.write(ansiEscapes.eraseLines(previousLineCount));\n        previousOutput = '';",
    "        stream.write(ansiEscapes.eraseLines(previousLineCount));\n        dscodeReserved = previousLineCount;\n        previousOutput = '';",
  )
  .replace(
    "        previousOutput = '';\n        previousLineCount = 0;",
    "        previousOutput = '';\n        previousLineCount = 0;\n        dscodeReserved = 0;",
  );

test('the Ink repaint ledger patch migrates every generation exactly once', () => {
  for (const [name, source] of [['pristine', PRISTINE_LEDGER], ['v2', V2_LEDGER]]) {
    const patched = patchInkLogUpdate(source);
    assert(patched.includes('dscode-frame-v3'), `${name} carries the current ledger`);
    // Only the rows a flush did not consume stay reserved.
    assert(patched.includes('const dscodePad = Math.max(0, dscodeFloor - dscodeLineCount);'), name);
    assert(patched.includes('? previousLineCount\n'), `${name} keeps the no-flush floor`);
    assert(patched.includes('let dscodeReserved = 0;'), `${name} declares the flush ledger`);
    assert(patched.includes('const render = (str, dscodeStaticRows) => {'), `${name} reads the flush rows`);
    assert(!patched.includes('dscode-frame-v2'), `${name} drops the old marker`);
    assert.equal(patchInkLogUpdate(patched), patched, `${name} is idempotent`);
  }
  assert.throws(() => patchInkLogUpdate('nothing like the ledger'), /known generation/);
  // A ledger that would lose its flush counter fails loudly instead of patching NaN pads in.
  assert.throws(() => patchInkLogUpdate(PRISTINE_LEDGER.replace('    let previousLineCount = 0;\n', '')), /flush counter/);
});
