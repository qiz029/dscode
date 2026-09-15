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
const start = source.indexOf('const expandedValue = expandLargePastes(dscodeRunValue ?? liveValue, pendingPastesRef.current);');
assert(start >= 0, 'submission expansion anchor missing');
const end = source.indexOf('if (draftImagesRef.current.length > 0', start);
for (const [value, busy, expected] of [
  ['/login', false, 'login:current'], ['/login openrouter', false, 'login:openrouter'], ['/login DeepSeek', false, 'login:deepseek-official'],
  ['/login', true, 'notice'], ['/login synthetic-inline-key', false, 'notice'],
  ['/provider', false, 'provider:picker'], ['/provider openrouter', false, 'provider:openrouter'], ['/provider', true, 'notice'], ['/provider synthetic-inline-key', false, 'notice'],
  ['/openrouter', false, 'openrouter'], ['/openrouter', true, 'notice'],
]) {
  const calls = [];
  const noop = () => {};
  const handler = vm.runInNewContext(`() => { ${source.slice(start, end)} throw Error('fell through to transcript'); }`, {
    liveValue: value, dscodeRunValue: undefined, expandLargePastes: v => v, pendingPastesRef: { current: new Map() }, submissionPayload: v => v, busy,
    valueRef: {}, cursorRef: {}, recall: {}, recallSpace: {}, beginRecall: noop,
    setValue: noop, setCursor: noop, setCompletionIndex: noop, setDismissedMenuValue: noop, dscodeProviderArgument: providerArgument,
    notify: message => { assert(!message.includes('synthetic-inline-key')); calls.push('notice'); },
    openLogin: target => calls.push('login:' + (target ?? 'current')), openProvider: target => calls.push('provider:' + (target ?? 'picker')), openOpenRouter: () => calls.push('openrouter'),
  });
  handler(); assert.deepEqual(calls, [expected], value);
}
// Enter on the slash menu runs a picker command at once; any other command still completes into the input.
const menuStart = source.lastIndexOf('let dscodeRunValue;', start);
assert(menuStart >= 0, 'picker command anchor missing');
for (const [value, label, expected] of [['/prov', '/provider', ['provider:picker']], ['/ope', '/openrouter', ['openrouter']], ['/lo', '/login', ['login:current']], ['/mo', '/model', ['accept']]]) {
  const calls = [];
  const noop = () => {};
  const handler = vm.runInNewContext(`() => { ${source.slice(menuStart, end)} throw Error('fell through to transcript'); }`, {
    liveValue: value, menuActive: true, mentionActive: false, candidates: [{ label }], completionIndex: 0, acceptMenuCandidate: () => calls.push('accept'),
    expandLargePastes: v => v, pendingPastesRef: { current: new Map() }, submissionPayload: v => v, busy: false,
    valueRef: {}, cursorRef: {}, recall: {}, recallSpace: {}, beginRecall: noop,
    setValue: noop, setCursor: noop, setCompletionIndex: noop, setDismissedMenuValue: noop, dscodeProviderArgument: providerArgument,
    notify: () => calls.push('notice'), openLogin: target => calls.push('login:' + (target ?? 'current')),
    openProvider: target => calls.push('provider:' + (target ?? 'picker')), openOpenRouter: () => calls.push('openrouter'),
  });
  handler(); assert.deepEqual(calls, expected, value);
}
const entry = new URL(`node_modules/dsh-code/lib/.dscode-login-probe-${process.pid}.mjs`, root);
writeFileSync(entry, source + '\nexport { DscodeLoginPanel, DscodeProviderPanel, DscodeManagementKeyPanel, DscodeOpenRouterPanel, render, import_react as react };\n');
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
  // The optional management key: an empty Enter skips, a rejected key stays on the prompt, an environment key only continues.
  async function managementPanel({ state = 'missing', fail, optional = true, run }) {
    const saved = [], actions = [];
    await mount(ui, ui.react.createElement(ui.DscodeManagementKeyPanel, {
      optional, status: async () => ({ state }),
      save: async key => { saved.push(key); if (fail) throw new Error(fail); },
      done: result => actions.push('done:' + result), back: () => actions.push('back'),
    }), async ({ input, frames }) => {
      await run({ input, saved, actions, frames });
      assert(!frames.join('').includes('synthetic-management'), 'the management key appeared in a rendered frame');
    });
  }
  await managementPanel({ run: async ({ input, saved, actions, frames }) => {
    assert.match(frames.join(''), /OpenRouter management key \(optional\)/);
    assert.match(frames.join(''), /It cannot call models; DSCODE only reads/);
    await input('\r');
    assert.deepEqual(saved, []); assert.deepEqual(actions, ['done:false']);
  }});
  await managementPanel({ run: async ({ input, saved, actions, frames }) => {
    await input('\x1b[200~synthetic-management-1\x1b[201~');
    assert.match(frames.join(''), /••••••••/);
    await input('\r');
    assert.deepEqual(saved, ['synthetic-management-1']); assert.deepEqual(actions, ['done:true']);
  }});
  await managementPanel({ fail: 'This is not a management key: OpenRouter refused it for account data.', run: async ({ input, actions, frames }) => {
    await input('synthetic-management-2'); await input('\r');
    assert.deepEqual(actions, []); assert.match(frames.join(''), /This is not a management key/);
    await input('\x1b');
    assert.deepEqual(actions, ['back']);
  }});
  await managementPanel({ state: 'env', optional: false, run: async ({ input, saved, actions, frames }) => {
    assert.match(frames.join(''), /OPENROUTER_MANAGEMENT_KEY is set by your environment/);
    await input('synthetic-management-3'); await input('\r');
    assert.deepEqual(saved, []); assert.deepEqual(actions, ['done:false']);
  }});
  // The account panel renders the loaded sections; r reloads, m asks for the management key, Esc closes.
  let loads = 0;
  const account = {
    hasApiKey: true, hasManagementKey: true,
    credits: { value: { total: 50, used: 12.5, remaining: 37.5 } },
    key: { value: { label: 'sk-or-v1-abc...xyz', usageDaily: 0.25, usageWeekly: 1, usageMonthly: 3.5 } },
    keys: { value: [{ name: 'dscode', label: 'sk-or-v1-abc...xyz', usageDaily: 0.25, usageMonthly: 3.5 }] },
    activity: { value: { usage: 3.5, requests: 18, days: 2, modelCount: 1, models: [{ model: 'z-ai/glm-5.3-flash', usage: 3.5, requests: 18, providers: [{ name: 'Z.AI', usage: 3.5 }] }] } },
  };
  const panelActions = [];
  await mount(ui, ui.react.createElement(ui.DscodeOpenRouterPanel, {
    load: async () => { loads++; return account; }, setManagement: () => panelActions.push('management'), back: () => panelActions.push('back'),
  }), async ({ input, frames }) => {
    const text = frames.join('');
    assert.match(text, /\/openrouter — account/);
    assert.match(text, /Account balance {2}\$37\.50 · credits \$50\.00 · used \$12\.50/);
    assert.match(text, /dscode \(this key\)/);
    assert.match(text, /Last 30 days {2}\$3\.50 · 18 requests · 1 models/);
    await input('r'); assert.equal(loads, 2);
    await input('m'); await input('\x1b');
    assert.deepEqual(panelActions, ['management', 'back']);
  });
  await mount(ui, ui.react.createElement(ui.DscodeOpenRouterPanel, { load: async () => { throw new Error('offline'); }, setManagement() {}, back() {} }), async ({ frames }) => {
    assert.match(frames.join(''), /Could not load the OpenRouter account: offline/);
  });
  console.log('Login and provider verified: native Ink paste/masking/save/cancel/errors/env override for DeepSeek and OpenRouter; /provider picker navigation; the optional OpenRouter management key and the /openrouter account panel; commands never reach history or model dispatch.');
} finally { rmSync(entry, { force: true }); }
