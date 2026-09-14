import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createTestRuntime, upstreamPackages } from '../scripts/test-runtime.mjs';
import { patchTui } from '../scripts/patch-tui.mjs';
import { patchRuntime } from '../scripts/patch-runtime.mjs';
import { patchStyle } from '../scripts/patch-style.mjs';
import { WELCOME_ART, WELCOME_ART_SMALL, welcomeArtRows } from '../scripts/patch-welcome.mjs';
import { ctrlCAction } from '../scripts/patch-interrupt.mjs';
import { turnDividedLines } from '../scripts/patch-turn-divider.mjs';
import { userBackgroundRows } from '../scripts/patch-user-background.mjs';
import { collapseLargePaste, expandLargePastes, pasteAtomicEdit, pasteCursorEdge } from '../scripts/patch-large-paste.mjs';
import { patchMacStdin, parseProcessRows, socketFreePids, stdinWaitVerdict, withoutSockets, STDIN_FREEZE_MS } from '../scripts/patch-mac-stdin.mjs';

test('two Ctrl+C presses exit while cancellation is still settling', () => {
  let cancelled = 0;
  const live = { interrupt: () => { cancelled++; return true; }, busy: true, preparingImages: false, active: true, hasDraft: true };
  assert.equal(ctrlCAction(false, live), 'interrupt');
  assert.equal(ctrlCAction(true, live), 'quit');
  assert.equal(cancelled, 1, 'second press does not wait for busy to clear');
  assert.equal(ctrlCAction(false, { ...live, busy: false }), 'interrupt', 'agent status wins over a stale idle view');
  assert.equal(ctrlCAction(false, { ...live, interrupt: () => false, busy: false, hasDraft: true }), 'clear-draft');
});

test('real Ink input routes rapid Ctrl+C to cancel then quit', async t => {
  const fixture = createTestRuntime({ tui: true });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  writeFileSync(path, readFileSync(path, 'utf8') + '\nexport { Input, render, import_react as react };\n');
  const ui = await import(pathToFileURL(path).href);
  for (const active of [true, false]) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    Object.assign(stdout, { columns: 80, rows: 24, isTTY: true });
    const errors = [];
    stderr.on('data', data => errors.push(data.toString()));
    const actions = [];
    const noop = () => {};
    const props = {
      active, frozen: false, busy: true, descriptors: [], skills: [],
      dispatch: noop, steer: noop, interrupt: () => { actions.push('interrupt'); return true; },
      quit: fast => actions.push(['quit', fast]), notify: noop, applyEditorKeys: noop,
      hasNotice: false, dismissNotice: noop, toggleReasoning: noop, openVerbose: noop,
      recallSpace: [], queued: [], animations: false, waveTier: null, waveStyle: null,
      maxRows: 4, onEditorRows: noop, onMenuRows: noop, sessionKey: 'fixture',
    };
    const mounted = ui.render(ui.react.createElement(ui.Input, props), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      stdin.write('\x03');
      await new Promise(resolve => setTimeout(resolve, 10));
      stdin.write('\x03');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.deepEqual(actions, ['interrupt', ['quit', true]], `active=${active}: ${errors.join('')}`);
    } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  }
});

test('the TUI keeps the terminal in charge of scrolling and selection', async t => {
  const fixture = createTestRuntime({ tui: true });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  const text = readFileSync(path, 'utf8');
  assert(text.includes('MemoStaticTranscript'), 'settled history must ride Ink Static into the terminal scrollback');
  for (const marker of ['dscode-viewport-v1', 'DSCODE_MOUSE_ENABLE', 'height: Math.max(1, terminalRows - 1)', 'dscodeMouseEnabled', 'scrollTranscript', 'dscodeQueueWheel'])
    assert(!text.includes(marker), `the in-place viewport generation must be gone: ${marker}`);
});

test('upstream drift fails before replacing any TUI file, including missing login anchors', t => {
  const fixture = createTestRuntime({ tui: true, patched: false });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  const original = readFileSync(path, 'utf8');
  for (const anchor of ['const LOCAL_COMMANDS = [', 'const text = submissionPayload(liveValue);', 'function ProviderSetupPanel(']) {
    const drifted = original.replace(anchor, '/* changed upstream */');
    assert.notEqual(drifted, original);
    writeFileSync(path, drifted);
    assert.throws(() => patchTui(fixture.root), /Unsupported|drift/);
    assert.equal(readFileSync(path, 'utf8'), drifted);
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

