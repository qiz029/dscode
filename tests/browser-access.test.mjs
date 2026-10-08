import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserAccess, siteOrigin } from '../plugins/browser/access.mjs';
import { BrowserConnection } from '../plugins/browser/connection.mjs';
import { launchOptions } from '../plugins/browser/config.mjs';
import { needsMcpApproval } from '../plugins/auto-review/policy.mjs';

async function fixture(t, webmcp = false) {
  const home = await mkdtemp(join(tmpdir(), 'browser-access-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let pages = [{ id: 1, url: 'https://one.example/path', documentId: 'document-1', selected: true }], redirect;
  let definitions = [{ name: 'save', description: 'Save the draft', inputSchema: { type: 'object' } }];
  let writes = 0;
  const calls = [];
  const tools = ['list_pages', 'new_page', 'navigate_page', 'take_snapshot', 'click', 'evaluate_script', 'get_network_request', 'close_page', 'list_webmcp_tools', 'execute_webmcp_tool'];
  const client = {
    async listTools() { return { tools: tools.map(name => ({ name })) }; },
    async callTool({ name, arguments: args }) {
      calls.push({ name, args });
      if (name === 'new_page') { pages.forEach(p => p.selected = false); pages.push({ id: 2, url: redirect ?? args.url, documentId: 'document-2', selected: true }); }
      if (name === 'click' && redirect) pages[0].url = redirect;
      if (name === 'navigate_page' && args.url) pages[0].url = args.url;
      if (name === 'execute_webmcp_tool') writes++;
      if (name === 'close_page') pages = pages.filter(p => p.id !== args.pageId);
      return { content: [{ type: 'text', text: name === 'list_pages' ? 'page metadata' : 'private page content' }],
        structuredContent: { pages: structuredClone(pages), ...(name === 'list_webmcp_tools' ? { webmcpTools: structuredClone(definitions) } : {}) } };
    }, async close() {},
  };
  const browser = new BrowserConnection({ home, sessionId: 'fixture', config: { webmcp }, connect: async () => ({ client }) });
  await browser.start();
  t.after(() => browser.close());
  return { home, browser, access: browser.access, calls, writes: () => writes,
    redirect: url => redirect = url, navigate: url => pages[0].url = url, document: value => pages[0].documentId = value, definitions: value => definitions = value };
}

for (const pages of [undefined, null, {}]) {
  test(`unavailable page metadata cannot authorize an action from cached state: ${JSON.stringify(pages)}`, async t => {
    const f = await fixture(t);
    await f.access.update('allow', 'https://one.example');
    f.navigate('https://ungranted.example/');
    const original = f.browser.client.callTool;
    f.browser.client.callTool = async request => request.name === 'list_pages'
      ? { content: [], structuredContent: { pages } } : original(request);
    await assert.rejects(f.browser.call('click', { pageId: 1 }), /page list.*unavailable|page list.*malformed/i);
    await assert.rejects(f.browser.call('list_pages', {}), /page list.*unavailable|page list.*malformed/i);
    assert(!f.calls.some(call => call.name === 'click'));
    f.browser.client.callTool = original;
    await assert.rejects(f.browser.call('click', { pageId: 1 }), /needs user permission/);
    assert(!f.calls.some(call => call.name === 'click'));
    await f.access.update('allow', 'https://ungranted.example');
    await f.browser.call('click', { pageId: 1 });
    assert.equal(f.calls.filter(call => call.name === 'click').length, 1);
  });
}

test('a restart with missing page metadata still invalidates ownership and discovery', async t => {
  const f = await fixture(t, true);
  await f.access.update('allow', 'https://one.example');
  await f.browser.call('new_page', { url: 'https://one.example/owned' });
  await f.browser.call('list_webmcp_tools', { pageId: 2 });
  await f.browser.takeHandoff(2, 'Inspect the fixture');
  const generation = f.browser.generation;
  f.browser.client.callTool = async () => ({ content: [], structuredContent: { reconnected: true } });
  await assert.rejects(f.browser.call('list_pages', {}), /page list.*unavailable/);
  assert.equal(f.browser.generation, generation + 1);
  assert.equal(f.browser.owned.size, 0);
  assert.equal(f.browser.kept.size, 0);
  assert.equal(f.browser.siteTools.size, 0);
  assert.equal(f.browser.handoff.invalidated, true);
});

test('startup without a page list fails and closes its transport', async t => {
  const f = await fixture(t);
  let closed = false;
  const client = { listTools: async () => ({ tools: [] }), callTool: async () => ({ content: [] }), close: async () => { closed = true; } };
  const browser = new BrowserConnection({ home: f.home, sessionId: 'missing-pages', config: {}, connect: async () => ({ client }) });
  await assert.rejects(browser.start(), /page list.*unavailable|page list.*malformed/i);
  assert(closed);
  assert.equal(browser.status().connected, false);
});

test('site grants distinguish origins, default to ask, expire at stop, and honor explicit blocks', async t => {
  const f = await fixture(t);
  assert.equal(siteOrigin('https://ONE.example:443/a'), 'https://one.example');
  for (const value of ['*', 'file:///tmp/a', 'https://user:pw@one.example', 'https://one.example/path', 'https://one.example?x']) assert.throws(() => siteOrigin(value, true));
  await assert.rejects(f.browser.call('take_snapshot', { pageId: 1 }), /needs user permission/);
  assert(!f.calls.some(c => c.name === 'take_snapshot'));
  await f.access.update('once', 'https://one.example');
  await f.browser.call('take_snapshot', { pageId: 1 });
  await assert.rejects(f.access.checkUrl('http://one.example'), /needs user permission/);
  await assert.rejects(f.access.checkUrl('https://one.example:444'), /needs user permission/);
  await assert.rejects(new BrowserAccess(f.home).checkUrl('https://one.example'), /needs user permission/);
  await f.access.update('block', 'https://one.example');
  await assert.rejects(f.access.update('once', 'https://one.example'), /blocked/);
  await assert.rejects(f.browser.call('take_snapshot', { pageId: 1 }), /blocked/);
  await f.access.update('allow', 'https://one.example');
  await new BrowserAccess(f.home).checkUrl('https://one.example');
  assert.equal((await stat(join(f.home, 'permissions.json'))).mode & 0o777, 0o600);
  await f.access.update('forget', 'https://one.example');
  await assert.rejects(f.access.checkUrl('https://one.example'), /needs user permission/);
});

test('Developer grant edits preserve temporary ordinary site access', async t => {
  const f = await fixture(t);
  await f.access.update('once', 'https://one.example');
  await f.access.update('developer-mode', 'on');
  await f.access.update('developer-allow', 'https://one.example');
  await f.browser.call('evaluate_script', { pageId: 1 });
  await f.access.update('developer-block', 'https://one.example');
  await f.browser.call('take_snapshot', { pageId: 1 });
  await assert.rejects(f.browser.call('evaluate_script', { pageId: 1 }), /Developer access/);
  await f.access.update('block', 'https://one.example');
  assert.equal(f.access.once.size, 0, 'ordinary site blocking still clears the temporary grant');
});

test('developer operations require both mode and per-site consent, independently of action review', async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://one.example');
  for (const name of ['evaluate_script', 'get_network_request']) await assert.rejects(f.browser.call(name, { pageId: 1 }), /Developer access/);
  await f.access.update('developer-mode', 'on');
  await assert.rejects(f.browser.call('evaluate_script', { pageId: 1 }), /Developer access/);
  await f.access.update('developer-allow', 'https://one.example');
  await f.browser.call('evaluate_script', { pageId: 1 });
  assert.equal(needsMcpApproval('mcp__browser__evaluate_script'), true, 'developer grant does not exempt arbitrary script from action approval');
  await f.access.update('developer-mode', 'off');
  await assert.rejects(f.browser.call('get_network_request', { pageId: 1 }), /Developer access/);
  await f.browser.call('take_snapshot', { pageId: 1 });
  await assert.rejects(f.access.check('future_unknown_tool', { pageId: 1 }, f.browser.pages), /Developer access/);
});

test('navigation script injection requires Developer grants on source and destination', async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://one.example');
  await f.access.update('allow', 'https://two.example');
  const args = { pageId: 1, url: 'https://two.example', initScript: 'globalThis.fixture = true' };
  await assert.rejects(f.browser.call('navigate_page', args), /Developer access/);
  assert(!f.calls.some(call => call.name === 'navigate_page'));
  await f.access.update('developer-mode', 'on');
  await f.access.update('developer-allow', 'https://one.example');
  await assert.rejects(f.browser.call('navigate_page', args), /Developer access/);
  assert(!f.calls.some(call => call.name === 'navigate_page'), 'destination grant must be checked before injection');
  await f.access.update('developer-allow', 'https://two.example');
  await f.browser.call('navigate_page', args);
  assert.equal(f.calls.filter(call => call.name === 'navigate_page').length, 1);
  await f.access.update('developer-mode', 'off');
  await f.browser.call('navigate_page', { pageId: 1, url: 'https://one.example' });
  await assert.rejects(f.browser.call('navigate_page', { pageId: 1, type: 'reload', initScript: args.initScript }), /Developer access/);
});

test('navigation script output is withheld if Developer permission is revoked during execution', async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://one.example');
  await f.access.update('developer-mode', 'on');
  await f.access.update('developer-allow', 'https://one.example');
  const original = f.browser.client.callTool;
  f.browser.client.callTool = async request => {
    const result = await original(request);
    if (request.name === 'navigate_page') await f.access.update('developer-mode', 'off');
    return result;
  };
  await assert.rejects(f.browser.call('navigate_page', { pageId: 1, type: 'reload', initScript: 'globalThis.fixture = true' }), /output withheld.*Developer access/);
  assert.equal(f.calls.filter(call => call.name === 'navigate_page').length, 1);
});

test('malformed permissions fail closed and serialized updates preserve independent site changes', async t => {
  const f = await fixture(t);
  await Promise.all([f.access.update('allow', 'https://one.example'), new BrowserAccess(f.home).update('block', 'https://two.example')]);
  const saved = JSON.parse(await readFile(join(f.home, 'permissions.json')));
  assert.equal(saved.sites['https://one.example'].access, 'allow');
  assert.equal(saved.sites['https://two.example'].access, 'block');
  for (const content of ['{broken', '{"developerMode":true,"sites":{"*":{"access":"allow","developer":true}}}', '{"developerMode":"yes","sites":{}}',
    ...[null, [], { 'https://one.example': 'invalid' }, { '*': '5585b560-a157-4446-9c1b-58b42dfc1805' }].map(revocations => JSON.stringify({ ...saved, revocations }))]) {
    await writeFile(join(f.home, 'permissions.json'), content);
    await assert.rejects(f.access.checkUrl('https://one.example'));
  }
});

test('revoking Developer permission during an operation withholds its result without replay', async t => {
  for (const revoke of ['developer-mode', 'developer-block']) await t.test(revoke, async t => {
    const f = await fixture(t);
    await f.access.update('allow', 'https://one.example');
    await f.access.update('developer-mode', 'on');
    await f.access.update('developer-allow', 'https://one.example');
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const original = f.browser.client.callTool;
    f.browser.client.callTool = async request => {
      if (request.name === 'evaluate_script') { entered.resolve(); await release.promise; }
      return original(request);
    };
    const operation = f.browser.call('evaluate_script', { pageId: 1, function: '() => "developer data"' });
    await entered.promise;
    await f.access.update(revoke, revoke === 'developer-mode' ? 'off' : 'https://one.example');
    release.resolve();
    await assert.rejects(operation, /output withheld.*Developer access/);
    assert.equal(f.calls.filter(call => call.name === 'evaluate_script').length, 1);
    await f.browser.call('take_snapshot', { pageId: 1 });
  });
});

test('captured output retains its source authorization after navigation or closure', async t => {
  for (const change of ['site-block', 'developer-block', 'page-closed', 'intermediate-origin']) await t.test(change, async t => {
    const f = await fixture(t);
    await f.access.update('allow', 'https://one.example');
    await f.access.update('allow', 'https://two.example');
    await f.access.update('developer-mode', 'on');
    await f.access.update('developer-allow', 'https://one.example');
    await f.access.update('developer-allow', 'https://two.example');
    const original = f.browser.client.callTool;
    f.browser.client.callTool = async request => {
      const result = await original(request);
      if (request.name === 'evaluate_script') {
        if (change === 'page-closed') await original({ name: 'close_page', arguments: { pageId: 1 } });
        else {
          f.navigate('https://two.example');
          if (change === 'intermediate-origin') result.structuredContent.pages[0].url = 'https://ungranted.example';
          else {
            await f.access.update(change === 'site-block' ? 'block' : 'developer-block', 'https://one.example');
            await assert.rejects(f.access.checkUrl('https://one.example/path', true),
              change === 'site-block' ? /blocked/ : /Developer access/);
          }
        }
      }
      return result;
    };
    const expected = change === 'site-block' ? /output withheld.*blocked/ :
      change === 'developer-block' ? /output withheld.*Developer access/ :
      change === 'page-closed' ? /output withheld.*unavailable/ : /output withheld.*needs user permission/;
    await assert.rejects(f.browser.call('evaluate_script', { pageId: 1, function: '() => "captured content"' }), expected);
    assert.equal(f.calls.filter(call => call.name === 'evaluate_script').length, 1);
    if (change !== 'page-closed') await f.browser.call('take_snapshot', { pageId: 1 });
  });
});

test('an explicitly requested close can return after its authorized page disappears', async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://one.example');
  await f.browser.call('close_page', { pageId: 1 });
  assert.equal(f.browser.pages.length, 0);
  assert.equal(f.calls.filter(call => call.name === 'close_page').length, 1);
});

test('redirected output is withheld and the affected tab retained without replay or cleanup', async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://one.example');
  f.redirect('https://two.example/private');
  await assert.rejects(f.browser.call('new_page', { url: 'https://one.example/start' }), /output withheld.*needs user permission/);
  assert.equal(f.calls.filter(c => c.name === 'new_page').length, 1);
  assert.equal(f.browser.kept.get(2), 'site-permission');
  await f.browser.cleanup();
  assert(!f.calls.some(c => c.name === 'close_page'));
  await assert.rejects(f.browser.call('take_snapshot', { pageId: 2 }), /needs user permission/);
  assert(!f.calls.some(c => c.name === 'take_snapshot'));
  await f.access.update('allow', 'https://two.example');
  await f.browser.call('take_snapshot', { pageId: 2 });
});

test('a live navigation or permission revocation invalidates authorization before the next call', async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://one.example');
  await f.browser.call('take_snapshot', { pageId: 1 });
  f.navigate('https://two.example');
  await assert.rejects(f.browser.call('click', { pageId: 1, uid: 'old' }), /needs user permission/);
  assert(!f.calls.some(c => c.name === 'click'));
  f.navigate('https://one.example');
  await new BrowserAccess(f.home).update('block', 'https://one.example');
  await assert.rejects(f.browser.call('click', { pageId: 1, uid: 'old' }), /blocked/);
});

test('approval remains bound to its proposed URL even if both origins are otherwise allowed', async t => {
  const f = await fixture(t);
  await f.access.update('allow', 'https://one.example');
  await f.access.update('allow', 'https://two.example');
  const reviewed = { url: 'https://one.example/path' };
  f.navigate('https://two.example');
  await assert.rejects(f.browser.call('click', { pageId: 1, uid: 'old' }, undefined, reviewed), /changed after the tool was proposed/);
  assert(!f.calls.some(c => c.name === 'click'));
});

for (const documentId of ['reloaded-document', null, undefined]) {
  test(`WebMCP discovery cannot survive a changed or unavailable document: ${documentId}`, async t => {
    const f = await fixture(t, true);
    await f.access.update('allow', 'https://one.example');
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    f.document(documentId);
    await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }), /Discover/);
    assert.equal(f.writes(), 0);
    assert.equal(f.browser.siteTools.has(1), false);
    f.document('fresh-document');
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    await f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' });
    assert.equal(f.writes(), 1);
  });
}

for (const phase of ['discovery-response', 'after-discovery', 'execution-revalidation']) {
  test(`WebMCP refuses a document changed during ${phase}`, async t => {
    const f = await fixture(t, true);
    await f.access.update('allow', 'https://one.example');
    if (phase === 'execution-revalidation') await f.browser.call('list_webmcp_tools', { pageId: 1 });
    const original = f.browser.client.callTool;
    f.browser.client.callTool = async request => {
      if (request.name === 'list_webmcp_tools' && phase !== 'after-discovery') f.document('changed-document');
      const result = await original(request);
      if (request.name === 'list_webmcp_tools' && phase === 'after-discovery') f.document('changed-document');
      return result;
    };
    await assert.rejects(f.browser.call(phase === 'execution-revalidation' ? 'execute_webmcp_tool' : 'list_webmcp_tools',
      { pageId: 1, toolName: 'save' }), /page changed|Page changed|document/i);
    assert.equal(f.writes(), 0); assert.equal(f.browser.siteTools.has(1), false);
  });
}

for (const change of ['none', 'reload', 'missing-metadata']) {
  test(`WebMCP reobserves the document when native discovery omits pages: ${change}`, async t => {
    const f = await fixture(t, true);
    await f.access.update('allow', 'https://one.example');
    const original = f.browser.client.callTool;
    let executing = false, listed = false;
    f.browser.client.callTool = async request => {
      const result = await original(request);
      if (request.name === 'list_webmcp_tools') {
        delete result.structuredContent.pages;
        if (executing) {
          listed = true;
          if (change === 'reload') f.document('replaced-during-native-discovery');
        }
      } else if (request.name === 'list_pages' && listed && change === 'missing-metadata') {
        delete result.structuredContent.pages;
      }
      return result;
    };
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    executing = true;
    const execution = f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' });
    if (change === 'none') { await execution; assert.equal(f.writes(), 1); }
    else {
      await assert.rejects(execution, change === 'missing-metadata' ? /page list.*unavailable/ : /registration or page changed/);
      assert.equal(f.writes(), 0); assert.equal(f.browser.siteTools.has(1), false);
    }
  });
}

test('WebMCP discovery requires an observable document and an old review cannot authorize a rediscovered document', async t => {
  const f = await fixture(t, true);
  await f.access.update('allow', 'https://one.example');
  f.document(null);
  await assert.rejects(f.browser.call('list_webmcp_tools', { pageId: 1 }), /document|Page changed/i);
  assert.equal(f.browser.siteTools.has(1), false);
  f.document('original');
  await f.browser.call('list_webmcp_tools', { pageId: 1 });
  const reviewed = { url: f.browser.pages[0].url, documentId: 'original', definition: f.browser.siteTools.get(1).definitions.get('save') };
  f.document('replacement');
  await f.browser.call('list_webmcp_tools', { pageId: 1 });
  await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }, undefined, reviewed), /changed after.*review|changed after.*proposed/i);
  assert.equal(f.writes(), 0);
});

test('WebMCP requires activation, discovered definitions, fresh registration and ordinary action approval', async t => {
  const f = await fixture(t, true);
  await f.access.update('allow', 'https://one.example');
  await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }), /Discover/);
  await f.browser.call('list_webmcp_tools', { pageId: 1 });
  await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save', input: '[]' }), /JSON object/);
  await f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save', input: '{"value":"yes"}' });
  assert.equal(f.writes(), 1);
  assert.equal(needsMcpApproval('mcp__browser__execute_webmcp_tool', { readOnlyHint: true }), true);
  f.definitions([{ name: 'save', description: 'Changed effect', inputSchema: { type: 'object' } }]);
  await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }), /registration or page changed/);
  assert.equal(f.writes(), 1);
  await f.browser.call('list_webmcp_tools', { pageId: 1 });
  f.navigate('https://one.example/other');
  await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }), /Discover/);
  const disabled = await fixture(t);
  await assert.rejects(disabled.browser.call('list_webmcp_tools', { pageId: 1 }), /disabled/);
  assert(launchOptions(f.home, 'fixture', { webmcp: true }).args.includes('--chrome-arg=--enable-features=WebMCP'));
  assert(!launchOptions(f.home, 'fixture', { mode: 'auto', webmcp: true }).args.some(a => a.startsWith('--chrome-arg')));
});

for (const changes of [['forget'], ['block', 'forget'], ['allow', 'forget']]) {
  test(`another connection's ${changes.join(' then ')} revokes old temporary grants even between checks`, async t => {
    const f = await fixture(t), other = new BrowserAccess(f.home);
    await f.access.update('once', 'https://one.example');
    await f.access.update('once', 'https://unrelated.example');
    await f.access.checkUrl('https://one.example');
    for (const action of changes) await other.update(action, 'https://one.example');
    await assert.rejects(f.access.checkUrl('https://one.example'), /needs user permission/);
    assert.deepEqual((await f.access.status()).sessionSites, ['https://unrelated.example']);
    await f.access.update('once', 'https://one.example');
    await f.browser.call('take_snapshot', { pageId: 1 });
  });
}

for (const failure of ['error-result', 'transport-error', 'unavailable']) {
  test(`failed WebMCP discovery (${failure}) invalidates the previous definitions before any retry`, async t => {
    const f = await fixture(t, true);
    await f.access.update('allow', 'https://one.example');
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    await f.browser.call('new_page', { url: 'https://one.example/other' });
    await f.browser.call('list_webmcp_tools', { pageId: 2 });
    const original = f.browser.client.callTool;
    f.browser.client.callTool = async request => {
      if (request.name !== 'list_webmcp_tools') return original(request);
      if (failure === 'transport-error') throw Error('Discovery transport failed');
      return { isError: failure === 'error-result', content: [{ type: 'text', text: 'Discovery unavailable' }] };
    };
    if (failure === 'error-result') assert.equal((await f.browser.call('list_webmcp_tools', { pageId: 1 })).isError, true);
    else await assert.rejects(f.browser.call('list_webmcp_tools', { pageId: 1 }), /Discovery|discovery/);
    f.browser.client.callTool = original;
    assert.equal(f.browser.siteTools.has(1), false);
    assert.equal(f.browser.siteTools.has(2), true, 'An unrelated page keeps its discovery');
    await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }), /Discover/);
    assert.equal(f.writes(), 0);
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    await f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' });
    assert.equal(f.writes(), 1, 'Fresh discovery permits exactly one requested action');
  });
}

for (const failure of ['error-result', 'transport-error']) {
  test(`failed WebMCP execution revalidation (${failure}) requires explicit rediscovery`, async t => {
    const f = await fixture(t, true);
    await f.access.update('allow', 'https://one.example');
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    const original = f.browser.client.callTool;
    f.browser.client.callTool = async request => {
      if (request.name !== 'list_webmcp_tools') return original(request);
      if (failure === 'transport-error') throw Error('Revalidation transport failed');
      return { isError: true, content: [{ type: 'text', text: 'Revalidation unavailable' }] };
    };
    await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }), /registration|transport/);
    f.browser.client.callTool = original;
    assert.equal(f.browser.siteTools.has(1), false);
    await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' }), /Discover/);
    assert.equal(f.writes(), 0);
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    await f.browser.call('execute_webmcp_tool', { pageId: 1, toolName: 'save' });
    assert.equal(f.writes(), 1);
  });
}

test('lost WebMCP execution responses require inspection and rediscovery without replaying a completed write', async t => {
  const f = await fixture(t, true);
  await f.access.update('allow', 'https://one.example');
  await f.browser.call('list_webmcp_tools', { pageId: 1 });
  await f.browser.call('new_page', { url: 'https://one.example/other' });
  await f.browser.call('list_webmcp_tools', { pageId: 2 });
  const original = f.browser.client.callTool;
  f.browser.client.callTool = async request => {
    const result = await original(request);
    if (request.name === 'execute_webmcp_tool') throw Error('Response transport failed');
    return result;
  };
  await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 2, toolName: 'save' }), /may already have completed.*do not replay/i);
  assert.equal(f.writes(), 1);
  assert.equal(f.browser.siteTools.has(2), false);
  assert.equal(f.browser.siteTools.has(1), true);
  assert.equal(f.browser.kept.get(2), 'uncertain-webmcp');
  f.browser.client.callTool = original;
  await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 2, toolName: 'save' }), /Discover/);
  assert.equal(f.writes(), 1, 'A retry without rediscovery cannot repeat the completed write');
  await f.browser.call('list_webmcp_tools', { pageId: 2 });
  assert.equal(f.writes(), 1, 'Rediscovery itself never replays an action');
  await f.browser.call('execute_webmcp_tool', { pageId: 2, toolName: 'save' });
  assert.equal(f.writes(), 2, 'A deliberately requested new action still works');
});

for (const failure of ['page-list-transport', 'page-list-error', 'page-list-missing', 'permission-revoked']) {
  test(`WebMCP post-execution ${failure} invalidates discovery before recovery`, async t => {
    const f = await fixture(t, true);
    await f.access.update('allow', 'https://one.example');
    await f.browser.call('list_webmcp_tools', { pageId: 1 });
    await f.browser.call('new_page', { url: 'https://one.example/other' });
    await f.browser.call('list_webmcp_tools', { pageId: 2 });
    const original = f.browser.client.callTool;
    let executed = false;
    f.browser.client.callTool = async request => {
      if (executed && request.name === 'list_pages' && failure.startsWith('page-list')) {
        if (failure === 'page-list-transport') throw Error('Post-action listing disconnected');
        if (failure === 'page-list-missing') return { content: [] };
        return { isError: true, content: [{ type: 'text', text: 'Listing unavailable' }] };
      }
      const result = await original(request);
      if (request.name === 'execute_webmcp_tool') {
        executed = true;
        if (failure === 'permission-revoked') await f.access.update('block', 'https://one.example');
      }
      return result;
    };
    await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 2, toolName: 'save' }), /may already have completed.*do not replay/i);
    assert.equal(f.writes(), 1);
    assert.equal(f.browser.siteTools.has(2), false);
    assert.equal(f.browser.siteTools.has(1), true);
    assert(f.browser.kept.has(2));
    f.browser.client.callTool = original;
    await f.access.update('allow', 'https://one.example');
    await assert.rejects(f.browser.call('execute_webmcp_tool', { pageId: 2, toolName: 'save' }), /Discover/);
    assert.equal(f.writes(), 1);
    await f.browser.call('list_webmcp_tools', { pageId: 2 });
    assert.equal(f.writes(), 1);
    await f.browser.call('execute_webmcp_tool', { pageId: 2, toolName: 'save' });
    assert.equal(f.writes(), 2);
  });
}
