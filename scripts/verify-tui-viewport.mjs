import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { patchTui } from './patch-tui.mjs';

const root = new URL('../', import.meta.url);
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version;
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
assert(source.includes('height: Math.max(1, terminalRows - 1)'));
assert(source.includes('process.stdout.isTTY === true) process.stdout.write("\\x1B[r\\x1B[0m\\x1B[H\\x1B[2J\\x1B[3J\\x1B[H")'));
const entry = new URL(`node_modules/dsh-code/lib/.dscode-viewport-probe-${process.pid}.mjs`, root);
writeFileSync(entry, source + '\nexport { App, Box, render, import_react as react, visibleSettledLines, welcomePath };\n');
try {
  const ui = await import(entry.href);
  const rows = ui.visibleSettledLines(['a', 'b', 'c'], 3, 2, 80, false, value => [{ segments: [{ text: value }] }]);
  assert.deepEqual(rows.map(row => row.segments[0].text), ['b', 'c']);
  assert.equal(ui.welcomePath('/very-long-parent/second/project', 17), '…/second/project');
  const inert = snapshot => ({ subscribe: () => () => {}, getSnapshot: () => snapshot });
  const view = { entries: [], busy: false, streaming: '', streamingReasoning: '', busySince: 0, title: 'New session', stats: { usage: {}, contextWindow: 100000 }, permission: '', todos: [] };
  const props = {
    store: { subscribe: () => () => {}, getView: () => view },
    commands: { subscribe: () => () => {}, descriptors: [] },
    skills: { subscribe: () => () => {}, rows: [] },
    approval: inert({ pending: undefined }),
    questions: inert({ pending: undefined }),
    subagents: { ...inert([]), getTotalSeen: () => 0 },
    model: 'deepseek/deepseek-chat', effort: 'high', mode: 'default', permission: 'ask',
    cwd: 'dsh-code', workspaceRoot: '/workspace/dsh-code', branch: 'main', sessionId: 'fixture', sessionKey: 'fixture',
    history: [], statusline: undefined, animations: false, resumed: false,
    loadModels: async () => ({ rows: [] }), onBridgeReady: () => {},
  };
  for (const height of [8, 12, 16, 21, 22, 24, 40]) for (const state of ['empty', 'settled', 'streaming']) {
    view.entries = state === 'empty' ? [] : Array.from({ length: 30 }, (_, index) => ({ kind: 'assistant', text: `Reply number ${index + 1}`, reasoning: '' }));
    view.busy = state === 'streaming';
    view.streaming = state === 'streaming' ? 'A live answer stays above the composer.' : '';
    view.busySince = view.busy ? Date.now() - 1000 : 0;
    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 80, rows: height, isTTY: true });
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const frames = [];
    const errors = [];
    stdout.on('data', data => frames.push(data.toString()));
    stderr.on('data', data => errors.push(data.toString()));
    const mounted = ui.render(ui.react.createElement(ui.App, props), { stdout, stderr, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      const frame = stripVTControlCharacters(frames.at(-1) ?? '');
      const lines = frame.split('\n');
      const inputIndex = lines.findIndex(line => line.includes('type a message') || line.trim() === '›');
      assert(inputIndex >= 0, `Missing input at ${height} rows: ${frame}\n${errors.join('')}`);
      assert.equal(lines.length, height - 1, `Frame height at ${height} rows`);
      assert(inputIndex >= height - 6, `Composer drifted above bottom at ${height} rows: ${inputIndex}`);
      const headerVisible = state === 'empty' || height <= 12;
      if (headerVisible) assert(lines.some(line => line.includes('DSCODE')), `Missing welcome content at ${height} rows: ${frame}`);
      else assert(!lines.some(line => line.includes('DSCODE')), `Welcome remained pinned above conversation at ${height} rows: ${frame}`);
      if (headerVisible && height >= 10) {
        assert(frame.includes(`v${version}`), `Missing DSCODE version at ${height} rows`);
        assert(frame.includes('deepseek-chat'), `Missing model at ${height} rows`);
        assert(frame.includes('high'), `Missing effort at ${height} rows`);
        assert(frame.includes('/workspace/dsh-code'), `Missing project path at ${height} rows`);
      }
      if (state === 'settled' && height >= 24) {
        assert(frame.includes('Reply number 30'), `Newest settled reply missing at ${height} rows`);
        if (height <= 24) assert(!/Reply number 1(?!\d)/.test(frame), `Old reply overflowed viewport at ${height} rows`);
      }
    } finally { mounted.unmount(); mounted.cleanup(); stdout.destroy(); stderr.destroy(); stdin.destroy(); }
  }
  const artworkRows = [];
  for (const count of [0, 8, 11, 30]) {
    view.entries = Array.from({ length: count }, (_, index) => ({ kind: 'assistant', text: `Reply number ${index + 1}`, reasoning: '' }));
    view.busy = false;
    view.streaming = '';
    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 80, rows: 30, isTTY: true });
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const frames = [];
    stdout.on('data', data => frames.push(data.toString()));
    const mounted = ui.render(ui.react.createElement(ui.App, props), { stdout, stderr, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      const frame = stripVTControlCharacters(frames.filter(chunk => chunk.includes('type a message')).at(-1) ?? '');
      assert(frame.includes('type a message'), `Missing composer with ${count} replies`);
      if (count) assert(frame.includes(`Reply number ${count}`), `Newest reply missing with ${count} replies`);
      artworkRows.push(frame.split('\n').filter(line => /[█▄▀╭╰]/.test(line)).length);
    } finally { mounted.unmount(); mounted.cleanup(); stdout.destroy(); stderr.destroy(); stdin.destroy(); }
  }
  assert(artworkRows[0] > artworkRows[1] && artworkRows[1] > artworkRows[2] && artworkRows[2] > artworkRows[3], `Welcome did not scroll upward row by row: ${artworkRows}`);
  assert.equal(artworkRows[3], 0);
  console.log('TUI viewport passed: welcome scrolls off with conversation, bounded history and bottom composer at 8/12/16/21/22/24/40 rows.');
} finally { rmSync(entry, { force: true }); }
