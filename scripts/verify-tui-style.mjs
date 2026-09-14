import assert from 'node:assert/strict';
process.env.DSCODE_LANGUAGE = 'en'; // the verifier asserts English strings regardless of the machine's saved language
import { WELCOME_ART, welcomeArtRows } from './patch-welcome.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchTui } from './patch-tui.mjs';
import { patchStyle } from './patch-style.mjs';
import { setMetricSource } from '../plugins/session-metrics/view.mjs';
import { appendMetric } from '../plugins/session-metrics/store.mjs';

const root = new URL('../', import.meta.url);
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
assert.equal(patchStyle(source), source);
const entry = new URL(`node_modules/dsh-code/lib/.dscode-style-probe-${process.pid}.mjs`, root);
// Use the actual bundled Ink renderer and theme, with a captured terminal.
writeFileSync(entry, source + '\nexport { Header, DscodeActivityLine, DSCODE_ORBIT, dscodeSpinnerCells, AgentsLine, getPalette, StatusLine, StyledRows, dscodeChatLines, Box, Text, render, import_react as react, setTheme, visibleColumns, dscodeActivity, dscodeTpsTone, dscodeTelemetryParts, dscodeTelemetryNodes, DEFAULT_STATUSLINE_ITEMS };\n');
const out = new URL('artifacts/local/tui-style/', root);
mkdirSync(out, { recursive: true });
const now = Date.now();
const metricHome = mkdtempSync(join(tmpdir(), 'dscode-tui-rate-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = metricHome;
appendMetric(metricHome, 'fixture', { kind: 'start', id: 'fixture-call', time: now - 12000 });
appendMetric(metricHome, 'fixture', { kind: 'end', id: 'fixture-call', time: now - 10000, cost: 0.0001, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0 } });
const clearMetricSource = setMetricSource(id => id === 'fixture' ? {
  currentTps: 28.4, used: 43, capacity: 100,
  events: [
    { type: 'turn/start', time: now - 10000, data: { turn: 1 } },
    { type: 'step/start', time: now - 10000, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', time: now - 5000, data: { turn: 1, step: 1, usage: { outputTokens: 20 } } },
    { type: 'turn/end', time: now, data: { turn: 1 } },
  ],
} : undefined);
const previousNoColor = process.env.NO_COLOR;
const previousForceColor = process.env.FORCE_COLOR;
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = '3';
try {
  const ui = await import(entry.href);
  const h = ui.react.createElement;
  assert.equal(ui.DSCODE_ORBIT.length, 8, 'Snowflake comet has eight orbit positions');
  const palette = ui.getPalette();
  const seen = new Set();
  for (let tick = 0; tick < 8; tick++) {
    const cells = ui.dscodeSpinnerCells(tick, palette);
    assert.equal(ui.visibleColumns(cells.left.text + '❄' + cells.right.text), 3, 'Spinner keeps a fixed width');
    const [side] = ui.DSCODE_ORBIT[tick];
    const other = side === 'right' ? 'left' : 'right';
    assert.notEqual(cells[side].text, ' ', 'the comet head is on the expected side');
    assert.deepEqual(cells[side].color, palette.brandMid);
    if (tick === 0 || tick === 4) { assert.notEqual(cells[other].text, ' ', 'a dim tail lingers across the crossing'); assert.deepEqual(cells[other].color, palette.dim); }
    else assert.equal(cells[other].text, ' ', 'no tail on the far side mid-orbit');
    seen.add(cells.left.text + '|' + cells.right.text);
  }
  assert.equal(seen.size, 8, 'Every frame differs');
  assert.deepEqual(ui.dscodeSpinnerCells(0, palette).flake, palette.brandBright, 'flake is brightest at the top of the orbit');
  assert.deepEqual(ui.dscodeSpinnerCells(4, palette).flake, palette.brandDeep, 'flake is deepest at the bottom of the orbit');
  assert.match(ui.dscodeActivity([], false), /^Thinking$/);
  assert.match(ui.dscodeActivity([], true), /^Replying$/);
  const tools = [{ kind: 'tool', state: 'running', name: 'shell', arguments: JSON.stringify({ command: 'secret command', description: '验证会话恢复行为' }) }];
  assert(!ui.dscodeActivity(tools, false).includes('secret command'));
  assert(!ui.DEFAULT_STATUSLINE_ITEMS.includes('tokens'));
  for (const [rate, tone] of [[0, 'yellow'], [74.9, 'yellow'], [75, 'green'], [149.9, 'green'], [150, 'blue'], [250, 'blue'], [250.1, 'purple'], [NaN, null], [-1, null]]) {
    assert.equal(ui.dscodeTpsTone(rate), tone);
  }
  assert.deepEqual(ui.dscodeTelemetryParts('current: ~74.9 tps | average: 150.0 tps | context: 43%'), [
    { text: 'current: ', tone: null }, { text: '~74.9 tps', tone: 'yellow' },
    { text: ' | ', tone: null }, { text: 'average: ', tone: null }, { text: '150.0 tps', tone: 'blue' },
    { text: ' | ', tone: null }, { text: 'context: 43%', tone: null },
  ]);
  assert.deepEqual(ui.dscodeTelemetryParts('average: 100.0 tps | cache hit: 91.2%').at(-1), { text: '91.2%', tone: 'yellow' }, 'a cache hit rate is tinted by tier');
  assert.deepEqual(ui.dscodeTelemetryParts('average: 100.0 tps | context: 43%').at(-1), { text: 'context: 43%', tone: null }, 'a bare percentage is not mistaken for the cache');
  assert.equal(ui.dscodeTelemetryParts('current: -- tps | average: -- tps').filter(part => part.text.endsWith(' tps')).every(part => part.tone === null), true);
  const agents = [
    { label: '消息队列测试', state: 'running', activity: 'tool shell', updatedAt: 3 },
    { label: '检查取消行为', state: 'idle', activity: 'waiting', updatedAt: 4 },
    { label: '检查写锁', state: 'done', activity: 'finished', updatedAt: 2 },
  ];
  for (const theme of ['dark', 'light']) for (const columns of [32, 48, 60, 64, 80, 120]) {
    ui.setTheme(theme);
    const userRows = ui.dscodeChatLines({ kind: 'user', text: '请检查这段用户输入的背景。\n第二行继续。', notice: false }, columns - 2);
    assert(userRows.length >= 3, 'three rows: two content rows and the blank one under the prompt');
    assert.deepEqual(userRows.at(-1).segments, [], 'the prompt block closes with one blank row');
    assert(userRows.slice(0, -1).every(row => row.background === 'user' && row.segments.reduce((width, segment) => width + ui.visibleColumns(segment.text), 0) === columns - 2));
    assert.equal(ui.dscodeChatLines({ kind: 'user', text: 'system notice', notice: true }, columns - 2)[0].background, undefined);
    const stdout = new PassThrough();
    Object.assign(stdout, { columns, rows: 30, isTTY: true });
    const frames = [];
    stdout.on('data', data => frames.push(data.toString()));
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const errors = [];
    stderr.on('data', data => errors.push(data.toString()));
    const app = h(ui.Box, { flexDirection: 'column' },
      h(ui.Header, { cwd: '/workspace/dsh-code', model: 'deepseek-official/deepseek-flash', effort: 'ultra' }),
      h(ui.StyledRows, { lines: userRows }),
      h(ui.Box, { paddingX: 2, marginBottom: 1 }, h(ui.Text, null, '已完成队列投递，正在验证中断后的恢复行为。')),
      h(ui.DscodeActivityLine, { entries: tools, since: Date.now() - 24000, animated: false }),
      h(ui.AgentsLine, { rows: agents, total: 3 }),
      h(ui.Box, { paddingX: 2, marginY: 1 }, h(ui.Text, null, '› 接下来把取消行为也检查一下')),
      h(ui.StatusLine, { facts: { model: 'deepseek-official/deepseek-flash', effort: 'ultra', cwd: '/workspace/dsh-code', branch: 'main', sessionId: 'fixture', fullSessionId: 'fixture', title: 'Session 间消息投递', permission: 'auto' }, stats: { usage: {}, contextWindow: 100000 }, busy: true, columns }));
    const mounted = ui.render(app, { stdout, stderr, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      const frame = frames.filter(frame => frame.includes('DSCODE')).at(-1);
      assert(frame, `No rendered frame: ${theme} ${columns}: ${errors.join('')}`);
      const plain = stripVTControlCharacters(frame);
      assert.match(plain, /DSCODE/);
      assert(plain.includes('请检查'));
      assert.match(frame, new RegExp(`\\x1b\\[48;2;${theme === 'light' ? '229;231;235' : '46;48;52'}m`));
      assert(plain.includes(`v${version}`));
      assert.match(plain, /deepseek-flash/);
      assert.match(plain, /\/workspace\/dsh-code/);
      if (columns >= 64) {
        assert.match(plain, /────────────/);
        const art = plain.split('\n').filter(line => /[▀▄█]/.test(line));
        assert.equal(art.length, 12, `Welcome snowflake rows: ${art.length}`);
        const expected = welcomeArtRows(WELCOME_ART, { 1: 'a', 2: 'b', 3: 'c' }).map(segments => segments.map(segment => segment.text).join('').trimEnd());
        expected.forEach((row, index) => assert(art[index].includes(row), `Snowflake row ${index} drift: ${art[index]}`));
        assert.match(frame, /\x1b\[48;2;\d+;\d+;\d+m▀/, 'Two-tone half blocks should carry a background colour');
      } else assert.match(plain, /❄ DSCODE/);
      assert(!plain.includes('Deep diving'));
      assert(!plain.includes('⠋'), 'Braille spinner should be gone');
      assert.match(plain, columns >= 64 ? /❄  Running · shell/ : /❄  Runn/, 'Static snowflake leads the activity line (English by default)');
      if (columns >= 64) assert.match(plain, /Esc to interrupt/); else assert(!plain.includes('Esc to interrupt'), 'the interrupt hint yields to the label on narrow terminals');
      assert.match(plain, /this turn/, 'activity suffix is localized');
      assert(!plain.includes('secret command'));
      assert.match(plain, /ultra/);
      if (columns >= 80) {
        assert.match(plain, /1 running · 1 idle · 1 done/);
        assert.match(plain, /消息队列测试/);
      }
      if (columns < 48) {
        assert(!plain.includes('context: '), 'the telemetry row needs 48 columns');
        assert(!plain.includes('deepseek-flash @ ultra'), 'no telemetry row on very narrow terminals');
      }
      assert.match(plain, /● Session 间消息投递\s*｜\s*auto/, 'row 1 leads with the session title and the permission badge');
      assert(!plain.includes('● deepseek-flash'), 'the model must not stay on row 1');
      const telemetry = plain.split('\n').find(line => line.includes('deepseek-flash @ ultra'));
      if (columns >= 48) assert(telemetry, 'the model leads the footer telemetry row');
      if (columns >= 48 && columns <= 64) assert.match(telemetry, /deepseek-flash @ ultra \| \$0\.00 \/ \$--/, 'a narrow telemetry row keeps the model and the money');
      if (columns === 80) assert.match(telemetry, /deepseek-flash @ ultra \| context: 43% \| \$0\.00 \/ \$--/, 'context returns before the rates');
      if (columns >= 120) assert.match(telemetry, /deepseek-flash @ ultra \| current: ~28\.4 tps \| context: 43% \| \$0\.00 \/ \$--/, 'a wide terminal adds the current rate');
      if (columns >= 48) assert(!telemetry.includes('average: '), 'the provider form and the average stay out until the terminal can afford them');
      if (columns === 120) {
        const yellow = theme === 'light' ? '180;83;9' : '245;158;11';
        assert.match(frame, new RegExp(`\\x1b\\[38;2;${yellow}m~28\\.4 tps`));
      }
      for (const line of plain.split('\n')) assert(ui.visibleColumns(line) <= columns, `Overflow ${theme} ${columns}: ${line}`);
      writeFileSync(new URL(`${theme}-${columns}.ansi`, out), frame);
      writeFileSync(new URL(`${theme}-${columns}.txt`, out), plain);
    } finally { mounted.unmount(); mounted.cleanup(); stdout.destroy(); stdin.destroy(); stderr.destroy(); }
  }
  for (const theme of ['dark', 'light']) {
    ui.setTheme(theme);
    const colors = theme === 'light'
      ? { yellow: '180;83;9', green: '21;128;61', blue: '72;104;178', purple: '126;34;206' }
      : { yellow: '245;158;11', green: '34;197;94', blue: '103;158;254', purple: '192;132;252' };
    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 120, rows: 8, isTTY: true });
    const frames = [];
    stdout.on('data', data => frames.push(data.toString()));
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    const app = h(ui.Box, { flexDirection: 'column' },
      h(ui.Text, null, ...ui.dscodeTelemetryNodes('current: ~74.9 tps | average: 75.0 tps', 'probe-a')),
      h(ui.Text, null, ...ui.dscodeTelemetryNodes('current: ~250.0 tps | average: 250.1 tps', 'probe-b')));
    const mounted = ui.render(app, { stdout, stderr, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      const frame = frames.filter(chunk => chunk.includes('current:')).at(-1);
      assert(frame, `No TPS color frame: ${theme}`);
      for (const [color, value] of [['yellow', '~74.9'], ['green', '75.0'], ['blue', '~250.0'], ['purple', '250.1']]) {
        assert.match(frame, new RegExp(`\\x1b\\[38;2;${colors[color]}m${value.replace('.', '\\.')} tps`));
      }
    } finally { mounted.unmount(); mounted.cleanup(); stdout.destroy(); stdin.destroy(); stderr.destroy(); }
  }
  console.log('TUI render passed: dark/light × 32/48/60/64/80/120 columns; real Ink frames in artifacts/local/tui-style.');
} finally {
  clearMetricSource();
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor;
  if (previousForceColor === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previousForceColor;
  rmSync(metricHome, { recursive: true, force: true });
  rmSync(entry, { force: true });
}
