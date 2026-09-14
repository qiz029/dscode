import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { patchTui } from './patch-tui.mjs';
import { patchLogin } from './patch-login.mjs';
import { patchProvider } from './patch-provider.mjs';
import { providerArgument } from '../plugins/providers/catalog.mjs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
assert.equal(patchLogin(source), source);
assert.equal(patchProvider(source), source);
// Exercise the real command interception, including commands with attachments.
const start = source.indexOf('const expandedValue = expandLargePastes(liveValue, pendingPastesRef.current);');
assert(start >= 0, 'submission expansion anchor missing');
const end = source.indexOf('if (draftImagesRef.current.length > 0', start);
for (const [value, busy, expected] of [
  ['/login', false, 'login:current'], ['/login openrouter', false, 'login:openrouter'], ['/login DeepSeek', false, 'login:deepseek-official'],
  ['/login', true, 'notice'], ['/login synthetic-inline-key', false, 'notice'],
  ['/provider', false, 'provider:picker'], ['/provider openrouter', false, 'provider:openrouter'], ['/provider', true, 'notice'], ['/provider synthetic-inline-key', false, 'notice'],
]) {
  const calls = [];
  const noop = () => {};
  const handler = vm.runInNewContext(`() => { ${source.slice(start, end)} throw Error('fell through to transcript'); }`, {
    liveValue: value, expandLargePastes: v => v, pendingPastesRef: { current: new Map() }, submissionPayload: v => v, busy,
    valueRef: {}, cursorRef: {}, recall: {}, recallSpace: {}, beginRecall: noop,
    setValue: noop, setCursor: noop, setCompletionIndex: noop, setDismissedMenuValue: noop, dscodeProviderArgument: providerArgument,
    notify: message => { assert(!message.includes('synthetic-inline-key')); calls.push('notice'); },
    openLogin: target => calls.push('login:' + (target ?? 'current')), openProvider: target => calls.push('provider:' + (target ?? 'picker')),
  });
  handler(); assert.deepEqual(calls, [expected], value);
}
const entry = new URL(`node_modules/dsh-code/lib/.dscode-login-probe-${process.pid}.mjs`, root);
writeFileSync(entry, source + '\nexport { DscodeLoginPanel, DscodeProviderPanel, render, import_react as react };\n');
const tick = () => new Promise(resolve => setTimeout(resolve, 35));
async function mount(ui, element, run) {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  Object.assign(stdout, { columns: 80, rows: 24, isTTY: true });
  const frames = [];
  stdout.on('data', data => frames.push(data.toString()));
  stderr.on('data', data => frames.push(data.toString()));
  const instance = ui.render(element, { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
  try {
    await tick();
    await run({ input: async text => { stdin.write(text); await tick(); }, frames });
  } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
}
try {
  const ui = await import(entry.href);
  async function panel({ provider = 'deepseek-official', writable = true, fail = false, run }) {
    const saved = [], actions = [];
    await mount(ui, ui.react.createElement(ui.DscodeLoginPanel, {
      provider,
      load: async () => ({ rows: [{ provider, credential: { kind: 'facts', configured: false, writable } }] }),
      save: async (_target, key) => { saved.push(key); if (fail) throw Error(key); },
      done: () => actions.push('done'), back: () => actions.push('back'),
    }), async ({ input, frames }) => {
      await run({ input, saved, actions, frames });
      assert(!frames.join('').includes('synthetic-secret'), 'secret appeared in a rendered frame');
    });
  }
  await panel({ run: async ({ input, saved, actions, frames }) => {
    assert.match(frames.join(''), /DeepSeek login/);
    await input('\x1b[200~synthetic-secret-q123\x1b[201~');
    assert.match(frames.join(''), /••••••••/);
    assert.deepEqual(saved, []); // paste does not submit
    await input('\r');
    assert.deepEqual(saved, ['synthetic-secret-q123']); assert.deepEqual(actions, ['done']);
  }});
  await panel({ run: async ({ input, saved, actions }) => {
    await input('synthetic-secret'); await input('\x1b');
    assert.deepEqual(saved, []); assert.deepEqual(actions, ['back']);
  }});
  await panel({ fail: true, run: async ({ input, saved, actions, frames }) => {
    await input('synthetic-secret'); await input('\r');
    assert.equal(saved.length, 1); assert.deepEqual(actions, []);
    assert.match(frames.join(''), /Could not save/);
  }});
  await panel({ writable: false, run: async ({ input, saved, frames }) => {
    await input('synthetic-secret'); await input('\r');
    assert.deepEqual(saved, []); assert.match(frames.join(''), /DEEPSEEK_API_KEY is set by your environment/);
  }});
  await panel({ provider: 'openrouter', run: async ({ input, saved, actions, frames }) => {
    assert.match(frames.join(''), /OpenRouter login/);
    await input('synthetic-secret-or'); await input('\r');
    assert.deepEqual(saved, ['synthetic-secret-or']); assert.deepEqual(actions, ['done']);
  }});
  await panel({ provider: 'openrouter', writable: false, run: async ({ frames }) => {
    assert.match(frames.join(''), /OPENROUTER_API_KEY is set by your environment/);
  }});
  const directory = { rows: [
    { provider: 'deepseek-official', configured: true, credential: { kind: 'facts', configured: true, writable: true, source: 'file' } },
    { provider: 'openrouter', configured: false },
  ] };
  for (const [keys, expected] of [['\x1b[B\r', ['back', 'choose:openrouter']], ['\x1b[A\r', ['back', 'choose:openrouter']], ['\x1b[B\x1b[B\r', ['back', 'choose:deepseek-official']], ['\r', ['back', 'choose:deepseek-official']], ['\x1b', ['back']]]) {
    const actions = [];
    await mount(ui, ui.react.createElement(ui.DscodeProviderPanel, {
      current: 'deepseek-official', load: async () => directory,
      choose: id => actions.push('choose:' + id), back: () => actions.push('back'),
    }), async ({ input, frames }) => {
      const text = frames.join('');
      assert.match(text, /● DeepSeek\s+deepseek-official · key saved/);
      assert.match(text, /○ OpenRouter\s+openrouter · not set up/);
      for (const key of keys.match(/\x1b\[[AB]|\r|\x1b/g)) await input(key);
      assert.deepEqual(actions, expected, JSON.stringify(keys));
    });
  }
  console.log('Login and provider verified: native Ink paste/masking/save/cancel/errors/env override for DeepSeek and OpenRouter; /provider picker navigation; commands never reach history or model dispatch.');
} finally { rmSync(entry, { force: true }); }
