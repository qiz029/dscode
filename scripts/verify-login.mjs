import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { patchTui } from './patch-tui.mjs';
import { patchLogin } from './patch-login.mjs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
assert.equal(patchLogin(source), source);
// Exercise the real command interception, including commands with attachments.
const start = source.indexOf('const expandedValue = expandLargePastes(liveValue, pendingPastesRef.current);');
assert(start >= 0, 'submission expansion anchor missing');
const end = source.indexOf('if (draftImagesRef.current.length > 0', start);
for (const [value, busy, expected] of [['/login', false, 'open'], ['/login', true, 'notice'], ['/login synthetic-inline-key', false, 'notice']]) {
  const calls = [];
  const noop = () => {};
  const handler = vm.runInNewContext(`() => { ${source.slice(start, end)} throw Error('fell through to transcript'); }`, {
    liveValue: value, expandLargePastes: v => v, pendingPastesRef: { current: new Map() }, submissionPayload: v => v, busy,
    valueRef: {}, cursorRef: {}, recall: {}, recallSpace: {}, beginRecall: noop,
    setValue: noop, setCursor: noop, setCompletionIndex: noop, setDismissedMenuValue: noop,
    notify: message => { assert(!message.includes('synthetic-inline-key')); calls.push('notice'); }, openLogin: () => calls.push('open'),
  });
  handler(); assert.deepEqual(calls, [expected]);
}
const entry = new URL(`node_modules/dsh-code/lib/.dscode-login-probe-${process.pid}.mjs`, root);
writeFileSync(entry, source + '\nexport { DscodeLoginPanel, render, import_react as react };\n');
const tick = () => new Promise(resolve => setTimeout(resolve, 35));
try {
  const ui = await import(entry.href);
  async function panel({ writable = true, fail = false, run }) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    Object.assign(stdout, { columns: 80, rows: 24, isTTY: true });
    const frames = [], saved = [], actions = [];
    stdout.on('data', data => frames.push(data.toString()));
    stderr.on('data', data => frames.push(data.toString()));
    const instance = ui.render(ui.react.createElement(ui.DscodeLoginPanel, {
      load: async () => ({ rows: [{ provider: 'deepseek-official', credential: { kind: 'facts', configured: false, writable } }] }),
      save: async (_target, key) => { saved.push(key); if (fail) throw Error(key); },
      done: () => actions.push('done'), back: () => actions.push('back'),
    }), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
    try {
      await tick();
      await run({ input: async text => { stdin.write(text); await tick(); }, saved, actions, frames });
      assert(!frames.join('').includes('synthetic-secret'), 'secret appeared in a rendered frame');
    } finally { instance.unmount(); instance.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  }
  await panel({ run: async ({ input, saved, actions, frames }) => {
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
    assert.deepEqual(saved, []); assert.match(frames.join(''), /environment/);
  }});
  console.log('Login verified: native Ink paste/masking/save/cancel/errors/env override; command never reaches history or model dispatch.');
} finally { rmSync(entry, { force: true }); }
