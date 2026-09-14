import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createTestRuntime, upstreamPackages } from '../scripts/test-runtime.mjs';
import { patchTui } from '../scripts/patch-tui.mjs';
import { patchRuntime } from '../scripts/patch-runtime.mjs';
import { patchStyle } from '../scripts/patch-style.mjs';
import { visibleSettledLines } from '../scripts/patch-viewport.mjs';
import { WELCOME_ART, WELCOME_ART_SMALL, welcomeArtRows, welcomeVisibleRows } from '../scripts/patch-welcome.mjs';
import { ctrlCAction } from '../scripts/patch-interrupt.mjs';
import { patchScroll, transcriptWindow, mouseWheelDirection } from '../scripts/patch-scroll.mjs';
import { turnDividedLines } from '../scripts/patch-turn-divider.mjs';
import { userBackgroundRows } from '../scripts/patch-user-background.mjs';
import { collapseLargePaste, expandLargePastes, pasteAtomicEdit, pasteCursorEdge } from '../scripts/patch-large-paste.mjs';

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

test('transcript viewport keeps the newest settled lines within its row budget', () => {
  const entries = [['old'], [], ['a', 'b', 'c'], ['streaming']];
  const render = (entry, width, reasoning) => {
    assert.equal(width, 10);
    assert.equal(reasoning, false);
    return entry;
  };
  assert.deepEqual(visibleSettledLines(entries, 3, 2, 8, false, render), ['b', 'c']);
  assert.deepEqual(visibleSettledLines(entries, 3, 5, 8, false, render), ['old', 'a', 'b', 'c']);
  assert.deepEqual(visibleSettledLines(entries, 3, 0, 8, false, () => assert.fail('hidden viewport must not render')), []);
});

test('completed turns separate live and resumed transcripts without changing export', async t => {
  const fixture = createTestRuntime({ tui: true });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  writeFileSync(path, readFileSync(path, 'utf8') + '\nexport { createTranscriptStore, visibleSettledLines, buildExportMarkdown };\n');
  const { createTranscriptStore, visibleSettledLines, buildExportMarkdown } = await import(pathToFileURL(path).href);
  const events = [
    { seq: 1, time: 1, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'first prompt' }] } },
    { seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, time: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'first answer' }] } } },
    { seq: 4, time: 4, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 5, time: 5, type: 'user/message', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'second prompt' }] } },
    { seq: 6, time: 6, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, time: 7, type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'second answer' }] } } },
    { seq: 8, time: 8, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const resumed = createTranscriptStore(events).getView();
  const liveStore = createTranscriptStore();
  for (const event of events) liveStore.apply(event);
  assert.deepEqual(liveStore.getView().entries, resumed.entries);
  assert.deepEqual(resumed.entries.map(entry => [entry.kind, entry.turnEnded === true]), [
    ['user', false], ['assistant', true], ['user', false], ['assistant', true],
  ]);
  const render = entry => [{ segments: [{ text: entry.text, style: 'plain' }] }];
  const lines = visibleSettledLines(resumed.entries, resumed.entries.length, Infinity, 32, false, render);
  assert.deepEqual(lines.map(line => line.segments[0].text), [
    'first prompt', 'first answer', '─'.repeat(32),
    'second prompt', 'second answer', '─'.repeat(32),
  ]);
  assert(lines.filter(line => line.segments[0].style === 'dim').length === 2);
  assert(!buildExportMarkdown(resumed, 'fixture').includes('─'));
});

test('turn divider yields scarce viewport rows to the answer', () => {
  const answer = [{ segments: [{ text: 'answer', style: 'plain' }] }];
  assert.equal(turnDividedLines({ turnEnded: true }, 80, answer, 1), answer);
  assert.equal(turnDividedLines({ turnEnded: false }, 80, answer, Infinity), answer);
  assert.equal(turnDividedLines({ turnEnded: true }, 80, answer, Infinity)[1].segments[0].text, '─'.repeat(80));
  assert.equal(turnDividedLines({ turnEnded: true }, 120, answer, Infinity)[1].segments[0].text.length, 120);
});

test('user background pads every wrapped row without changing its content', () => {
  const original = [
    { segments: [{ text: '❯ ', style: 'brand' }, { text: '你好', style: 'plain' }] },
    { segments: [{ text: '  ', style: 'plain' }, { text: 'next', style: 'plain' }] },
  ];
  const measure = text => [...text].reduce((width, char) => width + (/[\u4e00-\u9fff]/u.test(char) ? 2 : 1), 0);
  const rows = userBackgroundRows(original, 10, measure);
  assert.deepEqual(rows.map(row => row.background), ['user', 'user']);
  assert(rows.every(row => row.segments.reduce((width, segment) => width + measure(segment.text), 0) === 10));
  assert.equal(original[0].segments.length, 2, 'source rows stay unchanged');
});

test('large paste stays compact in the draft and expands exactly on submission', () => {
  const pastes = new Map();
  const raw = `日志开始\n${'你'.repeat(1001)}\n日志结束`;
  const first = collapseLargePaste(raw, '请看 ', pastes);
  const second = collapseLargePaste(raw, `请看 ${first} 再看 `, pastes);
  assert.match(first, /^\[Pasted Content \d+ chars\]$/);
  assert.equal(second, `${first} #2`);
  assert.equal(expandLargePastes(`请看 ${first} 再看 ${second}`, pastes), `请看 ${raw} 再看 ${raw}`);
  assert.equal(expandLargePastes(second, new Map([[first, 'wrong'], [second, `literal ${first}`]])), `literal ${first}`);
  assert.equal(collapseLargePaste('短文本', '', pastes), '短文本');
  assert.equal(collapseLargePaste('x'.repeat(200), '', pastes), 'x'.repeat(200));
  assert.match(collapseLargePaste('x'.repeat(201), '', new Map()), /^\[Pasted Content 201 chars\]$/);
  assert.equal(collapseLargePaste(`/clear\n${'x'.repeat(201)}`, '', pastes), `/clear\n${'x'.repeat(201)}`);
  const before = `请看 ${first} 结尾`;
  const cursor = before.indexOf(first) + first.length;
  assert.equal(pasteCursorEdge(before, cursor, cursor - 1, pastes), before.indexOf(first));
  const deleted = pasteAtomicEdit(before, { value: before.slice(0, cursor - 1) + before.slice(cursor), cursor: cursor - 1 }, pastes);
  assert.equal(deleted.value, '请看  结尾');
  assert.equal(pastes.has(first), false);
  const forward = pasteAtomicEdit(`前 ${second} 后`, { value: `前 ${second.slice(1)} 后`, cursor: 2 }, pastes);
  assert.equal(forward.value, '前  后');
  assert.equal(pastes.size, 0);
});

test('installed large-paste patch upgrades its threshold without duplicating helpers', t => {
  const fixture = createTestRuntime({ tui: true });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  const current = readFileSync(path, 'utf8');
  assert(current.includes('const LARGE_PASTE_CHARS = 200;'));
  writeFileSync(path, current.replace('const LARGE_PASTE_CHARS = 200;', 'const LARGE_PASTE_CHARS = 1000;'));
  patchTui(fixture.root);
  const upgraded = readFileSync(path, 'utf8');
  assert(upgraded.includes('const LARGE_PASTE_CHARS = 200;'));
  assert.equal(upgraded.split('// dscode-large-paste-v1').length, 2);
  patchTui(fixture.root);
  assert.equal(readFileSync(path, 'utf8'), upgraded);
});

test('real Ink composer renders a paste token but dispatches full text', async t => {
  const fixture = createTestRuntime({ tui: true });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  writeFileSync(path, readFileSync(path, 'utf8') + '\nexport { Input, render, import_react as react, dscodeChatLines };\n');
  const ui = await import(pathToFileURL(path).href);
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: true });
  const frames = [], sent = [];
  stdout.on('data', data => frames.push(data.toString()));
  const noop = () => {};
  const props = { active: true, frozen: false, busy: false, descriptors: [], skills: [],
    dispatch: text => sent.push(text), steer: noop, interrupt: noop, quit: noop,
    notify: noop, applyEditorKeys: noop, hasNotice: false, dismissNotice: noop,
    toggleReasoning: noop, openVerbose: noop, recallSpace: [], queued: [],
    animations: false, waveTier: null, waveStyle: null, maxRows: 4,
    onEditorRows: noop, onMenuRows: noop, sessionKey: 'fixture', recordLocal: noop, recordHistory: noop };
  const mounted = ui.render(ui.react.createElement(ui.Input, props), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    stdin.write('前缀 ');
    await new Promise(resolve => setTimeout(resolve, 20));
    const raw = `${'日志'.repeat(550)}\n结束`;
    stdin.write(`\x1b[200~${raw}\x1b[201~`);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(frames.at(-1)?.includes('[Pasted Content 1103 chars]'));
    assert(!frames.at(-1)?.includes('日志日志日志日志'));
    stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(sent, [`前缀 ${raw}`]);
    const displayed = ui.dscodeChatLines({ kind: 'user', text: sent[0], notice: false }, 78);
    assert(displayed.some(row => row.segments.some(segment => segment.text.includes('日志'))));
  } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

test('real Ink composer shows pasted image paths as numbered Image attachments', async t => {
  const fixture = createTestRuntime({ tui: true });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  writeFileSync(path, readFileSync(path, 'utf8') + '\nexport { Input, render, import_react as react };\n');
  const ui = await import(pathToFileURL(path).href);
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: true });
  const frames = [], sent = [];
  stdout.on('data', data => frames.push(data.toString()));
  const noop = () => {};
  const props = { active: true, frozen: false, busy: false, descriptors: [], skills: [],
    dispatch: (text, blocks) => sent.push({ text, blocks }), steer: noop, interrupt: noop, quit: noop,
    notify: noop, applyEditorKeys: noop, hasNotice: false, dismissNotice: noop,
    toggleReasoning: noop, openVerbose: noop, recallSpace: [], queued: [],
    animations: false, waveTier: null, waveStyle: null, maxRows: 4,
    onEditorRows: noop, onMenuRows: noop, sessionKey: 'fixture', recordLocal: noop, recordHistory: noop,
    inspectImages: async paths => paths.map(path => ({ path, name: path.split('/').at(-1) })),
    readClipboardImage: async () => '/tmp/from-clipboard.png',
    inspectFiles: async () => [], prepareImages: async paths => paths.map(path => ({ type: 'image', path })),
    prepareFiles: async () => [] };
  const mounted = ui.render(ui.react.createElement(ui.Input, props), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    stdin.write('\x1b[200~/tmp/first.png\x1b[201~');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(frames.at(-1)?.includes('[Image 1]'));
    assert(!frames.at(-1)?.includes('/tmp/first.png'));
    stdin.write('\x1b[200~/tmp/second.jpg\x1b[201~');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(frames.at(-1)?.includes('[Image 2]'));
    stdin.write('\x16');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(frames.at(-1)?.includes('[Image 3]'));
    stdin.write('\r');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(sent, [{ text: '[Image 1] [Image 2] [Image 3]', blocks: [
      { type: 'image', path: '/tmp/first.png' }, { type: 'image', path: '/tmp/second.jpg' }, { type: 'image', path: '/tmp/from-clipboard.png' },
    ] }]);
  } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
});

test('transcript scroll bounds and SGR mouse wheel decoding', () => {
  const lines = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(transcriptWindow(lines, 2, 0), ['d', 'e']);
  assert.deepEqual(transcriptWindow(lines, 2, 2), ['b', 'c']);
  assert.deepEqual(transcriptWindow(lines, 2, 99), []);
  assert.deepEqual(transcriptWindow(lines, 0, 0), []);
  assert.equal(mouseWheelDirection('\x1b[<64;20;12M'), 1);
  assert.equal(mouseWheelDirection('\x1b[<65;20;12M'), -1);
  assert.equal(mouseWheelDirection('\x1b[<68;20;12M'), 1);
  assert.equal(mouseWheelDirection('\x1b[<64;20;12m'), 0);
  assert.equal(mouseWheelDirection('\x1b[<0;20;12M'), 0);
  assert.equal(mouseWheelDirection('\x1b[5~'), null);
});

test('welcome rows yield to conversation demand without exceeding the viewport', () => {
  assert.equal(welcomeVisibleRows(20, 13, 0), 13);
  assert.equal(welcomeVisibleRows(20, 13, 7), 13);
  assert.equal(welcomeVisibleRows(20, 13, 8), 12);
  assert.equal(welcomeVisibleRows(20, 13, 20), 0);
  assert.equal(welcomeVisibleRows(3, 4, 30), 4);
  assert.equal(welcomeVisibleRows(20, 13, 20, false), 13);
});

test('pristine locked upstream accepts all patches once, remains valid JS, and is idempotent', t => {
  const fixture = createTestRuntime({ tui: true, runtime: true, patched: false });
  t.after(fixture.close);
  const files = upstreamPackages.map(name => `${fixture.root}/node_modules/${name}/lib/index.${name === 'dsh-code' ? 'mjs' : 'js'}`);
  const before = files.map(path => readFileSync(path, 'utf8'));
  assert(before.every(text => !text.includes('// dscode-')));
  patchTui(fixture.root); patchRuntime(fixture.root);
  const after = files.map(path => readFileSync(path, 'utf8'));
  for (let i = 0; i < files.length; i++) {
    assert.notEqual(after[i], before[i]);
    const checked = spawnSync(process.execPath, ['--check', files[i]], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
  patchTui(fixture.root); patchRuntime(fixture.root);
  assert.deepEqual(files.map(path => readFileSync(path, 'utf8')), after);
  const tui = after[files.findIndex(path => path.endsWith('dsh-code/lib/index.mjs'))];
  for (const marker of ['label: "/verbose"', 'if (text === "/verbose")', 'label: "/mouse"', 'if (text === "/mouse")', 'function dscodeSetMouse(', 'notify(dscodeT(enabled ? "mouse.on" : "mouse.off"))', 'label: "/language"', 'if (text === "/language"', 'function LanguagePanel(', 'if (!wanted) { openLanguage(); return; }', 'function dscodeT(', 'dscodeT("activity.running")', 'dscodeT("welcome.model")', 'notify(dscodeT(next ? "verbose.on" : "verbose.off"))', 'function dscodeSpinnerCells(', 'effort: effortLabel, animated: animations })', 'const ripplePhase = animated ? rippleTick % 4 : 3;', ', dscodeLocale) : ""', 'value === "" ? dscodeT("composer.placeholder") :', 'function dscodeLoadFlag(', 'dscodeSaveFlag("verbose", next);', 'useState)(() => dscodeLoadFlag("verbose"))', 'let dscodeMouseEnabled = dscodeLoadFlag("mouse", true);', 'function dscodeQueueWheel(', 'const DSCODE_WHEEL_FRAME_MS = 16;', 'if (amount === 0) return;', 'scrollRef.current = scrollTranscript;', 'process.stdout.isTTY === true && dscodeMouseEnabled ? DSCODE_MOUSE_ENABLE : ""', 'dscodeSaveFlag("mouse", enabled);']) assert(tui.includes(marker), marker);
  assert(!/[\u4e00-\u9fff]/.test(tui.replace(/const DSCODE_MESSAGES = .*\n/, '').replace(/const DSCODE_LANGUAGES = .*\n/, '').replace(/const DSCODE_LANGUAGE_ALIASES = .*\n/, '')), 'no hard-coded CJK outside the language tables');
  // Prior style revisions used a shorter activity suffix and summary catalog.
  const oldStyle = after[0].replace(': " · 本轮 " + runClock(elapsed);', ': " · " + runClock(elapsed);');
  assert.equal(patchStyle(oldStyle), after[0]);
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

test('older bundles upgrade to per-row coalesced wheel scrolling without duplicating helpers', () => {
  const v2 = [
    '// dscode-scroll-v2',
    'const dscodeWheelListeners = new Set();',
    'let dscodeMouseEnabled = dscodeLoadFlag("mouse", false);',
    'function dscodeSetMouse(enabled) {',
    '  dscodeMouseEnabled = enabled;',
    '  return enabled;',
    '}',
    'function dscodeHandleMouseUnit(unit) {',
    '  const direction = mouseWheelDirection(unit);',
    '  if (direction === null) return false;',
    '  if (direction !== 0) for (const listener of dscodeWheelListeners) listener(direction);',
    '  return true;',
    '}',
    'const startup = (process.stdout.isTTY === true && dscodeMouseEnabled ? DSCODE_MOUSE_ENABLE : "");',
    '\t\t\tif (text === "/mouse") {',
    '\t\t\t\tconst enabled = dscodeSetMouse(!dscodeMouseEnabled);',
    '\t\t\t\tdscodeSaveFlag("mouse", enabled);',
    '\t\t\t\tnotify(dscodeT(enabled ? "mouse.on" : "mouse.off"));',
    '\t\t\t\treturn;',
    '\t\t\t}',
    '  const scrollTranscript = (direction, page = false) => {',
    '    if (!transcriptVisible || settledViewportRows <= 0) return;',
    '    const step = page ? Math.max(1, settledViewportRows - 1) : 3;',
    '    setScrollOffset(current => Math.max(0, Math.min(maxScrollOffset, (current === scrollOffset ? effectiveScrollOffset : current) + direction * step)));',
    '  };',
    '  (0, import_react.useEffect)(() => {',
    '    const listener = direction => scrollTranscript(direction);',
    '    dscodeWheelListeners.add(listener);',
    '    return () => dscodeWheelListeners.delete(listener);',
    '  });',
    '',
  ].join('\n');
  const upgraded = patchScroll(v2);
  assert(upgraded.startsWith('// dscode-scroll-v3\n'), 'marker moves to v3');
  assert(upgraded.includes('let dscodeMouseEnabled = dscodeLoadFlag("mouse", true);'), 'capture defaults on');
  assert(upgraded.includes('function dscodeQueueWheel(direction) {'), 'notches coalesce inside a frame');
  assert(upgraded.includes('if (direction !== 0) dscodeQueueWheel(direction);'));
  assert(upgraded.includes('const amount = direction * step;'), 'one row per notch');
  assert(upgraded.includes('scrollRef.current = scrollTranscript;'));
  assert(!upgraded.includes(': 3;'), 'the coarse three-row step is gone');
  assert.equal((upgraded.match(/const dscodeWheelListeners = new Set\(\);/g) ?? []).length, 1, 'helpers are not duplicated');
  assert.equal(patchScroll(upgraded), upgraded, 'upgrade is idempotent');

  const v1 = [
    '// dscode-scroll-v1',
    '\t{\n\t\tlabel: "/verbose",\n\t\tdescription: "toggle thinking and tool call details in the chat"\n\t},\n',
    'const dscodeWheelListeners = new Set();',
    'function dscodeHandleMouseUnit(unit) {',
    '  const direction = mouseWheelDirection(unit);',
    '  if (direction === null) return false;',
    '  if (direction !== 0) for (const listener of dscodeWheelListeners) listener(direction);',
    '  return true;',
    '}',
    'let dscodeMouseEnabled = true;',
    'const startup = (process.stdout.isTTY === true ? DSCODE_MOUSE_ENABLE : "");',
    'if (process.stdout.isTTY === true) process.stdout.write(DSCODE_MOUSE_DISABLE);\n\t\t\tif (process.stdin.isTTY === true) process.stdin.setRawMode?.(false);\n\t\t\tthrow error;',
    '\t\t\tif (text === "/todos") {\n\t\t\t\topenTodos();',
    '  const scrollTranscript = (direction, page = false) => {',
    '    if (!transcriptVisible || settledViewportRows <= 0) return;',
    '    const step = page ? Math.max(1, settledViewportRows - 1) : 3;',
    '    setScrollOffset(current => Math.max(0, Math.min(maxScrollOffset, (current === scrollOffset ? effectiveScrollOffset : current) + direction * step)));',
    '  };',
    '  (0, import_react.useEffect)(() => {',
    '    const listener = direction => scrollTranscript(direction);',
    '    dscodeWheelListeners.add(listener);',
    '    return () => dscodeWheelListeners.delete(listener);',
    '  });',
    '',
  ].join('\n');
  const migrated = patchScroll(v1);
  assert(migrated.startsWith('// dscode-scroll-v3\n'), 'a v1 bundle moves to v3');
  assert(migrated.includes('function dscodeQueueWheel(direction) {') && migrated.includes('let dscodeMouseEnabled = dscodeLoadFlag("mouse", true);'), 'v1 gains the coalesced wheel and the new default');
  assert(migrated.includes('label: "/mouse"') && migrated.includes('dscodeSaveFlag("mouse", enabled);'), 'v1 gains the /mouse command');
  assert.equal((migrated.match(/function dscodeHandleMouseUnit/g) ?? []).length, 1, 'v1 does not duplicate the handler');
  assert.equal(migrated.match(/function dscodeQueueWheel/g).length, 1);
  assert.equal(patchScroll(migrated), migrated, 'v1 upgrade is idempotent');
});
