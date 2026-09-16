process.env.DSCODE_UPDATE_CHECK = 'off'; // rendering never performs the startup registry read
process.env.DSCODE_LANGUAGE = 'en';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { patchTui } from './patch-tui.mjs';

// Does the composer ride the output downward until it reaches the bottom, or does it drift
// back up? Ink erases the previous dynamic frame and rewrites the new one, so a frame that
// SHRINKS leaves the composer higher on the screen. This probe replays every write Ink makes
// through a small ANSI screen model and records the composer's screen row after each render.
const root = new URL('../', import.meta.url);
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
const entry = new URL(`node_modules/dsh-code/lib/.dscode-scroll-probe-${process.pid}.mjs`, root);
// Diagnose the budget the App actually computed for this frame (probe-local instrumentation).
const instrumented = source.replace('const liveAudit = clampLiveAllocation({',
  'globalThis.__dscodeLive = { dynamicRows, liveBudget, streamRows, reasoningRows, answerRows, visible: visibleLiveLines.length, composerRows, statusBarRows };\n\tconst liveAudit = clampLiveAllocation({');
assert(instrumented !== source, 'the live-budget hook must bind');
writeFileSync(entry, instrumented + '\nexport { App, render, import_react as react };\n');

class Screen {
  constructor(rows, columns) {
    this.rows = rows; this.columns = columns;
    this.lines = Array.from({ length: rows }, () => []);
    this.row = 0; this.column = 0;
  }
  scroll() { this.lines.shift(); this.lines.push([]); }
  newline() { if (this.row === this.rows - 1) this.scroll(); else this.row += 1; this.column = 0; }
  put(text) {
    const line = this.lines[this.row];
    for (const character of text) {
      while (line.length < this.column) line.push(' ');
      line[this.column] = character;
      this.column += 1;
    }
  }
  erase(bounds) { const line = this.lines[this.row]; if (bounds === 2) line.length = 0; else line.length = Math.min(line.length, this.column); }
  write(data) {
    for (let index = 0; index < data.length; index += 1) {
      const character = data[index];
      if (character === '\x1b') {
        const next = data[index + 1];
        if (next === ']') { const end = data.indexOf('\x07', index); index = end < 0 ? data.length : end; continue; }
        if (next !== '[') { index += 1; continue; }
        const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(data.slice(index));
        if (match === null) { index += 1; continue; }
        index += match[0].length - 1;
        const params = match[1].replace('?', '').split(';').filter(part => part !== '').map(Number);
        const count = params[0] === undefined || Number.isNaN(params[0]) ? 1 : params[0];
        switch (match[2]) {
          case 'A': this.row = Math.max(0, this.row - count); break;
          case 'B': this.row = Math.min(this.rows - 1, this.row + count); break;
          case 'C': this.column += count; break;
          case 'D': this.column = Math.max(0, this.column - count); break;
          case 'G': this.column = Math.max(0, count - 1); break;
          case 'H': case 'f': this.row = Math.max(0, (params[0] ?? 1) - 1); this.column = Math.max(0, (params[1] ?? 1) - 1); break;
          case 'J': if (count === 2 || count === 3) this.lines = Array.from({ length: this.rows }, () => []); else this.lines.slice(this.row).forEach(line => { line.length = 0; }); break;
          case 'K': this.erase(count); break;
          default: break;
        }
        continue;
      }
      if (character === '\r') { this.column = 0; continue; }
      if (character === '\n') { this.newline(); continue; }
      if (character === '\t') { this.column += 8 - (this.column % 8); continue; }
      this.put(character);
    }
  }
  rowOf(needle) { return this.lines.findIndex(line => line.join('').includes(needle)); }
  tail() { return this.lines.map(line => line.join('').trimEnd()).slice(-6); }
}

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));
try {
  const ui = await import(entry.href);
  const inert = snapshot => ({ subscribe: () => () => {}, getSnapshot: () => snapshot });
  const view = { entries: [], pending: { 'next-turn': [], 'next-step': [] }, busy: false, streaming: '', streamingReasoning: '', busySince: 0, title: 'New session', stats: { usage: {}, contextWindow: 100000 }, permission: '', todos: [] };
  const listeners = new Set();
  let snapshot = { ...view };
  const store = { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, getView: () => snapshot };
  // The projection is a cached snapshot: a new identity per emit, the same one between them.
  const emit = () => { snapshot = { ...view }; for (const listener of [...listeners]) listener(); };
  const props = {
    store, commands: { subscribe: () => () => {}, descriptors: [] }, skills: { subscribe: () => () => {}, rows: [] },
    approval: inert({ pending: undefined }), questions: inert({ pending: undefined }), subagents: { ...inert([]), getTotalSeen: () => 0 },
    model: 'deepseek/deepseek-chat', effort: 'high', mode: 'default', permission: 'ask',
    cwd: 'dsh-code', workspaceRoot: '/workspace/dsh-code', branch: 'main', sessionId: 'fixture', sessionKey: 'fixture',
    history: [], statusline: undefined, animations: false, resumed: false,
    loadModels: async () => ({ rows: [] }), onBridgeReady: () => {},
  };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const rows = 24, columns = 80;
  const stream = new PassThrough();
  const screen = new Screen(rows, columns);
  let stepWrites = [];
  stream.on('data', data => { const text = data.toString(); stepWrites.push(text); screen.write(text); });
  Object.assign(stream, { columns, rows, isTTY: true });
  const stdin = new PassThrough(); Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stderr = new PassThrough();
  const mounted = ui.render(ui.react.createElement(ui.App, props), { stdin, stdout: stream, stderr, debug: false, patchConsole: false, exitOnCtrlC: false });
  try {
    await tick(120);
    const trace = [];
    // The composer hides its placeholder while a turn runs, so the status bar (always present,
    // directly under the composer) is the stable proxy for the bottom chrome.
    const dump = label => { if (process.env.DSCODE_DUMP === label) console.log('--- ' + label + ' ---\n' + screen.lines.map((line, index) => String(index).padStart(2) + '|' + line.join('')).join('\n')); };
    const record = label => {
      const clears = stepWrites.filter(text => text.includes('\x1b[3J')).length;
      const frames = stepWrites.filter(text => text.includes('@ high') && !text.includes('\x1b[3J'));
      const height = frames.length === 0 ? 0 : Math.max(...frames.map(text => (text.match(/\n/g) ?? []).length));
      if (warnings.length > 0) { originalWarn('WARN ' + warnings.join(' | ')); warnings.length = 0; }
      if (process.env.DSCODE_LIVE === '1') originalWarn('LIVE ' + label + ' ' + JSON.stringify(globalThis.__dscodeLive));
      trace.push(`${label}:composer=${screen.rowOf('steer into this turn')},status=${screen.rowOf('@ high')},frame=${height},clears=${clears}`);
      stepWrites = [];
      dump(label);
    };
    record('mount');
    const assistant = (text, turnEnded = true) => ({ kind: 'assistant', text, reasoning: '', turnEnded });
    // Fixed-height chrome must not float: each appended settled turn pushes the composer down.
    for (let turn = 1; turn <= 4; turn += 1) {
      view.entries = [...view.entries, { kind: 'user', text: `prompt ${turn}`, notice: false }, assistant(`reply ${turn}\n` + `line ${turn}\n`.repeat(turn))];
      emit(); await tick(90);
      record(`settle${turn}`);
    }
    // A long streaming answer grows the live region; the composer must keep moving down or hold.
    view.busy = true;
    // Prose, like a real answer: the live tail and the settled markdown wrap the same text.
    const sentence = index => `Sentence ${index} ` + 'the quick brown fox jumps over the lazy dog while streaming output keeps arriving '.repeat(2);
    for (let chunk = 1; chunk <= 12; chunk += 1) {
      view.streaming = Array.from({ length: chunk }, (_, index) => sentence(index + 1)).join('\n\n');
      emit(); await tick(60);
      record(`stream${chunk}`);
    }
    // The answer settles: live rows shrink while the same rows land in the scrollback.
    // The settled entry carries the SAME text the tail streamed, like a real turn.
    view.entries = [...view.entries, assistant(view.streaming)];
    view.streaming = ''; view.busy = false;
    emit(); await tick(120);
    record('afterSettle');
    // Ink rewrites the whole screen (and its scrollback) once the dynamic frame reaches the
    // terminal height; that is what snaps the composer back up.
    assert(trace.every(item => !/clears=[1-9]/.test(item)), `the dynamic frame must stay under the terminal height: ${trace.join(' ')}`);
    // A shell draft frames the composer and adds its hint row; the budget must absorb both.
    stdin.write('!ls'); await tick(120);
    record('shellDraft');
    const numbers = trace.map(item => Number(/status=(-?\d+)/.exec(item)[1]));
    assert(!numbers.includes(-1), `the composer must stay on screen: ${trace.join(' ')}`);
    for (let index = 1; index < numbers.length; index += 1) {
      assert(numbers[index] >= numbers[index - 1], `the composer drifted back up: ${trace.join(' ')}\n${screen.tail().join('\n')}`);
    }
    console.log('TUI scroll passed: the composer is pushed down by output and never drifts back up · ' + trace.join(' '));
  } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stream.destroy(); stderr.destroy(); }
} finally { rmSync(entry, { force: true }); }
