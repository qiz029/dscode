import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { patchTui } from './patch-tui.mjs';
import { patchStyle } from './patch-style.mjs';

const root = new URL('../', import.meta.url);
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
assert.equal(patchStyle(source), source);
const entry = new URL(`node_modules/dsh-code/lib/.dscode-style-probe-${process.pid}.mjs`, root);
// Use the actual bundled Ink renderer and theme, with a captured terminal.
writeFileSync(entry, source + '\nexport { Header, DscodeActivityLine, AgentsLine, StatusLine, Box, Text, render, import_react as react, setTheme, visibleColumns, dscodeActivity, DEFAULT_STATUSLINE_ITEMS };\n');
const out = new URL('artifacts/local/tui-style/', root);
mkdirSync(out, { recursive: true });
try {
  const ui = await import(entry.href);
  const h = ui.react.createElement;
  assert.match(ui.dscodeActivity([], false), /正在思考/);
  assert.match(ui.dscodeActivity([], true), /正在回复/);
  const tools = [{ kind: 'tool', state: 'running', name: 'shell', arguments: JSON.stringify({ command: 'secret command', description: '验证会话恢复行为' }) }];
  assert(!ui.dscodeActivity(tools, false).includes('secret command'));
  assert(!ui.DEFAULT_STATUSLINE_ITEMS.includes('tokens'));
  const agents = [
    { label: '消息队列测试', state: 'running', activity: 'tool shell', updatedAt: 3 },
    { label: '检查取消行为', state: 'idle', activity: 'waiting', updatedAt: 4 },
    { label: '检查写锁', state: 'done', activity: 'finished', updatedAt: 2 },
  ];
  for (const theme of ['dark', 'light']) for (const columns of [32, 48, 60, 64, 80, 120]) {
    ui.setTheme(theme);
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
      h(ui.Box, { paddingX: 2, marginBottom: 1 }, h(ui.Text, null, '已完成队列投递，正在验证中断后的恢复行为。')),
      h(ui.DscodeActivityLine, { entries: tools, since: Date.now() - 24000, animated: false }),
      h(ui.AgentsLine, { rows: agents, total: 3 }),
      h(ui.Box, { paddingX: 2, marginY: 1 }, h(ui.Text, null, '› 接下来把取消行为也检查一下')),
      h(ui.StatusLine, { facts: { model: 'deepseek-official/deepseek-flash', effort: 'ultra', cwd: '/workspace/dsh-code', branch: 'main', sessionId: 'fixture', title: 'Session 间消息投递', permission: 'auto' }, stats: { usage: {}, contextWindow: 100000 }, busy: true, columns }));
    const mounted = ui.render(app, { stdout, stderr, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      const frame = frames.filter(frame => frame.includes('DSCODE')).at(-1);
      assert(frame, `No rendered frame: ${theme} ${columns}: ${errors.join('')}`);
      const plain = stripVTControlCharacters(frame);
      assert.match(plain, /DSCODE/);
      assert(plain.includes(`v${version}`));
      assert.match(plain, /deepseek-flash/);
      assert.match(plain, /\/workspace\/dsh-code/);
      if (columns >= 64) {
        assert.match(plain, /────────────/);
        assert.match(plain, /█▄▄█  █▄█▄█  █▄▄█/);
        assert.match(plain, /          ▄███▄/);
        assert.match(plain, /          ▀███▀/);
        assert(plain.indexOf('          ▄███▄') < plain.indexOf('          ▀███▀'));
        assert.match(plain, /█▀▀█  █▀█▀█  █▀▀█/);
      } else assert.match(plain, /❄ DSCODE/);
      assert(!plain.includes('Deep diving'));
      assert(!plain.includes('secret command'));
      assert.match(plain, /ultra/);
      if (columns >= 80) {
        assert.match(plain, /1 running · 1 idle · 1 done/);
        assert.match(plain, /消息队列测试/);
      }
      if (columns < 64) assert(!plain.includes('ctx '));
      for (const line of plain.split('\n')) assert(ui.visibleColumns(line) <= columns, `Overflow ${theme} ${columns}: ${line}`);
      writeFileSync(new URL(`${theme}-${columns}.ansi`, out), frame);
      writeFileSync(new URL(`${theme}-${columns}.txt`, out), plain);
    } finally { mounted.unmount(); mounted.cleanup(); stdout.destroy(); stdin.destroy(); stderr.destroy(); }
  }
  console.log('TUI render passed: dark/light × 32/48/60/64/80/120 columns; real Ink frames in artifacts/local/tui-style.');
} finally { rmSync(entry, { force: true }); }
