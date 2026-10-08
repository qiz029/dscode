import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// An installed package can supply the implementation and its resolved dependencies.
export async function verifyBrowserAccess(implementationRoot = resolve(import.meta.dirname, '..')) {
  const { BrowserConnection } = await import(pathToFileURL(join(implementationRoot, 'plugins/browser/connection.mjs')));
  const { BrowserAccess } = await import(pathToFileURL(join(implementationRoot, 'plugins/browser/access.mjs')));
  const { BrowserPreview } = await import(pathToFileURL(join(implementationRoot, 'plugins/browser/preview.mjs')));

  const home = await mkdtemp(join(tmpdir(), 'dscode-webmcp-'));
  let writes = 0, deniedRequests = 0, developerRequests = 0, admissionRequests = 0, queuedWrites = 0;
  let pendingResponse;
  const developerEntered = Promise.withResolvers(), saveEntered = Promise.withResolvers();
  const queueEntered = Promise.withResolvers();
  function hold(res, entered) {
    pendingResponse = res;
    entered.resolve();
  }
  const denied = createServer((_req, res) => { deniedRequests++; res.end('<h1>Private destination content</h1>'); });
  await new Promise(resolve => denied.listen(0, '127.0.0.1', resolve));
  const other = `http://127.0.0.1:${denied.address().port}`;
  const server = createServer((req, res) => {
    if (req.url === '/queue-block') { hold(res, queueEntered); return; }
    if (req.url === '/queue-write') { queuedWrites++; res.end('queue-write-completed'); return; }
    if (req.url === '/dispatch-admission') admissionRequests++;
    if (req.url === '/developer-data') { developerRequests++; hold(res, developerEntered); return; }
    if (req.url === '/save') {
      writes++;
      if (writes === 2) hold(res, saveEntered);
      else res.end('saved-once');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>WebMCP fixture</title><h1 style="color: rgb(12, 34, 56)">Site tool fixture</h1><output>Loading</output>
  <button id="change">Change registration</button><button id="redirect">Leave site</button>
  <script type="module">
  let controller;
  async function register(description) {
    controller?.abort(); controller = new AbortController();
    await document.modelContext.registerTool({name:'save_fixture',description,
      inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']},
      annotations:{readOnlyHint:false},execute:async ({value})=>{
        const result=await fetch('/save',{method:'POST',body:value}).then(r=>r.text());
        document.querySelector('output').textContent=result; return result;
      }},{signal:controller.signal});
  }
  try { await register('Save the local disposable fixture'); document.querySelector('output').textContent='Tools ready'; }
  catch(error) { document.querySelector('output').textContent='WebMCP unavailable: '+error.message; }
  document.querySelector('#change').onclick=async()=>{ await register('A changed effect requires rediscovery'); document.querySelector('output').textContent='Registration changed'; };
  document.querySelector('#redirect').onclick=()=>{location.href=${JSON.stringify(other)};};
  </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = new BrowserConnection({ home, sessionId: 'webmcp', config: { mode: 'isolated', headless: true, webmcp: true,
    ...(process.env.DSCODE_TEST_CHROME ? { executablePath: process.env.DSCODE_TEST_CHROME } : {}) } });
  const text = result => result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  async function call(name, args) {
    const result = await browser.call(name, args);
    assert(!result.isError, `${name}: ${text(result)}`);
    return result;
  }
  function uid(result, label) {
    const line = text(result).split('\n').find(l => l.includes(label));
    assert(line, `Missing ${label}: ${text(result)}`);
    return line.match(/uid=([^\s]+)/)[1];
  }
  async function revokeDuring(operation, entered, action, value, expected) {
    // Attach a rejection handler immediately; an early failure must not leave
    // the probe waiting for a request that will never reach the fixture server.
    const outcome = operation.then(result => ({ result }), error => ({ error }));
    let timeout;
    try {
      await Promise.race([
        entered,
        outcome.then(({ error }) => { throw error ?? Error('Operation completed before the fixture request'); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Fixture request timed out')), 15000); }),
      ]);
      await browser.access.update(action, value);
      pendingResponse.end('fixture-result-after-revocation');
      pendingResponse = undefined;
      const settled = await outcome;
      assert(settled.error, 'Revoked access must withhold the result');
      assert.match(settled.error.message, expected);
      assert.match(settled.error.message, /do not replay/);
    } finally {
      clearTimeout(timeout);
      pendingResponse?.end('fixture-cleanup');
      pendingResponse = undefined;
    }
  }
  async function queuedCancellation(pageId) {
    const deadline = async (promise, message, milliseconds) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(message)), milliseconds); })]); }
      finally { clearTimeout(timer); }
    };
    const blocker = browser.call('evaluate_script', { pageId, function: 'async () => await fetch("/queue-block").then(r => r.text())' })
      .then(result => ({ result }), error => ({ error }));
    let cancelled;
    try {
      await deadline(Promise.race([queueEntered.promise, blocker.then(({ error }) => { throw error ?? Error('Blocking read returned too early'); })]), 'Queue fixture did not receive the read', 15000);
      const controller = new AbortController(), reason = Error('Cancel before browser dispatch');
      cancelled = browser.call('evaluate_script', { pageId, function: 'async () => await fetch("/queue-write", {method:"POST"}).then(r => r.text())' }, controller.signal)
        .then(result => ({ result }), error => ({ error }));
      controller.abort(reason);
      const outcome = await deadline(cancelled, 'Queued cancellation waited for the blocked Chrome read', 1000);
      assert.equal(outcome.error, reason);
      assert.equal(queuedWrites, 0);
      assert.equal(pendingResponse.writableEnded, false, 'The earlier Chrome request must still own the queue');
    } finally {
      pendingResponse?.end('queue-read-completed'); pendingResponse = undefined;
      const outcome = await blocker;
      if (cancelled) await cancelled;
      assert(!outcome.error, outcome.error?.message);
      assert.match(text(outcome.result), /queue-read-completed/);
    }
    await call('list_pages', {});
    assert.equal(queuedWrites, 0, 'Cancelled queued writes must not run after the earlier read finishes');
    await call('evaluate_script', { pageId, function: 'async () => await fetch("/queue-write", {method:"POST"}).then(r => r.text())' });
    assert.equal(queuedWrites, 1, 'A new explicit action remains usable after queue cancellation');
    console.log('BROWSER_QUEUED_CANCELLATION_PASSED: cancellation settles while an earlier Chrome read is held; zero cancelled writes, no later replay, and one fresh explicit write.');
  }
  async function capturedResultBoundary(change) {
    const temporary = change === 'temporary-revoked';
    const tool = temporary ? 'take_snapshot' : 'evaluate_script';
    await browser.access.update('allow', origin);
    await browser.access.update('allow', other);
    await browser.access.update('developer-mode', 'on');
    await browser.access.update('developer-allow', origin);
    await browser.access.update('developer-allow', other);
    if (temporary) { await browser.access.update('forget', origin); await browser.access.update('once', origin); }
    const pageId = (await call('new_page', { url: origin })).structuredContent.pages.find(p => p.selected).id;
    await call('wait_for', { pageId, text: ['Tools ready'], timeout: 10000 });
    const original = browser.client.callTool;
    const native = original.bind(browser.client);
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let reads = 0, timeout;
    // Hold the actual MCP result after Chrome read it; use native MCP commands
    // to simulate a concurrent external navigation or tab closure.
    browser.client.callTool = async (request, ...rest) => {
      const result = await native(request, ...rest);
      if (request.name === tool && request.arguments.pageId === pageId) {
        assert(!result.isError, text(result));
        assert.match(text(result), /WebMCP fixture/);
        reads++;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const outcome = browser.call(tool, { pageId, ...(!temporary ? { function: '() => document.title' } : {}) })
      .then(result => ({ result }), error => ({ error }));
    try {
      await Promise.race([
        entered.promise,
        outcome.then(({ error }) => { throw error ?? Error('Read completed before the fixture held its result'); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Fixture read timed out')), 15000); }),
      ]);
      if (temporary) {
        const otherSession = new BrowserAccess(home);
        await otherSession.update('block', origin); await otherSession.update('forget', origin);
      } else {
        const changed = await native({ name: change === 'page-closed' ? 'close_page' : 'navigate_page',
          arguments: { pageId, ...(change === 'page-closed' ? {} : { url: other }) } });
        assert(!changed.isError, text(changed));
        if (change !== 'page-closed') await browser.access.update(change === 'site-block' ? 'block' : 'developer-block', origin);
      }
      release.resolve();
      const settled = await outcome;
      assert(settled.error, `Captured result escaped after ${change}`);
      assert.match(settled.error.message, temporary ? /output withheld.*needs user permission/ : change === 'page-closed' ? /output withheld.*unavailable/ :
        change === 'site-block' ? /output withheld.*blocked/ : /output withheld.*Developer access/);
      assert.match(settled.error.message, /do not replay/);
      assert.equal(reads, 1, 'captured reads must not replay');
    } finally {
      clearTimeout(timeout);
      release.resolve();
      await outcome;
      browser.client.callTool = original;
    }
    if (temporary) {
      assert(!(await browser.access.status()).sessionSites.includes(origin));
      await browser.access.update('once', origin);
      assert.match(text(await call('take_snapshot', { pageId })), /Site tool fixture/);
    }
  }
  async function annotationAdmissionBoundary(change) {
    await browser.access.update('allow', origin);
    await browser.access.update('allow', other);
    await browser.access.update('developer-mode', 'off');
    let pageId = (await call('new_page', { url: origin })).structuredContent.pages.find(page => page.selected).id;
    const preview = new BrowserPreview(browser), frame = await preview.capture(pageId);
    const originalListing = browser.client.callTool;
    const messages = [];
    const agent = { session: { requestHeader: () => undefined }, options: { provider: 'fixture', model: 'scripted' }, followup: message => messages.push(message) };
    const context = mutate => ({ get: name => name === 'attachments' ? { saveImage: async () => {
      if (mutate) {
        // Native MCP simulates a user changing Chrome while attachment storage
        // yields. Leave BrowserConnection's observed-page cache untouched.
        const result = await browser.client.callTool({ name: change === 'closed' ? 'close_page' : 'navigate_page',
          arguments: { pageId, ...(change === 'closed' ? {} : change === 'reloaded' ? { type: 'reload' } : { url: other }) } });
        assert(!result.isError, text(result));
        assert.equal(browser.pages.find(page => page.id === pageId)?.url, frame.url);
        if (change === 'reloaded') {
          const page = result.structuredContent.pages.find(page => page.id === pageId);
          assert.equal(page.url, frame.url);
          assert.notEqual(page.documentId, frame.documentId);
          assert.equal(browser.pages.find(page => page.id === pageId)?.documentId, frame.documentId);
        }
        if (change === 'missing-metadata') browser.client.callTool = async (request, ...rest) => {
          const listing = await originalListing.call(browser.client, request, ...rest);
          if (request.name === 'list_pages') delete listing.structuredContent.pages;
          return listing;
        };
      }
      return { id: 'annotation-fixture-image' };
    } } : { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } });
    try {
      await assert.rejects(preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Do not enqueue after external page change' }, context(true), agent), change === 'missing-metadata' ? /page list.*unavailable/ : /page changed/);
    } finally { browser.client.callTool = originalListing; }
    assert.equal(messages.length, 0);
    if (change === 'closed') pageId = (await call('new_page', { url: origin })).structuredContent.pages.find(page => page.selected).id;
    const fresh = await preview.capture(pageId);
    const input = { token: fresh.token, x: 0.5, y: 0.5, text: 'Fresh screenshot can be sent' };
    assert.equal((await preview.annotate(input, context(false), agent)).sent, true);
    assert.equal(messages.length, 1);
    await assert.rejects(preview.annotate(input, context(false), agent), /expired|replaced/);
  }
  async function navigationScriptBoundary() {
    await browser.access.update('allow', origin);
    await browser.access.update('allow', other);
    await browser.access.update('developer-mode', 'off');
    const pageId = (await call('new_page', { url: origin })).structuredContent.pages.find(p => p.selected).id;
    const initScript = `document.addEventListener('DOMContentLoaded', () => {
      const marker = document.createElement('p'); marker.textContent = 'Injection fixture ran'; document.body.append(marker);
    });`;
    const destinationRequests = deniedRequests;
    await assert.rejects(browser.call('navigate_page', { pageId, url: other, initScript }), /Developer access/);
    assert.equal(deniedRequests, destinationRequests, 'mode denial must happen before navigation');
    await browser.access.update('developer-mode', 'on');
    await browser.access.update('developer-allow', origin);
    await assert.rejects(browser.call('navigate_page', { pageId, url: other, initScript }), /Developer access/);
    assert.equal(deniedRequests, destinationRequests, 'destination Developer denial must happen before navigation');
    await browser.access.update('developer-allow', other);
    await call('navigate_page', { pageId, url: other, initScript });
    assert.match(text(await call('take_snapshot', { pageId })), /Injection fixture ran/);
    await browser.access.update('developer-mode', 'off');
    await call('navigate_page', { pageId, url: origin });
    await call('wait_for', { pageId, text: ['Tools ready'], timeout: 10000 });
    await assert.rejects(browser.call('navigate_page', { pageId, type: 'reload', initScript }), /Developer access/);
  }
  try {
    await browser.start();
    assert(browser.tools.some(t => t.name === 'list_webmcp_tools'), 'Pinned MCP must expose activated WebMCP tools');
    await assert.rejects(browser.call('new_page', { url: origin }), /needs user permission/);
    await browser.access.update('allow', origin);
    const initialCheck = browser.access.check.bind(browser.access);
    let revoked = false;
    browser.access.check = async (...args) => {
      await initialCheck(...args);
      if (!revoked && args[0] === 'new_page') {
        revoked = true;
        await new BrowserAccess(home).update('block', origin);
      }
    };
    try {
      await assert.rejects(browser.call('new_page', { url: origin + '/dispatch-admission' }), /blocked/);
      assert.equal(admissionRequests, 0, 'Revocation after initial permission admission must prevent the actual navigation');
    } finally { browser.access.check = initialCheck; }
    await browser.access.update('allow', origin);
    await call('new_page', { url: origin + '/dispatch-admission' });
    assert.equal(admissionRequests, 1, 'An explicitly reauthorized new request may navigate');
    console.log('BROWSER_DISPATCH_REVOCATION_PASSED: no Chrome navigation after admission-time revocation; explicit reauthorization recovers.');
    const pageId = (await call('new_page', { url: origin })).structuredContent.pages.find(p => p.selected).id;
    await call('wait_for', { pageId, text: ['Tools ready'], timeout: 10000 });
    assert(browser.tools.some(t => t.name === 'get_css_styles'), 'Pinned MCP must expose CSS inspection');
    const cssArgs = { pageId, uid: uid(await call('take_snapshot', { pageId }), 'heading "Site tool fixture"'), pageSize: 10, pageIdx: 0 };
    await assert.rejects(browser.call('get_css_styles', cssArgs), /Developer access/);
    await assert.rejects(browser.call('evaluate_script', { pageId, function: '()=>document.title' }), /Developer access/);
    await browser.access.update('developer-mode', 'on');
    await assert.rejects(browser.call('get_css_styles', cssArgs), /Developer access/);
    await assert.rejects(browser.call('evaluate_script', { pageId, function: '()=>document.title' }), /Developer access/);
    await browser.access.update('developer-allow', origin);
    assert.match(text(await call('get_css_styles', cssArgs)), /color.*rgb\(12,\s*34,\s*56\)/s);
    assert.match(text(await call('evaluate_script', { pageId, function: '()=>document.title' })), /WebMCP fixture/);
    await queuedCancellation(pageId);
    await revokeDuring(browser.call('evaluate_script', { pageId,
      function: "async () => await fetch('/developer-data').then(r => r.text())" }),
    developerEntered.promise, 'developer-mode', 'off', /output withheld.*Developer access/);
    assert.equal(developerRequests, 1, 'a revoked Developer operation must not replay');
    await assert.rejects(browser.call('get_css_styles', cssArgs), /Developer access/);
    console.log('BROWSER_CSS_ACCESS_PASSED: real matched/inline CSS requires both Developer grants; disabling Developer mode revokes access.');
    const listing = await call('list_webmcp_tools', { pageId });
    assert(listing.structuredContent.webmcpTools.some(t => t.name === 'save_fixture'));
    const discoveredDocument = browser.pages.find(page => page.id === pageId).documentId;
    assert(discoveredDocument);
    await call('navigate_page', { pageId, type: 'reload' });
    await call('wait_for', { pageId, text: ['Tools ready'], timeout: 10000 });
    assert.notEqual(browser.pages.find(page => page.id === pageId).documentId, discoveredDocument);
    await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"stale-document"}' }), /Discover/);
    assert.equal(writes, 0, 'Identical registration after same-URL reload must require explicit discovery');
    await call('list_webmcp_tools', { pageId });
    console.log('WEBMCP_DOCUMENT_PASSED: same-URL reload invalidates identical tool definitions without a site write.');
    // Deliver a fault after a real Chrome discovery response. Neither explicit
    // discovery nor execution's revalidation may retain the previous definitions.
    for (const action of ['list_webmcp_tools', 'execute_webmcp_tool']) {
      for (const failure of ['transport', 'error-result']) {
        const original = browser.client.callTool;
        const native = original.bind(browser.client);
        browser.client.callTool = async (request, ...rest) => {
          const result = await native(request, ...rest);
          if (request.name !== 'list_webmcp_tools') return result;
          assert(!result.isError, text(result));
          if (failure === 'transport') throw Error('Fixture discovery transport failed');
          return { isError: true, content: [{ type: 'text', text: 'Fixture discovery unavailable' }] };
        };
        try {
          if (action === 'list_webmcp_tools' && failure === 'error-result') {
            assert.equal((await browser.call(action, { pageId })).isError, true);
          } else {
            await assert.rejects(browser.call(action, { pageId, ...(action === 'execute_webmcp_tool' ? { toolName: 'save_fixture', input: '{"value":"must-not-write"}' } : {}) }), /transport failed|registration or page changed/);
          }
        } finally { browser.client.callTool = original; }
        assert.equal(browser.siteTools.has(pageId), false);
        await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"must-not-write"}' }), /Discover/);
        assert.equal(writes, 0, 'Failed discovery and revalidation must not execute or replay a site action');
        await call('list_webmcp_tools', { pageId });
      }
    }
    await call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"fixture"}' });
    assert.equal(writes, 1);
    let snapshot = await call('take_snapshot', { pageId });
    assert.match(text(snapshot), /saved-once/);
    await call('click', { pageId, uid: uid(snapshot, 'button "Change registration"') });
    await call('wait_for', { pageId, text: ['Registration changed'], timeout: 5000 });
    await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"must-not-write"}' }), /registration or page changed/);
    assert.equal(writes, 1, 'a changed tool must not execute');
    await call('list_webmcp_tools', { pageId });
    await revokeDuring(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"in-flight"}' }),
      saveEntered.promise, 'block', origin, /output withheld.*blocked/);
    assert.equal(writes, 2, 'revocation cannot undo a write already executed, and must not replay it');
    assert.equal(browser.siteTools.has(pageId), false, 'Withheld WebMCP output invalidates its discovery');
    await browser.access.update('allow', origin);
    await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"must-not-repeat-withheld"}' }), /Discover/);
    assert.equal(writes, 2);
    await call('list_webmcp_tools', { pageId });
    const originalExecution = browser.client.callTool;
    browser.client.callTool = async (request, ...rest) => {
      const result = await originalExecution.call(browser.client, request, ...rest);
      if (request.name === 'execute_webmcp_tool') {
        assert(!result.isError, text(result));
        throw Error('Fixture execution response lost after a completed write');
      }
      return result;
    };
    try {
      await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"lost-response"}' }), /may already have completed.*do not replay/i);
    } finally { browser.client.callTool = originalExecution; }
    assert.equal(writes, 3, 'The real site write completed before its response was lost');
    assert.equal(browser.siteTools.has(pageId), false);
    assert(browser.kept.has(pageId), 'Keep the affected owned page for inspection');
    await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"must-not-replay"}' }), /Discover/);
    assert.equal(writes, 3);
    await call('list_webmcp_tools', { pageId });
    assert.equal(writes, 3, 'Rediscovery does not replay the lost-response action');
    console.log('WEBMCP_UNCERTAIN_EXECUTION_PASSED: completed site write, lost response, explicit uncertainty, rediscovery required, no replay.');
    for (const [failure, expectedWrites] of [['transport', 4], ['missing-metadata', 5]]) {
      let wroteBeforeListingFailure = false;
      browser.client.callTool = async (request, ...rest) => {
        if (wroteBeforeListingFailure && request.name === 'list_pages') {
          if (failure === 'transport') throw Error('Fixture post-action page listing failed');
          return { content: [] };
        }
        const result = await originalExecution.call(browser.client, request, ...rest);
        if (request.name === 'execute_webmcp_tool') {
          assert(!result.isError, text(result));
          wroteBeforeListingFailure = true;
        }
        return result;
      };
      try {
        await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"post-listing-failure"}' }), /Could not verify.*may already have completed/);
      } finally { browser.client.callTool = originalExecution; }
      assert.equal(writes, expectedWrites);
      assert.equal(browser.siteTools.has(pageId), false);
      await assert.rejects(browser.call('execute_webmcp_tool', { pageId, toolName: 'save_fixture', input: '{"value":"must-not-repeat-unverified"}' }), /Discover/);
      await call('list_webmcp_tools', { pageId });
      assert.equal(writes, expectedWrites, 'Recovery and rediscovery cannot repeat the unverified write');
    }
    console.log('WEBMCP_POSTCHECK_PASSED: completed site writes with permission withholding or failed page listing require fresh discovery without replay.');
    await assert.rejects(browser.call('new_page', { url: other }), /needs user permission/);
    assert.equal(deniedRequests, 0, 'direct navigation is denied before issuing a request');
    snapshot = await call('take_snapshot', { pageId });
    await assert.rejects(browser.call('click', { pageId, uid: uid(snapshot, 'button "Leave site"') }), /output withheld/);
    assert(deniedRequests > 0, 'a page-initiated redirect can make requests before the boundary is rechecked');
    await assert.rejects(browser.call('take_snapshot', { pageId }), /needs user permission/);
    assert.equal(browser.kept.get(pageId), 'site-permission');
    await browser.access.update('once', other);
    assert.match(text(await call('take_snapshot', { pageId })), /Private destination content/);
    await browser.access.update('block', other);
    await assert.rejects(browser.call('take_snapshot', { pageId }), /blocked/);
    await navigationScriptBoundary();
    for (const change of ['site-block', 'developer-block', 'page-closed', 'temporary-revoked']) await capturedResultBoundary(change);
    for (const change of ['navigated', 'closed', 'reloaded', 'missing-metadata']) await annotationAdmissionBoundary(change);
    console.log('BROWSER_ACCESS_PASSED: real Chrome site grants, navigation-script Developer grants on source and destination, Developer and WebMCP in-flight revocation, captured-source revocation after navigation, temporary grant revocation across block/forget, fresh reauthorization, closure before delivery, discovery/execution/changed-definition refusal, failed discovery and revalidation invalidation, uncertain execution invalidation, five deliberate server-side writes without replay, direct-navigation denial, redirect-output withholding explicit reauthorization, missing page-list refusal, and annotation admission after external navigation/closure with fresh-capture recovery.');
  } finally {
    await browser.close();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => denied.close(resolve))]);
    await rm(home, { recursive: true, force: true });
  }

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyBrowserAccess(process.argv[2] && resolve(process.argv[2]));
}
