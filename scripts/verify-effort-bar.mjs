process.env.DSCODE_UPDATE_CHECK = 'off'; // rendering never performs the startup registry read
process.env.FORCE_COLOR = '3';
process.env.DSCODE_LANGUAGE = 'en'; // the shell-mode hint is asserted verbatim
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { patchTui } from './patch-tui.mjs';
import { patchEffort } from './patch-effort.mjs';

const root = new URL('../', import.meta.url);
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
assert.equal(patchEffort(source), source);
const entry = new URL(`node_modules/dsh-code/lib/.dscode-effort-probe-${process.pid}.mjs`, root);
writeFileSync(entry, source + '\nexport { App, EffortPanel, DscodeUltraRipple, dscodeRippleTone, getPalette, render, import_react as react, setTheme, visibleColumns };\n');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const deepseek = {
  provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-flash', modelName: 'deepseek-flash',
  reasoning: { defaultEffort: 'high', efforts: ['off', 'low', 'high', 'max', 'ultra'].map(id => ({ id, name: id, description: `Choose ${id}` })) },
};
try {
  const ui = await import(entry.href);
  const tones = { brandBright: 'bright', brandMid: 'mid', brandDeep: 'deep' };
  assert.equal(ui.dscodeRippleTone(37, 37, 0, tones), 'bright');
  assert.equal(ui.dscodeRippleTone(31, 37, 0, tones), 'deep');
  assert.equal(ui.dscodeRippleTone(31, 37, 2, tones), 'bright');
  assert.equal(ui.dscodeRippleTone(43, 37, 2, tones), 'bright');
  assert.equal(ui.dscodeRippleTone(37, 37, 2, tones), 'mid');
  async function panel({ row = deepseek, current = 'high', columns = 80, rows = 30, animations = true, run }) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    Object.assign(stdout, { columns, rows, isTTY: true });
    const frames = [], errors = [], selected = [], actions = [];
    stdout.on('data', data => frames.push(data.toString()));
    stderr.on('data', data => errors.push(data.toString()));
    const mounted = ui.render(ui.react.createElement(ui.EffortPanel, {
      row, current, animations,
      select: id => selected.push(id), back: () => actions.push('back'), onExit: () => actions.push('exit'),
    }), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
    const frame = () => frames.map(value => stripVTControlCharacters(value)).filter(value => value.trim() !== '').at(-1) ?? '';
    try {
      await tick();
      assert(frames.length > 0, `No effort render: ${errors.join('')}`);
      await run({ input: async value => { stdin.write(value); await tick(); }, frame, frames, errors, selected, actions });
      assert.equal(errors.length, 0, errors.join(''));
      for (const line of frame().split('\n')) assert(ui.visibleColumns(line) <= columns, `Overflow at ${columns} columns: ${line}`);
    } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  }
  for (const theme of ['dark', 'light']) for (const columns of [32, 48, 80, 120]) {
    ui.setTheme(theme);
    await panel({ columns, run: async ({ frame, input, selected }) => {
      const plain = frame();
      assert.match(plain, /low\s+high\s+max\s+ultra/, plain);
      if (columns >= 32) {
        assert.match(plain, /Faster.*Smarter/);
        assert(!plain.includes('╭'), 'Effort selector should use the composer area, not a dialog frame');
      }
      if (theme === 'dark' && columns === 80) {
        const out = new URL('artifacts/local/effort-bar/', root);
        mkdirSync(out, { recursive: true });
        writeFileSync(new URL('default.txt', out), plain);
      }
      await input('\x1b[C');
      await input('\r');
      assert.deepEqual(selected, ['max']);
    }});
  }
  ui.setTheme('dark');
  await panel({ run: async ({ input, frame, frames, selected }) => {
    await input('\x1b[C'); await input('\x1b[C');
    assert.match(frame(), /✦\s+ULTRA/, 'Ultra focus should show the centered effect before confirmation');
    assert.deepEqual(selected, [], 'Moving focus to Ultra must not apply it');
    await tick(260);
    assert(frames.some(value => (stripVTControlCharacters(value).match(/✦/g) ?? []).length >= 5),
      'Ultra focus should send two visible particles outward before Enter');
    writeFileSync(new URL('artifacts/local/effort-bar/ultra-focus.txt', root), frame());
    await input('\r');
    assert.deepEqual(selected, ['ultra']);
    assert.match(frame(), /✦/);
    writeFileSync(new URL('artifacts/local/effort-bar/ultra.txt', root), frame());
  }});
  await panel({ animations: false, current: 'ultra', run: async ({ input, selected }) => {
    await input('\r');
    assert.deepEqual(selected, ['ultra'], 'Animations off should apply immediately');
  }});
  await panel({ current: 'ultra', run: async ({ input, selected, actions }) => {
    await input('\x1b');
    assert.deepEqual(actions, ['back']);
    assert.deepEqual(selected, [], 'Escape should cancel pending Ultra selection');
  }});
  await panel({ run: async ({ input, selected }) => {
    await input('o');
    assert.deepEqual(selected, ['off']);
  }});
  await panel({ row: { ...deepseek, reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }] } }, run: async ({ frame, input, selected }) => {
    assert.match(frame(), /↑↓ choose/);
    await input('\r');
    assert.deepEqual(selected, ['high']);
  }});
  await panel({ rows: 12, run: async ({ frame }) => {
    assert.match(frame(), /low.*high.*max.*ultra/);
  }});
  for (const columns of [32, 80]) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    Object.assign(stdout, { columns, rows: 24, isTTY: true });
    const frames = [];
    stdout.on('data', data => frames.push(stripVTControlCharacters(data.toString())));
    const mounted = ui.render(ui.react.createElement(ui.DscodeUltraRipple, { columns }), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await tick(130);
      const frame = frames.filter(value => value.includes('ULTRA')).at(-1) ?? '';
      assert.match(frame, /✦ {2}ULTRA/);
      assert.equal(frame.split('\n').length, 3);
      for (const line of frame.split('\n')) assert(ui.visibleColumns(line) <= columns);
    } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  }
  const inert = snapshot => ({ subscribe: () => () => {}, getSnapshot: () => snapshot });
  // 1.2.0's view carries the pending inbox rows the live tree still owns.
  const view = { entries: [], pending: { 'next-turn': [], 'next-step': [] }, busy: false, streaming: '', streamingReasoning: '', busySince: 0, title: 'New session', stats: { usage: {}, contextWindow: 100000 }, permission: '', todos: [] };
  const modelActions = [];
  const props = {
    store: { subscribe: () => () => {}, getView: () => view },
    commands: { subscribe: () => () => {}, descriptors: [] },
    skills: { subscribe: () => () => {}, rows: [] },
    approval: inert({ pending: undefined }), questions: inert({ pending: undefined }),
    subagents: { ...inert([]), getTotalSeen: () => 0 },
    model: 'deepseek-official/deepseek-flash', effort: 'high', mode: 'default', permission: 'ask',
    cwd: 'dsh-code', workspaceRoot: '/workspace/dsh-code', branch: 'main', sessionId: 'fixture', sessionKey: 'fixture',
    history: [], recordHistory: () => {}, statusline: undefined, animations: true, resumed: false,
    loadModels: async () => { modelActions.push('load'); await tick(20); return { rows: [deepseek] }; }, selectModel: () => { modelActions.push('select'); return 'deepseek-official/deepseek-flash'; }, onBridgeReady: () => {},
  };
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: true });
  const frames = [], errors = [];
  stdout.on('data', data => frames.push(data.toString()));
  stderr.on('data', data => errors.push(data.toString()));
  const mounted = ui.render(ui.react.createElement(ui.App, props), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
  try {
    await tick(60);
    stdin.write('/effort'); await tick(40);
    assert(frames.some(value => value.includes('/effort')), 'Composer did not receive /effort');
    stdin.write('\r'); await tick(500);
    const selected = frames.map(value => stripVTControlCharacters(value)).filter(value => value.includes('Faster')).at(-1) ?? '';
    assert.match(selected, /Faster.*Smarter/, JSON.stringify(modelActions) + errors.join('') + '\n' + frames.slice(-2).map(value => stripVTControlCharacters(value)).join('\n'));
    assert(selected.indexOf('Faster') < selected.indexOf('deepseek-flash @ high'), 'Effort selector should sit above the footer');
    assert.match(selected, /○ New session\s*｜\s*ask/, 'row 1 keeps the title and the permission while the selector is open');
    assert(!selected.includes('steer into this turn'), 'Effort selector must replace the chat composer');
    stdin.write('\x1b'); await tick(60);
    const restored = frames.map(value => stripVTControlCharacters(value)).filter(value => value.includes('steer into this turn')).at(-1) ?? '';
    assert(restored, 'Esc should restore the chat composer');
    assert(!modelActions.includes('select'), 'Esc must not apply an effort');
    stdin.write('/effort'); await tick(40); stdin.write('\r'); await tick(80);
    stdin.write('\x1b[C'); await tick(30); stdin.write('\x1b[C'); await tick(30);
    assert(frames.some(value => stripVTControlCharacters(value).includes('✦  ULTRA')), 'Ultra focus should animate before Enter');
    assert.equal(modelActions.filter(action => action === 'select').length, 0);
    stdin.write('\r'); await tick(100);
    assert.equal(modelActions.filter(action => action === 'select').length, 1);
    assert(frames.some(value => stripVTControlCharacters(value).includes('✦  ULTRA')), 'Ultra should ripple over the composer after selection');
    await tick(1150);
    assert(frames.map(value => stripVTControlCharacters(value)).at(-1)?.includes('steer into this turn'), 'Composer should return after the Ultra ripple');
    // A `!` draft is a shell command: a round brand-coloured frame (never a filled band), the
    // bang leads the line, and Esc leaves the mode.
    const brandBright = ui.getPalette().brandBright;
    const blueBand = new RegExp(`\\x1b\\[48;2;${Array.isArray(brandBright) ? brandBright.join(';') : brandBright}m`);
    await tick(1300); // let the Ultra ripple finish before typing
    const draftBase = frames.length;
    stdin.write('!echo hi'); await tick(80);
    const draft = frames.slice(draftBase);
    const draftText = draft.map(stripVTControlCharacters);
    const shellFrame = [...draftText].reverse().find(value => value.includes('echo hi')) ?? '';
    const shellLine = shellFrame.split('\n').map(line => line.trimEnd()).find(line => line.includes('echo hi')) ?? '';
    assert(shellFrame, `the composer should hold the shell draft: ${JSON.stringify(draftText.map(value => value.slice(-40)))}`);
    assert.match(shellLine, /^│\s*!echo hi/, 'the round border opens the line and the bang leads it');
    assert(shellLine.endsWith('│'), 'the right border closes the framed composer');
    const shellRaw = [...draft].reverse().find(value => stripVTControlCharacters(value).includes('echo hi')) ?? '';
    const shellRawLine = shellRaw.split('\n').find(line => stripVTControlCharacters(line).includes('echo hi')) ?? '';
    const brandForeground = new RegExp(`\\x1b\\[38;2;${Array.isArray(brandBright) ? brandBright.join(';') : brandBright}m`);
    assert.match(shellRawLine, brandForeground, `the frame carries the brand colour: ${JSON.stringify(shellRawLine)}`);
    assert.doesNotMatch(shellRawLine, blueBand, 'the composer is framed, not filled with the brand colour');
    assert(draftText.some(value => /[╭╰]/.test(value)), 'the frame draws rounded corners around the draft');
    // The border replaces the band's two filler rows one-for-one; only the hint row is new, and
    // the composer reports it to the App's live-region budget.
    const frameRows = chunk => (chunk.match(/\n/g) ?? []).length;
    const idleRaw = [...frames.slice(0, draftBase)].reverse().find(value => value.includes('steer into this turn')) ?? '';
    assert.equal(frameRows(shellRaw), frameRows(idleRaw) + 1, 'the frame adds exactly the hint row, never a border row on top of the band');
    assert(draftText.some(value => value.includes('! shell mode · esc exits')), `the shell-mode hint should sit under the band: ${JSON.stringify(draftText.slice(-2).map(v => v.slice(-80)))}`);
    const hintRaw = [...draft].reverse().find(value => stripVTControlCharacters(value).includes('shell mode')) ?? '';
    const hintRawLine = hintRaw.split('\n').find(line => stripVTControlCharacters(line).includes('shell mode')) ?? '';
    assert.match(hintRawLine, new RegExp(`\\x1b\\[38;2;${Array.isArray(brandBright) ? brandBright.join(';') : brandBright}m`), 'the hint carries the brand colour as its foreground');
    assert.doesNotMatch(hintRawLine, /\x1b\[48;2;/, 'the hint sits below the band, not on its background');
    const escBase = frames.length;
    stdin.write('\x1b'); await tick(60);
    const after = frames.slice(escBase);
    const afterText = after.map(stripVTControlCharacters);
    const leftFrame = [...afterText].reverse().find(value => value.includes('echo hi')) ?? '';
    const leftLine = leftFrame.split('\n').map(line => line.trimEnd()).find(line => line.includes('echo hi')) ?? '';
    assert(!leftLine.includes('!'), 'Esc drops the bang and leaves shell mode');
    assert(!leftLine.startsWith('│') && !leftLine.endsWith('│'), 'Esc drops the frame with the mode');
    assert.match(leftLine, /echo hi$/, 'Esc keeps the command text editable');
    assert(!afterText.some(value => value.includes('! shell mode')), 'Esc removes the shell-mode hint with the band');
    const caretBase = frames.length;
    stdin.write('X'); await tick(60);
    const typed = frames.slice(caretBase).map(stripVTControlCharacters).reverse().find(value => value.includes('echo hiX')) ?? '';
    assert(typed, `Esc keeps the caret where the bang was: ${JSON.stringify(frames.slice(caretBase).map(v => stripVTControlCharacters(v).slice(-60)))}`);
    const leftRaw = [...after].reverse().find(value => stripVTControlCharacters(value).includes('echo hi')) ?? '';
    const leftRawLine = leftRaw.split('\n').find(line => stripVTControlCharacters(line).includes('echo hi')) ?? '';
    assert(!blueBand.test(leftRawLine), `the composer band returns to its quiet colour: ${JSON.stringify(leftRawLine)}`);
  } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  console.log('Effort bar passed: real Ink keyboard flow, Ultra commit/cancel, off, fallback, dark/light and 32–120 columns.');
} finally { rmSync(entry, { force: true }); }
