process.env.DSCODE_UPDATE_CHECK = 'off'; // rendering never performs the startup registry read
import assert from 'node:assert/strict';
process.env.DSCODE_LANGUAGE = 'en';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { patchTui } from './patch-tui.mjs';

const root = new URL('../', import.meta.url);
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');

// Mode A: history is printed once into the terminal's own scrollback, so scrolling,
// selection and copy all stay the terminal's job and the app never captures the mouse.
assert(source.includes('MemoStaticTranscript'), 'settled history must ride Ink Static');
assert(!source.includes('DSCODE_MOUSE_ENABLE'), 'the TUI must not enable mouse capture');
assert(!source.includes('height: Math.max(1, terminalRows - 1)'), 'the TUI must not draw a full-screen frame');
assert(!source.includes('function dscodeQueueWheel('), 'the TUI must not queue wheel reports');

const entry = new URL(`node_modules/dsh-code/lib/.dscode-scrollback-probe-${process.pid}.mjs`, root);
writeFileSync(entry, source + '\nexport { App, Box, render, import_react as react };\n');
try {
  const ui = await import(entry.href);
  const inert = snapshot => ({ subscribe: () => () => {}, getSnapshot: () => snapshot });
  // 1.2.0's view carries the pending inbox rows the live tree still owns.
  const view = { entries: [], pending: { 'next-turn': [], 'next-step': [] }, busy: false, streaming: '', streamingReasoning: '', busySince: 0, title: 'New session', stats: { usage: {}, contextWindow: 100000 }, permission: '', todos: [] };
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
  const settle = () => new Promise(resolve => setTimeout(resolve, 80));
  const render = async entries => {
    view.entries = entries;
    const stdout = new PassThrough();
    Object.assign(stdout, { columns: 80, rows: 24, isTTY: true });
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    const chunks = [];
    stdout.on('data', data => chunks.push(data.toString()));
    const mounted = ui.render(ui.react.createElement(ui.App, props), { stdout, stderr, stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await settle();
      return { raw: chunks.join(''), plain: stripVTControlCharacters(chunks.join('')) };
    } finally { mounted.unmount(); mounted.cleanup(); stdout.destroy(); stdin.destroy(); stderr.destroy(); }
  };

  const settled = await render([
    { kind: 'user', text: 'first prompt', notice: false },
    { kind: 'assistant', text: 'Reply number 1', reasoning: '', turnEnded: true },
  ]);
  assert(settled.plain.includes('first prompt') && settled.plain.includes('Reply number 1'), 'settled history must be written to the scrollback stream');
  assert(settled.plain.includes('─'.repeat(8)), 'a finished turn keeps its rule');
  assert(settled.plain.includes('type a message'), 'the composer stays under the history');
  assert(!settled.raw.includes('\x1b[?1000h'), 'no mouse capture may be enabled');

  view.busy = true;
  view.streamingReasoning = 'LIVE_THINKING_TAIL';
  view.streaming = 'live answer';
  const live = await render([{ kind: 'user', text: 'first prompt', notice: false }]);
  assert(live.plain.includes('LIVE_THINKING_TAIL') || live.plain.includes('live answer'), 'the live stream must render below the history');
  assert(!live.raw.includes('\x1b[?1000h'), 'no mouse capture while streaming');
  console.log('TUI scrollback passed: Ink Static history, per-turn rule, no mouse capture, composer and live tails intact.');
} finally { rmSync(entry, { force: true }); }
