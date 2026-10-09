import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launchOptions, validateConfig, saveConfig, readConfig } from '../plugins/browser/config.mjs';
import { BrowserConnection, browserProcessEnvironment } from '../plugins/browser/connection.mjs';
import { apply } from '../plugins/browser/index.mjs';
import { needsMcpApproval } from '../plugins/auto-review/policy.mjs';
import { formatStatus } from '../plugins/browser/presentation.mjs';
import { BrowserAccess } from '../plugins/browser/access.mjs';
import { browserForAgent } from '../plugins/browser/review.mjs';

for (const change of ['block', 'developer-block', 'developer-mode', 'temporary-revoked']) {
  test(`revocation after initial admission prevents browser dispatch: ${change}`, async t => {
    const dir = await home(t), chrome = fakeChrome(), access = new BrowserAccess(dir);
    const browser = new BrowserConnection({ home: dir, sessionId: 'dispatch-revocation', config: {}, access, connect: chrome.connect });
    t.after(() => browser.close());
    await access.update('developer-mode', 'on'); await access.update('developer-allow', 'https://user.example');
    if (change === 'temporary-revoked') { await access.update('forget', 'https://user.example'); await access.update('once', 'https://user.example'); }
    await browser.start();
    const tool = change.startsWith('developer') ? 'evaluate_script' : 'click';
    browser.tools.push({ name: 'evaluate_script' });
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), check = access.check.bind(access);
    let held = false;
    access.check = async (...args) => {
      await check(...args);
      if (!held) { held = true; entered.resolve(); await release.promise; }
    };
    const outcome = browser.call(tool, { pageId: 1 }).then(value => ({ value }), error => ({ error }));
    await entered.promise;
    const editor = new BrowserAccess(dir);
    try {
      if (change === 'temporary-revoked') {
        await editor.update('block', 'https://user.example'); await editor.update('forget', 'https://user.example');
      } else await editor.update(change, change === 'developer-mode' ? 'off' : 'https://user.example');
    } finally { release.resolve(); }
    const result = await outcome;
    assert.match(result.error?.message ?? '', /blocked|permission/);
    assert.equal(chrome.calls.filter(call => call.name === tool).length, 0, 'A revoked action must not reach Chrome');
    access.check = check;
    await editor.update('allow', 'https://user.example'); await editor.update('developer-mode', 'on'); await editor.update('developer-allow', 'https://user.example');
    await browser.call(tool, { pageId: 1 });
    assert.equal(chrome.calls.filter(call => call.name === tool).length, 1, 'A new permitted request can proceed');
  });
}

test('Desktop browser children use Electron Node mode while ordinary Node children keep the minimal environment', () => {
  assert.equal(browserProcessEnvironment({ electron: '44.0.0' }).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(browserProcessEnvironment({ node: '24.14.1' }).ELECTRON_RUN_AS_NODE, undefined);
  for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'NODE_OPTIONS']) assert.equal(browserProcessEnvironment({ electron: '44.0.0' })[key], undefined);
});

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dscode-browser-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sites = Object.fromEntries(['user', 'user-new', 'test', 'temp', 'temporary-a', 'temporary-b', 'unsaved', 'handoff', 'denied', 'login']
    .map(host => [`https://${host}.example`, { access: 'allow', developer: false }]));
  await writeFile(join(dir, 'permissions.json'), JSON.stringify({ developerMode: false, sites }));
  return dir;
}
function fakeChrome() {
  let pages = [{ id: 1, url: 'https://user.example', selected: true }], cursor = 1, closed = false;
  const calls = [];
  const client = {
    async listTools() { return { tools: ['list_pages', 'select_page', 'new_page', 'close_page', 'take_snapshot', 'click'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }; },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      if (name === 'new_page') { pages = pages.map(p => ({ ...p, selected: false })); pages.push({ id: ++cursor, url: args.url, selected: true }); }
      if (name === 'close_page' && pages.length > 1) pages = pages.filter(p => p.id !== args.pageId);
      return { content: [{ type: 'text', text: 'pages' }], structuredContent: { pages: structuredClone(pages) } };
    },
    async close() { closed = true; this.onclose?.(); },
  };
  return { client, calls, connect: async () => ({ client }), closed: () => closed, userTab() { pages.push({ id: ++cursor, url: 'https://user-new.example', selected: false }); } };
}

for (const operation of ['call', 'wait', 'handoff', 'resume', 'cleanup', 'already-aborted']) {
  test(`cancelling queued ${operation} settles before a slow earlier browser request`, async t => {
    const chrome = fakeChrome(), browser = new BrowserConnection({ home: await home(t), sessionId: 'queued-cancel', config: {}, connect: chrome.connect });
    await browser.start();
    if (operation === 'resume') await browser.takeHandoff(1, 'Manual step');
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), calls = [];
    const original = chrome.client.callTool;
    chrome.client.callTool = async request => {
      calls.push(request.name);
      if (calls.length === 1) { entered.resolve(); await release.promise; }
      return original(request);
    };
    const first = browser.call('list_pages', {});
    await entered.promise;
    const controller = new AbortController(), reason = Error('Queued request cancelled by the user');
    if (operation === 'already-aborted') controller.abort(reason);
    const queued = operation === 'wait' ? browser.waitForPage({ urlContains: 'example' }, controller.signal)
      : operation === 'handoff' ? browser.takeHandoff(1, 'Do not enter this handoff', controller.signal)
        : operation === 'resume' ? browser.resume(controller.signal)
          : operation === 'cleanup' ? browser.cleanup(controller.signal)
            : browser.call('click', { pageId: 1 }, controller.signal);
    let cancellation;
    const settled = queued.then(value => { cancellation = { value }; }, error => { cancellation = { error }; });
    controller.abort(reason);
    const following = browser.call('list_pages', {});
    try {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(cancellation?.error, reason, 'A queued cancellation must not wait for the active request');
      assert.deepEqual(calls, ['list_pages'], 'Cancellation must not release the active request’s queue slot');
    } finally {
      release.resolve();
      await Promise.allSettled([first, settled, following]);
      await browser.close();
    }
    assert.deepEqual(calls, ['list_pages', 'list_pages'], 'The cancelled operation must never reach Chrome');
    assert.equal(Boolean(browser.handoff), operation === 'resume', 'Cancellation must not enter or resume handoff');
  });
}

test('browser settings preserve login profile identity and reject unsafe/conflicting configuration', async t => {
  const dir = await home(t);
  assert.equal((await readConfig(dir)).mode, 'persistent');
  assert.equal(launchOptions(dir, 'same', {}).profile, launchOptions(dir, 'same', {}).profile);
  assert.notEqual(launchOptions(dir, 'same', {}).profile, launchOptions(dir, 'other', {}).profile);
  assert.equal(launchOptions(dir, 'one', { profile: 'work' }).profile, launchOptions(dir, 'two', { profile: 'work' }).profile);
  for (const config of [{ mode: 'bad' }, { profile: '../escape' }, { mode: 'connect', url: 'https://example.com' }, { mode: 'connect', url: 'http://user:pw@localhost:9222' }, { mode: 'auto', headless: true }, { mode: 'isolated', profile: 'work' }, { headless: 'false' }, { mode: 'persistent', url: 'http://localhost' }, { command: 'sh' }]) assert.throws(() => validateConfig(config));
  assert(launchOptions(dir, 'one', { mode: 'isolated', headless: true }).args.includes('--isolated'));
  assert(launchOptions(dir, 'one', { mode: 'auto' }).args.includes('--auto-connect'));
  assert(launchOptions(dir, 'one', { mode: 'connect', url: 'http://127.0.0.1:9222' }).args.includes('http://127.0.0.1:9222'));
  for (const mode of ['persistent', 'isolated']) {
    const args = launchOptions(dir, 'one', { mode, headless: true }).args;
    assert.equal(args[args.indexOf('--viewport') + 1], '1280x800');
  }
  for (const config of [{}, { mode: 'isolated' }, { mode: 'connect', url: 'http://127.0.0.1:9222' }, { mode: 'auto' }, { mode: 'extension' }]) {
    assert(!launchOptions(dir, 'one', config).args.includes('--viewport'), 'Visible and attached browsers retain their own window geometry');
  }
  await saveConfig(dir, { profile: 'work' });
  assert.equal((await readConfig(dir)).profile, 'work');
  await writeFile(join(dir, 'config.json'), '{} broken');
  await assert.rejects(readConfig(dir));
});

test('custom Chrome paths survive persistence and remain a single launch argument', async t => {
  const dir = await home(t), executablePath = join(dir, 'Chrome for Testing', 'chrome');
  await saveConfig(dir, { mode: 'isolated', executablePath });
  const saved = await readConfig(dir);
  assert.equal(saved.executablePath, executablePath);
  const { args } = launchOptions(dir, 'custom-executable', saved);
  const index = args.indexOf('--executable-path');
  assert(index >= 0);
  assert.equal(args[index + 1], executablePath);
  assert.equal(args.filter(arg => arg === executablePath).length, 1);
});

test('tab cleanup preserves user tabs, explicit deliverables and generation boundaries', async t => {
  const chrome = fakeChrome();
  const b = new BrowserConnection({ home: await home(t), sessionId: 'test', config: {}, connect: chrome.connect });
  await b.start();
  await b.call('new_page', { url: 'https://test.example' });
  b.keep(2);
  await b.call('new_page', { url: 'https://temp.example' });
  chrome.userTab();
  assert.deepEqual((await b.cleanup()).closed, [3]);
  assert.deepEqual(b.pages.map(p => p.id), [1, 2, 4]);
  assert.throws(() => b.keep(1), /created by this session/);
  b.observe({ structuredContent: { reconnected: true, pages: [{ id: 2, url: 'https://different.example' }] } });
  assert.equal(b.owned.size, 0);
  await b.close();
  assert.equal(chrome.closed(), true);
  await assert.rejects(b.call('list_pages', {}), /closed/);
});

for (const scenario of ['headless', 'visible', 'selection-error', 'restart', 'revocation']) {
  test(`resize activates only managed headless pages and respects interruption: ${scenario}`, async t => {
    const chrome = fakeChrome(), tools = chrome.client.listTools, call = chrome.client.callTool;
    chrome.client.listTools = async () => ({ tools: [...(await tools()).tools, { name: 'resize_page' }] });
    const b = new BrowserConnection({ home: await home(t), sessionId: 'resize',
      config: { mode: 'isolated', headless: scenario !== 'visible' }, connect: chrome.connect });
    t.after(() => b.close());
    await b.start();
    chrome.calls.length = 0;
    chrome.client.callTool = async request => {
      const result = await call(request);
      if (request.name === 'select_page') {
        if (scenario === 'selection-error') return { ...result, isError: true };
        if (scenario === 'restart') result.structuredContent.reconnected = true;
        if (scenario === 'revocation') await b.access.update('block', 'https://user.example');
      }
      return result;
    };
    const resizing = b.call('resize_page', { pageId: 1, width: 640, height: 480 });
    if (scenario === 'restart') await assert.rejects(resizing, /restarted before resizing/);
    else if (scenario === 'revocation') await assert.rejects(resizing, /blocked/i);
    else assert.equal(Boolean((await resizing).isError), scenario === 'selection-error');
    const selected = chrome.calls.filter(c => c.name === 'select_page');
    assert.equal(selected.length, scenario === 'visible' ? 0 : 1);
    if (selected.length) assert.deepEqual(selected[0].args, { pageId: 1, bringToFront: true });
    const resized = chrome.calls.filter(c => c.name === 'resize_page');
    assert.equal(resized.length, ['headless', 'visible'].includes(scenario) ? 1 : 0);
    if (scenario === 'headless') assert(chrome.calls.indexOf(selected[0]) < chrome.calls.indexOf(resized[0]));
  });
}

for (const phase of ['page-list', 'permission-read']) {
  test(`a tab kept while cleanup awaits ${phase} is not closed`, async t => {
    const chrome = fakeChrome();
    const b = new BrowserConnection({ home: await home(t), sessionId: 'late-keep', config: {}, connect: chrome.connect });
    t.after(() => b.close());
    await b.start();
    await b.call('new_page', { url: 'https://test.example' });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const original = chrome.client.callTool, checkUrl = b.access.checkUrl.bind(b.access);
    let lists = 0;
    chrome.client.callTool = async request => {
      const result = await original(request);
      if (phase === 'page-list' && request.name === 'list_pages' && ++lists === 2) {
        entered.resolve(); await release.promise;
      }
      return result;
    };
    b.access.checkUrl = async (...args) => {
      await checkUrl(...args);
      if (phase === 'permission-read') { entered.resolve(); await release.promise; }
    };
    const cleaning = b.cleanup();
    await entered.promise;
    b.keep(2, 'preview');
    release.resolve();
    const result = await cleaning;
    assert.deepEqual(result.closed, []);
    assert(!chrome.calls.some(call => call.name === 'close_page'));
    assert.equal(result.pages.find(page => page.id === 2)?.retention, 'preview');
    assert.deepEqual((await b.cleanup()).closed, [], 'Later cleanup also preserves the retained page');
  });
}

test('connection serializes calls and never replays a failed action', async t => {
  const chrome = fakeChrome();
  const b = new BrowserConnection({ home: await home(t), sessionId: 'test', config: {}, connect: chrome.connect });
  await b.start();
  let count = 0, active = 0;
  const original = chrome.client.callTool;
  chrome.client.callTool = async request => { if (request.name === 'list_pages') return original(request); assert.equal(active++, 0); count++; await new Promise(r => setTimeout(r, 5)); active--; if (count === 1) throw Error('uncertain'); return { content: [] }; };
  const results = await Promise.allSettled([b.call('click', { pageId: 1 }), b.call('take_snapshot', { pageId: 1 })]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled'); assert.equal(count, 2);
  chrome.client.onclose();
  await assert.rejects(b.call('click', {}), /ended/);
  assert.equal(count, 2);
  await b.close();
});

test('cleanup does not close recycled IDs after a restart in the middle of its batch', async t => {
  const chrome = fakeChrome();
  const b = new BrowserConnection({ home: await home(t), sessionId: 'cleanup-restart', config: {}, connect: chrome.connect });
  await b.start();
  await b.call('new_page', { url: 'https://temporary-a.example' });
  await b.call('new_page', { url: 'https://temporary-b.example' });
  const original = chrome.client.callTool, closed = [];
  chrome.client.callTool = async request => {
    if (request.name !== 'close_page') return original(request);
    closed.push(request.arguments.pageId);
    return { content: [], structuredContent: { reconnected: true, pages: [{ id: 3, url: 'https://new-user-tab.example' }] } };
  };
  await b.cleanup();
  assert.deepEqual(closed, [2]);
  assert.equal(b.owned.size, 0);
  assert.equal(b.pages[0].url, 'https://new-user-tab.example');
  await b.close();
});

test('cleanup retains uncertain closes instead of replaying them at the next turn end', async t => {
  const chrome = fakeChrome();
  const b = new BrowserConnection({ home: await home(t), sessionId: 'cleanup-failure', config: {}, connect: chrome.connect });
  await b.start();
  await b.call('new_page', { url: 'https://unsaved.example' });
  const original = chrome.client.callTool;
  let closes = 0;
  chrome.client.callTool = async request => {
    if (request.name !== 'close_page') return original(request);
    closes++; throw Error('close timed out');
  };
  await assert.rejects(b.cleanup(), /close timed out/);
  assert(b.kept.has(2));
  await b.cleanup();
  assert.equal(closes, 1);
  await b.close();
});

for (const failure of ['throw', 'tool-error']) test(`newly created tabs survive failed post-action verification: ${failure}`, async t => {
  const chrome = fakeChrome(), browser = new BrowserConnection({ home: await home(t), sessionId: 'unverified-new-tab', config: {}, connect: chrome.connect });
  t.after(() => browser.close());
  await browser.start();
  const original = chrome.client.callTool;
  let created = false, failed = false;
  chrome.client.callTool = async request => {
    if (created && !failed && request.name === 'list_pages') {
      failed = true;
      if (failure === 'throw') throw Error('Page list transport timed out');
      return { isError: true, content: [{ type: 'text', text: 'Page list unavailable' }] };
    }
    const result = await original(request);
    if (request.name === 'new_page') created = true;
    return result;
  };
  await assert.rejects(browser.call('new_page', { url: 'https://test.example' }), /may already have completed.*do not replay/);
  assert(browser.owned.has(2), 'Chrome confirmed which tab it created');
  assert(browser.kept.has(2), 'An uncertain operation must leave its confirmed owned tab available for inspection');
  assert.deepEqual((await browser.cleanup()).closed, []);
  assert(browser.pages.some(page => page.id === 2));
  assert.equal(chrome.calls.filter(call => call.name === 'new_page').length, 1);
  assert.equal(chrome.calls.filter(call => call.name === 'close_page').length, 0);
});

test('post-action Chrome restart cannot retain a recycled new-page ID', async t => {
  const chrome = fakeChrome(), browser = new BrowserConnection({ home: await home(t), sessionId: 'post-action-restart', config: {}, connect: chrome.connect });
  t.after(() => browser.close());
  await browser.start();
  const original = chrome.client.callTool;
  let created = false;
  chrome.client.callTool = async request => {
    if (created && request.name === 'list_pages') return { content: [], structuredContent: { reconnected: true, pages: [{ id: 2, url: 'https://user-new.example' }] } };
    const result = await original(request);
    if (request.name === 'new_page') created = true;
    return result;
  };
  await assert.rejects(browser.call('new_page', { url: 'https://test.example' }), /Chrome restarted/);
  assert.equal(browser.owned.size, 0); assert.equal(browser.kept.size, 0);
  assert.equal(browser.pages[0].url, 'https://user-new.example');
});

test('a Chrome restart detected before an action invalidates old IDs without acting', async t => {
  const chrome = fakeChrome();
  const browser = new BrowserConnection({ home: await home(t), sessionId: 'restart', config: {}, connect: chrome.connect });
  await browser.start();
  const attempted = [];
  chrome.client.callTool = async ({ name }) => { attempted.push(name); return { content: [], structuredContent: { reconnected: true, pages: [{ id: 1, url: 'about:blank' }] } }; };
  await assert.rejects(browser.call('click', { pageId: 1, uid: 'old-uid' }), /Chrome restarted/);
  assert.deepEqual(attempted, ['list_pages']);
  chrome.client.callTool = async ({ name }) => { attempted.push(name); return { content: [], structuredContent: { pages: [] } }; };
  await assert.rejects(browser.call('close_page', { pageId: 1 }), /closed or unavailable/);
  assert.deepEqual(attempted, ['list_pages', 'list_pages']);
  await browser.close();
});

function fixture(dir, customConnect) {
  const global = new Map(), scoped = new Map(), hooks = new Map(), commands = new Map(), skills = [], cleanups = [], connections = [];
  const register = map => definition => { map.set(definition.name, definition); return () => map.delete(definition.name); };
  const agent = { status: 'idle', session: { id: 'fixture', header: { cwd: dir } }, ctx: { tools: { register: register(scoped) } } };
  const ctx = { tools: { register: register(global) }, skills: { register: skill => skills.push(skill) }, commands: { register: cmd => commands.set(cmd.name, cmd) }, systemPrompt: { section() {} }, agents: { list: () => [agent] }, on: (event, hook) => hooks.set(event, hook), effect: fn => cleanups.push(fn()), logger: { warn() {} } };
  apply(ctx, { home: dir, connect: customConnect ?? (async () => { const chrome = fakeChrome(); connections.push(chrome); return chrome.connect(); }) });
  const exec = { agent, signal: new AbortController().signal };
  return { global, scoped, hooks, commands, skills, agent, connections, exec,
    command: rawInput => commands.get('browser').handler({ ...exec, rawInput }), dispose: () => cleanups[0]() };
}

test('managed browser mode and profile changes preserve custom launch settings', async t => {
  const dir = await home(t), executablePath = join(dir, 'Chrome for Testing', 'chrome'), launches = [];
  await saveConfig(dir, { mode: 'persistent', profile: 'old', executablePath, headless: true, webmcp: true });
  const f = fixture(dir, async args => { launches.push([...args]); return fakeChrome().connect(); });
  t.after(() => f.dispose());
  for (const [command, mode, profile] of [
    ['use persistent work', 'persistent', 'work'], ['use isolated', 'isolated', undefined],
    ['use persistent', 'persistent', undefined],
  ]) {
    assert.equal((await f.command(command)).kind, 'success');
    const saved = await readConfig(dir);
    assert.equal(saved.executablePath, executablePath);
    assert.equal(saved.headless, true); assert.equal(saved.webmcp, true);
    assert.equal(saved.mode, mode); assert.equal(saved.profile, profile); assert.equal(saved.url, undefined);
    assert.equal((await f.command('start')).kind, 'success');
    const args = launches.at(-1);
    assert.equal(args[args.indexOf('--executable-path') + 1], executablePath);
    assert(args.includes('--headless'));
    assert.equal((await f.command('stop')).kind, 'success');
  }
});

for (const mode of ['connect', 'auto', 'extension']) test(`switching to ${mode} removes incompatible managed launch settings`, async t => {
  const dir = await home(t), f = fixture(dir); t.after(() => f.dispose());
  await saveConfig(dir, { mode: 'persistent', profile: 'work', executablePath: join(dir, 'chrome'), headless: true, webmcp: true });
  assert.equal((await f.command(`use ${mode}${mode === 'connect' ? ' http://127.0.0.1:9222' : ''}`)).kind, 'success');
  const attached = await readConfig(dir);
  assert.equal(attached.mode, mode); assert.equal(attached.headless, false); assert.equal(attached.webmcp, true);
  assert.equal(attached.executablePath, undefined); assert.equal(attached.profile, undefined);
  assert.equal(attached.url, mode === 'connect' ? 'http://127.0.0.1:9222' : undefined);
  assert.equal((await f.command('use isolated')).kind, 'success');
  const managed = await readConfig(dir);
  assert.equal(managed.mode, 'isolated'); assert.equal(managed.url, undefined);
  assert.equal(managed.headless, false); assert.equal(managed.executablePath, undefined);
});

for (const surface of ['command', 'json-command', 'tool']) test(`tab refresh reports MCP errors instead of cached success through ${surface}`, async t => {
  const f = fixture(await home(t)); t.after(() => f.dispose());
  await f.command('start');
  const chrome = f.connections[0], original = chrome.client.callTool;
  chrome.client.callTool = async request => request.name === 'list_pages'
    ? { isError: true, content: [{ type: 'text', text: 'Fixture page list unavailable' }] }
    : original(request);
  const refresh = () => surface === 'tool' ? f.global.get('browser_tabs').execute({ action: 'status' }, f.exec)
    : f.command(surface === 'json-command' ? 'tabs --json' : 'tabs');
  if (surface === 'tool') await assert.rejects(refresh(), /Could not refresh browser tabs/);
  else {
    const failed = await refresh();
    assert.equal(failed.kind, 'error');
    assert.match(failed.text, /Could not refresh browser tabs/);
    assert(!failed.text.includes('https://user.example'));
  }
  const cached = JSON.parse((await f.command('status --json')).text);
  assert.equal(cached.pages[0].url, 'https://user.example');
  chrome.client.callTool = original;
  const recovered = await refresh();
  if (surface === 'tool') assert.equal(recovered.pages[0].url, 'https://user.example');
  else assert.equal(recovered.kind, 'success');
});

test('user commands control grants and WebMCP without exposing a model grant tool', async t => {
  const f = fixture(await home(t)); t.after(() => f.dispose());
  assert.equal((await f.command('site once https://one.example')).kind, 'error');
  assert.equal((await f.command('webmcp on')).kind, 'success');
  assert.equal((await f.command('use isolated')).kind, 'success');
  assert.equal(JSON.parse((await f.command('status --json')).text).config.webmcp, true);
  await f.command('start');
  assert.equal((await f.command('webmcp off')).kind, 'error');
  assert.equal((await f.command('site once https://one.example')).kind, 'success');
  assert.deepEqual(JSON.parse((await f.command('permissions --json')).text).permissions.sessionSites, ['https://one.example']);
  assert.equal((await f.command('developer on')).kind, 'success');
  assert.equal((await f.command('developer allow https://one.example')).kind, 'success');
  assert.equal((await f.command('site block https://one.example')).kind, 'success');
  const permission = JSON.parse((await f.command('permissions --json')).text).permissions;
  assert.equal(permission.sites['https://one.example'].developer, false);
  assert.equal((await f.command('site once https://one.example')).kind, 'error');
  assert(![...f.global.keys()].some(name => /grant|permission|developer|webmcp/.test(name)));
  await f.command('stop');
  assert.equal((await f.command('webmcp off')).kind, 'success');
});

for (const state of ['connected', 'handoff', 'disconnected', 'disconnected-handoff', 'stopped']) {
  test(`permission command receipts retain the actual browser state: ${state}`, async t => {
    const f = fixture(await home(t)); t.after(() => f.dispose());
    await f.command('start');
    const chrome = f.connections[0];
    if (state.includes('handoff')) assert.equal((await f.command('handoff 1')).kind, 'success');
    if (state.startsWith('disconnected')) chrome.client.onclose();
    if (state === 'stopped') await f.command('stop');
    const calls = chrome.calls.length;
    const expected = state === 'handoff' ? 'waiting for you' : state === 'connected' ? 'connected' : 'disconnected';
    for (const command of ['permissions', 'site allow https://one.example', 'site block https://one.example',
      'site forget https://one.example', 'developer on', 'developer allow https://one.example', 'developer block https://one.example', 'developer off']) {
      const result = await f.command(command);
      assert.equal(result.kind, 'success');
      assert.match(result.text, new RegExp(`^Browser: ${expected}(?: ·|\\n)`), command);
      if (state === 'handoff') assert.match(result.text, /\/browser resume/);
      if (state === 'disconnected-handoff') assert(!result.text.includes('When ready: /browser resume'), command);
      if (state === 'connected') assert(!result.text.includes('Start: /browser start'), command);
      const data = JSON.parse((await f.command(command + ' --json')).text);
      assert.equal(data.connected, ['connected', 'handoff'].includes(state), command);
      assert.equal(Boolean(data.handoff), state.includes('handoff'), command);
    }
    assert.equal(chrome.calls.length, calls, 'Permission receipts must not contact Chrome');
    assert.equal(chrome.closed(), state === 'stopped', 'Permission commands must not stop the browser');
  });
}

for (const command of ['status', 'site allow https://one.example']) for (const change of ['close', 'stop', 'handoff']) {
  test(`${command} observes ${change} during its permission read before producing the receipt`, async t => {
    const f = fixture(await home(t)); t.after(() => f.dispose());
    await f.command('start');
    const browser = browserForAgent(f.agent), entered = Promise.withResolvers(), release = Promise.withResolvers();
    const read = browser.access.status.bind(browser.access);
    browser.access.status = async () => { entered.resolve(); await release.promise; return read(); };
    const pending = f.command(command + ' --json');
    await entered.promise;
    try {
      if (change === 'close') f.connections[0].client.onclose();
      else assert.equal((await f.command(change === 'stop' ? 'stop' : 'handoff 1')).kind, 'success');
    } finally { release.resolve(); }
    const result = await pending;
    assert.equal(result.kind, 'success');
    const data = JSON.parse(result.text);
    assert.equal(data.connected, change === 'handoff');
    assert.equal(Boolean(data.handoff), change === 'handoff');
    if (command.startsWith('site')) assert.equal(data.permissions.sites['https://one.example'].access, 'allow');
  });
}

test('extension pairing belongs to a session, cannot be created by a tool, and stops without starting Chrome', async t => {
  const f = fixture(await home(t));
  t.after(() => f.dispose());
  assert.equal((await f.command('pair')).kind, 'error');
  assert.equal((await f.command('use extension')).kind, 'success');
  assert.match((await f.command('start')).text, /\/browser pair/);
  const paired = await f.command('pair --json');
  assert.equal(paired.kind, 'success');
  const data = JSON.parse(paired.text);
  assert.match(data.pairingUrl, /^ws:\/\/127\.0\.0\.1:\d+\/extension\?token=[a-f0-9]{64}$/);
  assert(data.extensionPath.endsWith('/extensions/browser'));
  assert(![...f.global.keys()].some(name => name.includes('pair')));
  assert(!JSON.parse((await f.command('status --json')).text).pairingUrl);
  assert.equal((await f.command('use isolated')).kind, 'error');
  assert.equal((await f.command('stop')).kind, 'success');
  assert.equal((await f.command('use isolated')).kind, 'success');
  assert.equal(f.connections.length, 0);
});

test('extension connection requires sharing and immediately rejects actions after revocation', async t => {
  const chrome = fakeChrome();
  const dir = await home(t);
  await assert.rejects(new BrowserConnection({ home: dir, sessionId: 'missing', config: { mode: 'extension' }, connect: chrome.connect }).start(), /\/browser pair/);
  let onClose;
  let closed = false;
  const relay = { ready: true, endpoint: 'ws://127.0.0.1:1234/cdp?token=private',
    onClose(listener) { onClose = listener; return () => {}; }, close() { closed = true; } };
  const browser = new BrowserConnection({ home: dir, sessionId: 'extension', config: { mode: 'extension' }, relay, connect: async args => {
    assert(args.includes('--ws-endpoint')); assert(args.includes(relay.endpoint));
    assert(!args.includes('--auto-connect')); assert(!args.includes('--isolated'));
    return chrome.connect();
  } });
  await browser.start();
  const before = chrome.calls.length;
  onClose();
  assert.equal(browser.status().connected, false);
  assert(!JSON.stringify(browser.status()).includes('token=private'));
  await assert.rejects(browser.call('click', { pageId: 1 }), /sharing was revoked/);
  assert.equal(chrome.calls.length, before);
  await browser.close();
  assert(closed);
});

test('an agent can dispose a failed transport before a deliberate restart', async t => {
  const f = fixture(await home(t));
  t.after(() => f.dispose());
  await f.command('start');
  f.connections[0].client.onclose();
  await f.global.get('browser_stop').execute({}, f.exec);
  assert.equal(f.scoped.size, 0);
  assert.equal(f.connections[0].closed(), true);
  assert.equal((await f.command('start')).kind, 'success');
});

test('stop cancels an extension pairing even while its configuration is still loading', async t => {
  const f = fixture(await home(t));
  t.after(() => f.dispose());
  await f.command('use extension');
  const pairing = f.command('pair');
  await f.command('stop');
  assert.equal((await pairing).kind, 'error');
  assert.equal((await f.command('use isolated')).kind, 'success');
});

test('a tool call retains its proposed page binding through the native MCP definition', async t => {
  const f = fixture(await home(t)); t.after(() => f.dispose());
  await f.command('start');
  const exec = { ...f.exec, name: 'mcp__browser__click', callId: 'reviewed-click', arguments: { pageId: 1, uid: 'old' } };
  assert.equal((await f.hooks.get('tools/pre-execute')(exec, () => ({ kind: 'allow' }))).kind, 'allow');
  const chrome = f.connections[0], original = chrome.client.callTool;
  chrome.client.callTool = async request => {
    const result = await original(request);
    result.structuredContent.pages[0].url = 'https://handoff.example';
    return result;
  };
  await assert.rejects(f.scoped.get(exec.name).execute(exec.arguments, exec), /changed after the tool was proposed/);
  assert(!chrome.calls.some(c => c.name === 'click'));
});

test('native WebMCP review keeps its document binding across an identical rediscovery', async t => {
  const chrome = fakeChrome(), original = chrome.client.callTool, listTools = chrome.client.listTools;
  let documentId = 'before-reload';
  const siteTool = { name: 'save', description: 'Save fixture', inputSchema: { type: 'object' } };
  chrome.client.listTools = async () => ({ tools: [...(await listTools()).tools,
    ...['list_webmcp_tools', 'execute_webmcp_tool'].map(name => ({ name, inputSchema: { type: 'object' } }))] });
  chrome.client.callTool = async request => {
    const result = await original(request);
    for (const page of result.structuredContent.pages) page.documentId = documentId;
    if (request.name === 'list_webmcp_tools') result.structuredContent.webmcpTools = [siteTool];
    return result;
  };
  const f = fixture(await home(t), chrome.connect); t.after(() => f.dispose());
  assert.equal((await f.command('webmcp on')).kind, 'success');
  await f.command('start');
  const discover = () => f.scoped.get('mcp__browser__list_webmcp_tools').execute({ pageId: 1 }, f.exec);
  await discover();
  const exec = { ...f.exec, name: 'mcp__browser__execute_webmcp_tool', callId: 'reviewed-site-tool', arguments: { pageId: 1, toolName: 'save' } };
  const admit = action => f.hooks.get('tools/pre-execute')(action, () => ({ kind: 'allow' }));
  assert.equal((await admit(exec)).kind, 'allow');
  documentId = 'after-reload';
  await discover();
  await assert.rejects(f.scoped.get(exec.name).execute(exec.arguments, exec), /document changed after review/);
  assert(!chrome.calls.some(call => call.name === 'execute_webmcp_tool'));
  const fresh = { ...exec, callId: 'reviewed-new-document' };
  assert.equal((await admit(fresh)).kind, 'allow');
  await f.scoped.get(fresh.name).execute(fresh.arguments, fresh);
  assert.equal(chrome.calls.filter(call => call.name === 'execute_webmcp_tool').length, 1);
});

test('browser starts lazily, exposes tools only to its agent, and cleans up on turn completion', async t => {
  const f = fixture(await home(t));
  assert.equal(f.connections.length, 0); assert.equal(f.scoped.size, 0); assert.equal(f.skills[0].name, 'browser-use');
  await Promise.all([f.global.get('browser_start').execute({}, f.exec), f.global.get('browser_start').execute({}, f.exec)]);
  assert.equal(f.connections.length, 1); assert(f.scoped.has('mcp__browser__click')); assert(!f.global.has('mcp__browser__click'));
  assert.equal((await f.command('use isolated')).kind, 'error');
  const tool = f.scoped.get('mcp__browser__new_page');
  await tool.execute({ url: 'https://temp.example' }, f.exec);
  await f.hooks.get('agent/turn-stopping')({ agent: f.agent });
  assert(f.connections[0].calls.some(call => call.name === 'close_page' && call.args.pageId === 2));
  assert.equal((await f.command('stop')).kind, 'success'); assert.equal(f.scoped.size, 0);
  assert.equal((await f.command('use isolated')).kind, 'success');
  assert.equal((await f.command('start')).kind, 'success'); assert.equal(f.connections.length, 2);
  assert.equal((await f.command('status extra')).kind, 'error');
  await f.hooks.get('agent/disposed')({ agent: f.agent }); assert.equal(f.scoped.size, 0);
  await f.dispose();
});

test('browser commands and retained tabs survive ordinary turn cleanup', async t => {
  const f = fixture(await home(t));
  assert.equal((await f.command('use connect http://example.com')).kind, 'error');
  assert.equal((await f.command('use persistent work')).kind, 'success');
  await f.command('start');
  await f.scoped.get('mcp__browser__new_page').execute({ url: 'https://handoff.example' }, f.exec);
  await f.global.get('browser_tabs').execute({ action: 'keep', pageId: 2 }, f.exec);
  await f.hooks.get('agent/turn-stopping')({ agent: f.agent });
  assert(!f.connections[0].calls.some(call => call.name === 'close_page'));
  assert.equal((await f.command('tabs')).kind, 'success');
  assert.equal((await f.command('cleanup')).kind, 'success');
  assert.match((await f.command('status')).text, /work/);
  assert.equal((await f.command('keep 999')).kind, 'error');
  await f.scoped.get('mcp__browser__new_page').execute({ url: 'https://denied.example' }, f.exec);
  f.hooks.get('tools/result')({ ...f.exec, name: 'mcp__browser__close_page', arguments: { pageId: 3 } }, { isError: true });
  await f.hooks.get('agent/turn-stopping')({ agent: f.agent });
  assert(!f.connections[0].calls.some(call => call.name === 'close_page' && call.args.pageId === 3), 'cleanup cannot bypass a rejected close');
  await f.dispose(); assert(f.connections[0].closed());
});

test('only bounded browser reads bypass MCP action review', () => {
  assert.equal(needsMcpApproval('browser_stop'), true);
  assert.equal(needsMcpApproval('mcp__browser__take_snapshot', { pageId: 1 }), false);
  for (const [name, args] of [['evaluate_script', {}], ['click', {}], ['take_screenshot', {}], ['take_snapshot', { filePath: '/tmp/snapshot' }], ['get_network_request', { responseFilePath: '/tmp/body' }], ['list_unknown', {}]]) assert(needsMcpApproval(`mcp__browser__${name}`, args));
});

test('handoff pauses queued browser operations and cleanup until a user command resumes control', async t => {
  const f = fixture(await home(t));
  await f.command('start');
  await f.scoped.get('mcp__browser__new_page').execute({ url: 'https://login.example' }, f.exec);
  const handoff = f.global.get('browser_handoff').execute({ pageId: 2, reason: 'Sign in and complete 2FA.' }, f.exec);
  const stopped = f.global.get('browser_stop').execute({}, f.exec);
  const blocked = f.scoped.get('mcp__browser__click').execute({ pageId: 2, uid: 'old' }, f.exec);
  const results = await Promise.allSettled([handoff, blocked, stopped]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].status, 'rejected');
  assert.equal(results[0].value.handoff.pageId, 2);
  assert(results[0].value.pages.find(p => p.id === 2).kept);
  assert(f.connections[0].calls.some(c => c.name === 'select_page' && c.args.bringToFront));
  await assert.rejects(f.global.get('browser_stop').execute({}, f.exec), /handed to the user/);
  await assert.rejects(f.scoped.get('mcp__browser__take_snapshot').execute({ pageId: 2 }, f.exec), /handed to the user/);
  await f.hooks.get('agent/turn-stopping')({ agent: f.agent });
  assert.equal((await f.global.get('browser_tabs').execute({ action: 'cleanup' }, f.exec)).skipped, 'user-handoff');
  assert(!f.connections[0].calls.some(c => ['click', 'close_page', 'take_snapshot'].includes(c.name)));
  const preflight = f.hooks.get('tools/pre-execute');
  const unexpected = () => { throw Error('Paused tools must not reach approval or execution'); };
  assert.equal((await preflight({ ...f.exec, name: 'browser_stop' }, unexpected)).kind, 'deny');
  assert.equal((await preflight({ ...f.exec, name: 'mcp__browser__click' }, unexpected)).kind, 'deny');
  assert.equal((await preflight({ ...f.exec, name: 'mcp__browser__list_pages' }, () => ({ kind: 'allow' }))).kind, 'allow');
  assert.match((await f.command('status')).text, /waiting for you/);
  const status = JSON.parse((await f.command('tabs --json')).text);
  assert.equal(status.handoff.reason, 'Sign in and complete 2FA.');
  assert(!f.global.has('browser_resume'), 'only a human command resumes control');
  const resumed = JSON.parse((await f.command('resume --json')).text);
  assert.equal(resumed.handoff, null);
  assert.equal(resumed.resumedPageId, 2);
  await f.scoped.get('mcp__browser__take_snapshot').execute({ pageId: 2 }, f.exec);
  assert(f.connections[0].calls.some(c => c.name === 'take_snapshot'));
  // A user may also take over a pre-existing tab and explicitly stop the browser.
  assert.equal((await f.command('handoff 1')).kind, 'success');
  assert.equal(JSON.parse((await f.command('status --json')).text).pages.find(p => p.id === 1).owned, false);
  assert.equal((await f.command('stop')).kind, 'success');
  await f.dispose();
});

test('handoff stays paused on focus/refresh failure and discards a restarted page identity', async t => {
  const chrome = fakeChrome();
  const b = new BrowserConnection({ home: await home(t), sessionId: 'handoff', config: {}, connect: chrome.connect });
  await b.start();
  await assert.rejects(b.takeHandoff(999, 'Sign in'), /unavailable/);
  assert.equal(b.status().handoff, null);
  const raw = chrome.client.callTool;
  chrome.client.callTool = async request => request.name === 'select_page' ? { isError: true, content: [] } : raw(request);
  assert((await b.takeHandoff(1, 'Sign in')).handoff.focusError);
  chrome.client.callTool = async () => ({ isError: true, content: [] });
  await assert.rejects(b.resume(), /remains paused/);
  assert(b.handoff);
  chrome.client.callTool = async () => ({ content: [], structuredContent: { reconnected: true, pages: [{ id: 1, url: 'https://different.example' }] } });
  assert.equal((await b.resume()).resumedPageId, null);
  assert.equal(b.handoff, null);
  await b.close();
});

test('browser status is readable, escapes terminal control text and exposes machine output explicitly', () => {
  const rendered = formatStatus({ connected: true, mode: 'persistent', headless: false, observedAt: '2026-10-01T12:00:00Z', pages: [{ id: 2, owned: true, kept: true, url: 'https://test/\x1b[2J\nforged-status' }], handoff: { pageId: 2, reason: 'Login\u202e' } });
  assert.match(rendered, /waiting for you/);
  assert.match(rendered, /2 \[agent, kept, handoff\]/);
  assert.match(rendered, /\/browser resume/);
  assert(!/[\x1b\u202e]/.test(rendered));
  assert(!rendered.includes('\nforged-status'));
});

test('waiting for an asynchronous tab only reads page lists, excludes old tabs and never claims ownership', async t => {
  const chrome = fakeChrome();
  const b = new BrowserConnection({ home: await home(t), sessionId: 'popup', config: {}, connect: chrome.connect });
  await b.start();
  const original = chrome.client.callTool;
  let reads = 0;
  chrome.client.callTool = async request => {
    assert.equal(request.name, 'list_pages');
    if (++reads === 3) chrome.userTab();
    return original(request);
  };
  const result = await b.waitForPage({ urlContains: 'example', excludePageIds: [1], timeoutMs: 2000 });
  assert.equal(result.page.id, 2);
  assert.equal(reads, 3);
  assert.equal(b.owned.size, 0);
  await assert.rejects(b.waitForPage({ urlContains: 'example' }), /Several tabs/);
  await assert.rejects(b.waitForPage({ urlContains: 'missing', timeoutMs: 10 }), /Timed out/);
  assert(chrome.calls.every(call => call.name === 'list_pages'));
  await b.close();
});

test('tab waits honor cancellation, handoff and connection-generation boundaries', async t => {
  const chrome = fakeChrome();
  const b = new BrowserConnection({ home: await home(t), sessionId: 'popup-guards', config: {}, connect: chrome.connect });
  await b.start();
  await assert.rejects(b.waitForPage({ urlContains: '' }), /substring/);
  await assert.rejects(b.waitForPage({ urlContains: 'example', timeoutMs: 30001 }), /30000/);
  await assert.rejects(b.waitForPage({ urlContains: 'example', excludePageIds: ['1'] }), /integer/);
  const controller = new AbortController(); controller.abort(Error('user cancelled'));
  await assert.rejects(b.waitForPage({ urlContains: 'missing' }, controller.signal), /user cancelled/);
  await b.takeHandoff(1, 'Manual step');
  await assert.rejects(b.waitForPage({ urlContains: 'example' }), /handed to the user/);
  await b.resume();
  chrome.client.callTool = async () => ({ content: [], structuredContent: { reconnected: true, pages: [{ id: 1, url: 'https://example' }] } });
  await assert.rejects(b.waitForPage({ urlContains: 'example' }), /restarted while waiting/);
  await b.close();
});

test('file tools enforce roots even for attachments and reject symlink escapes', async t => {
  const { checkFileArguments } = await import('../plugins/browser/files.mjs');
  const { symlink, mkdir } = await import('node:fs/promises');
  const root = await home(t), outside = await home(t);
  await writeFile(join(root, 'upload'), 'fixture');
  await checkFileArguments({ filePaths: [join(root, 'upload')], responseFilePath: join(root, 'new/result.txt') }, [root]);
  await assert.rejects(checkFileArguments({ filePath: join(outside, 'result') }, [root]), /outside/);
  await assert.rejects(checkFileArguments({ filePaths: ['relative.txt'] }, [root]), /absolute/);
  await symlink(outside, join(root, 'escape'));
  await assert.rejects(checkFileArguments({ filePath: join(root, 'escape', 'new.txt') }, [root]), /outside/);
  await symlink(join(outside, 'not-created'), join(root, 'dangling'));
  await assert.rejects(checkFileArguments({ filePath: join(root, 'dangling', 'new.txt') }, [root]), /outside/);
});

test('failed startup releases its connection and can be retried without leaked tools', async t => {
  const dir = await home(t), chrome = fakeChrome();
  chrome.client.listTools = async () => { throw Error('discovery failed'); };
  const browser = new BrowserConnection({ home: dir, sessionId: 'failure', config: {}, connect: chrome.connect });
  await assert.rejects(browser.start(), /discovery failed/);
  assert(chrome.closed());
  await assert.rejects(browser.start(), /closed/);
  const missing = fakeChrome();
  missing.client.callTool = async () => ({ isError: true, content: [{ type: 'text', text: 'Chrome executable missing' }] });
  const unavailable = new BrowserConnection({ home: dir, sessionId: 'missing', config: {}, connect: missing.connect });
  await assert.rejects(unavailable.start(), /Chrome executable missing/);
  assert(missing.closed());
});

test('stop and disposal cancel pending startup without registering late tools or leaking Chrome', async t => {
  const early = fixture(await home(t));
  const starting = early.global.get('browser_start').execute({}, early.exec);
  const results = await Promise.allSettled([starting, early.dispose()]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(early.connections.length, 0, 'disposal while reading configuration must not launch Chrome');
  await assert.rejects(early.global.get('browser_start').execute({}, early.exec), /disposed/);

  const chrome = fakeChrome();
  let finishConnect, entered;
  const connecting = new Promise(resolve => { entered = resolve; });
  const f = fixture(await home(t), async () => { entered(); await new Promise(resolve => { finishConnect = resolve; }); return chrome.connect(); });
  const pendingStart = f.global.get('browser_start').execute({}, f.exec);
  await connecting;
  const stopping = f.command('stop');
  finishConnect();
  const finished = await Promise.allSettled([pendingStart, stopping]);
  assert.equal(finished[0].status, 'rejected');
  assert.equal(finished[1].value.kind, 'success');
  assert(chrome.closed(), 'late transport must be closed before stop completes');
  assert.equal(f.scoped.size, 0);
  await f.dispose();
});

for (const [tool, field] of [['take_snapshot', 'filePath'], ['upload_file', 'filePaths']]) {
  test(`queued ${tool} rechecks a symlink changed after initial file validation`, async t => {
    const { symlink, mkdir, unlink } = await import('node:fs/promises');
    const { browserForAgent } = await import('../plugins/browser/review.mjs');
    const root = await home(t), outside = await home(t), inside = join(root, 'inside'), link = join(root, 'chosen');
    await mkdir(inside); await writeFile(join(inside, 'fixture.txt'), 'inside'); await writeFile(join(outside, 'fixture.txt'), 'outside');
    await symlink(inside, link);
    const chrome = fakeChrome(), tools = chrome.client.listTools;
    chrome.client.listTools = async () => ({ tools: [...(await tools()).tools, { name: 'upload_file', inputSchema: { type: 'object', properties: {} } }] });
    const f = fixture(root, chrome.connect); t.after(() => f.dispose());
    assert.equal((await f.command('start')).kind, 'success');
    const browser = browserForAgent(f.agent), release = Promise.withResolvers(), entered = Promise.withResolvers(), queued = Promise.withResolvers();
    const blocker = browser.enqueue(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const enqueue = browser.enqueue.bind(browser);
    browser.enqueue = action => { queued.resolve(); return enqueue(action); };
    const path = join(link, 'fixture.txt');
    const outcome = f.scoped.get(`mcp__browser__${tool}`).execute({ pageId: 1, [field]: field === 'filePaths' ? [path] : path }, f.exec)
      .then(value => ({ value }), error => ({ error }));
    try {
      await queued.promise; // The initial file check completed, but dispatch is still queued.
      await unlink(link); await symlink(outside, link);
    } finally { release.resolve(); }
    await blocker;
    const result = await outcome;
    assert.match(result.error?.message ?? '', /outside the workspace/);
    assert(!chrome.calls.some(call => call.name === tool), 'The rejected file action must not reach Chrome');
    await unlink(link); await symlink(inside, link);
    await f.scoped.get(`mcp__browser__${tool}`).execute({ pageId: 1, [field]: field === 'filePaths' ? [path] : path }, f.exec);
    assert.equal(chrome.calls.filter(call => call.name === tool).length, 1, 'A new valid request can proceed');
  });
}
