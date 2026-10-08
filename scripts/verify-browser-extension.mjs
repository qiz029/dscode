/* global document */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { puppeteer } from '../node_modules/chrome-devtools-mcp/build/src/third_party/index.js';
import { BrowserConnection } from '../plugins/browser/connection.mjs';
import { BrowserPreview } from '../plugins/browser/preview.mjs';
import { createExtensionRelay, extensionId } from '../plugins/browser/extension-relay.mjs';

// Dedicated Chrome for Testing only. Never load this fixture into a user's profile.
const executablePath = process.env.DSCODE_TEST_CHROME;
assert(executablePath, 'Set DSCODE_TEST_CHROME to Chrome for Testing (supports --load-extension).');
const home = await mkdtemp(join(tmpdir(), 'dscode-extension-'));
const extension = resolve(process.argv[2] ?? 'extensions/browser');
const extensionFiles = Object.fromEntries(await Promise.all(
  ['manifest.json', 'popup.html', 'popup.css', 'popup.mjs', 'worker.mjs', 'protocol.mjs'].map(async file =>
    [file, createHash('sha256').update(await readFile(join(extension, file))).digest('hex')])));
const stalledHandshakes = new Set();
const server = createServer((req, res) => {
  if (req.url === '/shared-worker.js' || req.url === '/service-worker.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(req.url === '/shared-worker.js'
      ? 'self.onconnect = event => { const port = event.ports[0]; port.onmessage = message => { console.log("SharedWorker private context", message.data); port.postMessage("SharedWorker result " + message.data); }; port.start(); };'
      : 'self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", event => event.waitUntil(self.clients.claim())); self.onmessage = event => { console.log("ServiceWorker private context", event.data); event.ports[0].postMessage("ServiceWorker result " + event.data); };');
    return;
  }
  if (req.url.startsWith('/worker.js') || req.url.startsWith('/nested-worker.js')) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(req.url.startsWith('/nested-worker.js')
      ? 'self.onmessage = event => { const result = event.data.toUpperCase(); console.log("Nested worker", result); self.postMessage(result); };'
      : 'const child = new Worker("/nested-worker.js"); child.onmessage = event => { console.log("Dedicated worker", event.data); self.postMessage("Worker result " + event.data); }; self.onmessage = event => child.postMessage(event.data);');
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url.startsWith('/frame')) {
    const nextHost = req.headers.host.startsWith('localhost:') ? '127.0.0.1' : 'localhost';
    res.end('<title>Frame fixture</title><label>Frame name<input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save frame</button><output>Frame ready</output><a href="/frame?revision=2">Reload frame</a>' +
      `<a href="http://${nextHost}:${server.address().port}/frame">Switch frame site</a>`);
    return;
  }
  res.end('<title>Extension fixture</title><label>Name<input></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">Save</button><output>Ready</output>' +
    (req.url === '/shared' ? `<iframe title="Cross-site editor" src="http://localhost:${server.address().port}/frame"></iframe>` : '') +
    (['/shared', '/private'].includes(req.url) ? `<button id="worker-run" onclick="worker.postMessage('${req.url === '/shared' ? 'SHARED' : 'PRIVATE'} JOB ' + (++job))">Run worker</button>
      <button onclick="worker.terminate(); startWorker(); document.querySelector('#worker-output').textContent='Worker restarted'">Restart worker</button><output id="worker-output">Worker idle</output>
      <button id="background-run" onclick="runBackground()">Run background workers</button><output id="shared-worker-output">SharedWorker idle</output><output id="service-worker-output">ServiceWorker idle</output>
      <script>
      const backgroundWorker = new SharedWorker('/shared-worker.js', 'same-origin-fixture');
      backgroundWorker.port.onmessage = event => document.querySelector('#shared-worker-output').textContent = event.data;
      const serviceReady = navigator.serviceWorker.register('/service-worker.js').then(() => navigator.serviceWorker.ready);
      let backgroundJob = 0;
      async function runBackground() {
        const job = '${req.url === '/shared' ? 'SHARED' : 'PRIVATE'} BACKGROUND ' + (++backgroundJob);
        backgroundWorker.port.postMessage(job);
        const registration = await serviceReady, channel = new MessageChannel();
        channel.port1.onmessage = event => { document.querySelector('#service-worker-output').textContent = event.data; channel.port1.close(); };
        registration.active.postMessage(job, [channel.port2]);
      }
      let worker, job = 0; function startWorker() { worker = new Worker('/worker.js?owner=${req.url.slice(1)}'); worker.onmessage = event => document.querySelector('#worker-output').textContent=event.data; } startWorker();</script>` : ''));
});
// Accept TCP but withhold the WebSocket upgrade to keep pairing in progress.
server.on('upgrade', (_request, socket) => {
  stalledHandshakes.add(socket);
  socket.on('close', () => stalledHandshakes.delete(socket));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let chrome;
let browser;
let relay;
try {
  relay = await createExtensionRelay();
  chrome = await puppeteer.launch({ executablePath, headless: true, userDataDir: join(home, 'chrome'),
    args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`, '--site-per-process'],
    ignoreDefaultArgs: ['--disable-extensions'], protocolTimeout: 15000 });
  console.log('Disposable Chrome for Testing started.');
  const hidden = await chrome.newPage(); await hidden.goto(url + '/private');
  // Start the shared document after activation so its initial navigation is
  // controlled even when the first registration races the worker's claim().
  await hidden.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const shared = await chrome.newPage(); await shared.goto(url + '/shared');
  await shared.waitForFunction(() => navigator.serviceWorker.controller !== null, { timeout: 10000 });
  const inspector = await chrome.target().createCDPSession();
  const targets = await inspector.send('Target.getTargets');
  assert(targets.targetInfos.some(target => target.type === 'iframe' && target.url === `http://localhost:${server.address().port}/frame`), 'Fixture must use an actual out-of-process iframe');
  const backgroundTargets = targets.targetInfos.filter(target =>
    ['shared_worker', 'service_worker'].includes(target.type) && target.url.startsWith(url));
  assert.deepEqual(backgroundTargets.map(target => target.type).sort(), ['service_worker', 'shared_worker'], 'Both same-origin background target types must exist');
  await inspector.detach();
  let popup = await chrome.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  console.log('Extension popup loaded.');
  await popup.type('#pairing', `ws://127.0.0.1:${server.address().port}/extension?token=${'a'.repeat(64)}`);
  await shared.bringToFront();
  await popup.evaluate(() => document.querySelector('#pair').click());
  for (let i = 0; i < 50 && !stalledHandshakes.size; i++) await delay(100);
  assert.equal(stalledHandshakes.size, 1, 'Pairing must reach the stalled native WebSocket handshake');
  await popup.close();
  popup = await chrome.newPage(); await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() => !document.querySelector('#stop').hidden && document.querySelector('#pair').disabled &&
    document.querySelector('#status').textContent.includes('Pairing'), { timeout: 2000 });
  await popup.evaluate(() => document.querySelector('#stop').click());
  await popup.waitForFunction(() => document.querySelector('#stop').hidden && !document.querySelector('#pair').disabled &&
    document.querySelector('#status').textContent === 'Sharing stopped.', { timeout: 2000 });
  assert.equal(await popup.evaluate(async sharedUrl => {
    const target = (await globalThis.chrome.debugger.getTargets()).find(target => target.tabId && target.url === sharedUrl);
    if (!target) throw Error('Missing shared page after cancellation');
    try { await globalThis.chrome.debugger.sendCommand({ tabId: target.tabId }, 'Target.getTargetInfo'); }
    catch (error) { return /Debugger is not attached/i.test(error.message); }
    return false;
  }, url + '/shared'), true, 'The extension must lose debugger access after stopping its handshake');
  console.log('Reopened popup exposes pending pairing; stop cancels the native handshake promptly and detaches the tab.');
  await popup.type('#pairing', relay.pairingUrl);
  // The extension popup reads the focused tab when clicked, as it does from the toolbar.
  await shared.bringToFront();
  await popup.evaluate(() => document.querySelector('#pair').click());
  for (let i = 0; i < 100 && !relay.ready; i++) await delay(100);
  assert(relay.ready, await popup.$eval('#status', e => e.textContent));
  await popup.waitForFunction(async () => await globalThis.chrome.action.getBadgeText({}) === 'ON', { timeout: 5000 });
  console.log('Extension paired with the selected fixture tab.');
  await shared.evaluate(() => { document.title = 'Renamed shared fixture'; });
  // The target page is focused; do not depend on animation frames in the popup.
  await popup.waitForFunction(() => document.querySelector('#tabs').textContent.includes('Renamed shared fixture'), { timeout: 5000, polling: 100 });
  await shared.evaluate(() => { document.title = 'Extension fixture'; });
  browser = new BrowserConnection({ home, sessionId: 'extension-verification', config: { mode: 'extension' }, relay });
  await browser.access.update('allow', url);
  await browser.start();
  console.log('MCP connected to the extension bridge.');
  assert.equal(browser.pages.length, 1);
  assert.equal(browser.pages[0].url, url + '/shared');
  const pageId = browser.pages[0].id;
  const text = r => r.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const call = async (name, args) => { const result = await browser.call(name, args); assert(!result.isError, `${name}: ${text(result)}`); return result; };
  const uid = (r, label) => { const line = text(r).split('\n').find(line => line.includes(label)); assert(line, text(r)); return line.match(/uid=([^\s]+)/)[1]; };
  const preview = new BrowserPreview(browser), captured = await preview.capture(pageId), annotationMessages = [];
  assert.equal(typeof captured.documentId, 'string');
  await shared.reload(); // External navigation: BrowserConnection still holds the old observation.
  assert.equal(browser.pages[0].documentId, captured.documentId);
  const annotationContext = { get: name => name === 'attachments' ? { saveImage: async () => ({ id: 'extension-fixture-image' }) } :
    { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } };
  const annotationAgent = { session: { requestHeader: () => undefined }, options: { provider: 'fixture', model: 'scripted' }, followup: message => annotationMessages.push(message) };
  await assert.rejects(preview.annotate({ token: captured.token, x: 0.5, y: 0.5, text: 'Old document' }, annotationContext, annotationAgent), /page changed/);
  assert.equal(annotationMessages.length, 0);
  assert.equal(browser.pages[0].url, captured.url);
  assert.notEqual(browser.pages[0].documentId, captured.documentId);
  const fresh = await preview.capture(pageId);
  await preview.annotate({ token: fresh.token, x: 0.5, y: 0.5, text: 'Fresh document' }, annotationContext, annotationAgent);
  assert.equal(annotationMessages.length, 1);
  assert.equal((await browser.access.status()).developerMode, false);
  console.log('Same-URL reload invalidates extension preview; fresh capture sends without Developer access.');
  const childCapture = await preview.capture(pageId), mainLoader = shared.mainFrame()._loaderId;
  const child = shared.frames().find(frame => frame.url() === `http://localhost:${server.address().port}/frame`);
  assert(child, 'Shared page must contain the cross-process fixture');
  await child.goto(child.url());
  assert.equal(shared.mainFrame()._loaderId, mainLoader);
  assert.equal(browser.pages.find(page => page.id === pageId).documentId, childCapture.documentId);
  await assert.rejects(preview.annotate({ token: childCapture.token, x: 0.5, y: 0.5, text: 'Old iframe document' }, annotationContext, annotationAgent), /page changed/);
  assert.equal(annotationMessages.length, 1);
  const childFresh = await preview.capture(pageId);
  await preview.annotate({ token: childFresh.token, x: 0.5, y: 0.5, text: 'Fresh iframe document' }, annotationContext, annotationAgent);
  assert.equal(annotationMessages.length, 2);
  console.log('Cross-process iframe reload invalidates extension preview while the main document stays unchanged.');
  let snapshot = await call('take_snapshot', { pageId });
  await call('fill', { pageId, uid: uid(snapshot, 'textbox "Name"'), value: 'Extension saved' });
  snapshot = await call('take_snapshot', { pageId });
  await call('click', { pageId, uid: uid(snapshot, 'button "Save"') });
  await call('wait_for', { pageId, text: ['Extension saved'], timeout: 5000 });
  const shot = await call('take_screenshot', { pageId });
  assert(shot.content.some(b => b.type === 'image'));
  console.log('Snapshot, fill, click and screenshot passed through the extension.');
  snapshot = await call('take_snapshot', { pageId });
  await call('fill', { pageId, uid: uid(snapshot, 'textbox "Frame name"'), value: 'Cross-site frame saved' });
  snapshot = await call('take_snapshot', { pageId });
  await call('click', { pageId, uid: uid(snapshot, 'button "Save frame"') });
  await call('wait_for', { pageId, text: ['Cross-site frame saved'], timeout: 5000 });
  snapshot = await call('take_snapshot', { pageId });
  await call('click', { pageId, uid: uid(snapshot, 'link "Reload frame"') });
  await call('wait_for', { pageId, text: ['Frame ready'], timeout: 5000 });
  snapshot = await call('take_snapshot', { pageId });
  await call('fill', { pageId, uid: uid(snapshot, 'textbox "Frame name"'), value: 'Frame resumed after navigation' });
  snapshot = await call('take_snapshot', { pageId });
  await call('click', { pageId, uid: uid(snapshot, 'button "Save frame"') });
  await call('wait_for', { pageId, text: ['Frame resumed after navigation'], timeout: 5000 });
  for (const host of ['127.0.0.1', 'localhost']) {
    snapshot = await call('take_snapshot', { pageId });
    await call('click', { pageId, uid: uid(snapshot, 'link "Switch frame site"') });
    await shared.waitForFrame(frame => frame.url() === `http://${host}:${server.address().port}/frame`, { timeout: 5000 });
    await call('wait_for', { pageId, text: ['Frame ready'], timeout: 5000 });
    const saved = `Frame saved on ${host}`;
    snapshot = await call('take_snapshot', { pageId });
    await call('fill', { pageId, uid: uid(snapshot, 'textbox "Frame name"'), value: saved });
    snapshot = await call('take_snapshot', { pageId });
    await call('click', { pageId, uid: uid(snapshot, 'button "Save frame"') });
    await call('wait_for', { pageId, text: [saved], timeout: 5000 });
    const inspection = await chrome.target().createCDPSession();
    try {
      const current = await inspection.send('Target.getTargets');
      assert.equal(current.targetInfos.some(target => target.type === 'iframe' && target.url.includes('/frame')), host === 'localhost', 'Site switch must replace the iframe process relationship');
    } finally { await inspection.detach(); }
  }
  console.log('Cross-site iframe snapshot, form input, navigation and process swaps passed through the extension.');
  await browser.access.update('developer-mode', 'on');
  await browser.access.update('developer-allow', url);
  for (const iteration of [1, 2]) {
    snapshot = await call('take_snapshot', { pageId });
    await call('click', { pageId, uid: uid(snapshot, 'button "Run worker"') });
    await call('wait_for', { pageId, text: [`Worker result SHARED JOB ${iteration}`], timeout: 5000 });
    if (iteration === 1) {
      snapshot = await call('take_snapshot', { pageId });
      await call('click', { pageId, uid: uid(snapshot, 'button "Restart worker"') });
      await call('wait_for', { pageId, text: ['Worker restarted'], timeout: 5000 });
    }
  }
  await hidden.evaluate(() => document.querySelector('#worker-run').click());
  await hidden.waitForFunction(() => document.querySelector('#worker-output').textContent.includes('PRIVATE JOB 1'), { timeout: 5000 });
  const messages = text(await call('list_console_messages', { pageId, types: ['log'] }));
  assert(messages.includes('Dedicated worker SHARED JOB 1') && messages.includes('Dedicated worker SHARED JOB 2'), messages);
  assert(messages.includes('Nested worker SHARED JOB 2'), messages);
  assert(!messages.includes('PRIVATE JOB'), messages);
  console.log('Dedicated and nested worker execution, restart and console isolation passed through the extension.');
  snapshot = await call('take_snapshot', { pageId });
  await call('click', { pageId, uid: uid(snapshot, 'button "Run background workers"') });
  await call('wait_for', { pageId, text: ['SharedWorker result SHARED BACKGROUND 1', 'ServiceWorker result SHARED BACKGROUND 1'], timeout: 10000 });
  await hidden.evaluate(() => document.querySelector('#background-run').click());
  await hidden.waitForFunction(() => document.querySelector('#shared-worker-output').textContent.includes('PRIVATE BACKGROUND 1') &&
    document.querySelector('#service-worker-output').textContent.includes('PRIVATE BACKGROUND 1'), { timeout: 10000 });
  const backgroundMessages = text(await call('list_console_messages', { pageId, types: ['log'] }));
  assert(!backgroundMessages.includes('private context') && !backgroundMessages.includes('PRIVATE BACKGROUND'), backgroundMessages);
  snapshot = await call('take_snapshot', { pageId });
  assert(!text(snapshot).includes('PRIVATE BACKGROUND'), 'Unshared worker replies must remain in their requesting page');
  console.log('SharedWorker and ServiceWorker page-facing replies work; background console data stays excluded.');
  const created = await call('new_page', { url: url + '/created', background: true });
  const createdId = created.structuredContent.pages.find(p => p.selected).id;
  await call('close_page', { pageId: createdId });
  const additional = await chrome.newPage(); await additional.goto(url + '/additional');
  await additional.bringToFront();
  await popup.evaluate(() => document.querySelector('#share').click());
  const added = await browser.waitForPage({ urlContains: '/additional', timeoutMs: 5000 });
  assert(!browser.owned.has(added.page.id), 'Manually shared tabs remain user-owned.');
  await browser.cleanup();
  assert(browser.pages.some(p => p.url.endsWith('/additional')));
  assert(!browser.pages.some(p => p.url.includes('/private')));
  await popup.waitForFunction(() => document.querySelector('#tabs').children.length === 2, { timeout: 5000, polling: 100 });
  await additional.close();
  await popup.waitForFunction(() => document.querySelector('#tabs').children.length === 1, { timeout: 5000, polling: 100 });
  // Both clicks occur in one task: stop must remain usable while share awaits
  // Chrome's active-tab query, and the late lookup must not restart sharing.
  await popup.evaluate(() => {
    document.querySelector('#share').click();
    if (document.querySelector('#stop').disabled) throw Error('Stop is disabled during a pending share');
    document.querySelector('#stop').click();
  });
  for (let i = 0; i < 50 && !relay.closed; i++) await delay(100);
  assert(relay.closed, 'Stop sharing must close the relay.');
  const result = await browser.call('take_snapshot', { pageId }).catch(error => ({ isError: true, error: error.message }));
  assert(result.isError, 'A revoked extension must not continue serving page data.');
  assert.equal(await hidden.url(), url + '/private');
  await popup.waitForFunction(() => document.querySelector('#stop').hidden, { timeout: 5000 });
  assert.equal(await popup.evaluate(() => globalThis.chrome.action.getBadgeText({})), '', 'A stopped extension must clear its sharing badge');
  // Exercise the production protocol in its extension context, holding only the
  // return of a real target lookup so cancellation has a deterministic boundary.
  const cancellation = await popup.evaluate(async sharedUrl => {
    const { SharedTabs } = await import(chrome.runtime.getURL('protocol.mjs'));
    const target = (await chrome.debugger.getTargets()).find(row => row.tabId && row.url === sharedUrl);
    if (!target) throw Error('Missing shared fixture tab');
    const entered = Promise.withResolvers(), release = Promise.withResolvers(), events = [];
    const tabs = new SharedTabs({ tabs: chrome.tabs, debugger: {
      getTargets: () => chrome.debugger.getTargets(),
      attach: (...args) => chrome.debugger.attach(...args),
      detach: (...args) => chrome.debugger.detach(...args),
      sendCommand: async (...args) => { const value = await chrome.debugger.sendCommand(...args); entered.resolve(); await release.promise; return value; },
    } }, event => events.push(event));
    await tabs.command({ method: 'Target.setDiscoverTargets', params: { discover: true } });
    await tabs.command({ method: 'Target.setAutoAttach', params: { autoAttach: true, flatten: true } });
    const sharing = tabs.share(target.tabId).then(() => ({ accepted: true }), error => ({ error: error.message }));
    try {
      await Promise.race([entered.promise, sharing.then(value => { throw Error('Sharing ended before lookup: ' + JSON.stringify(value)); })]);
      await tabs.stop();
      let nativeDetached = false;
      try { await chrome.debugger.sendCommand({ tabId: target.tabId }, 'Target.getTargetInfo'); }
      catch (error) { nativeDetached = /Debugger is not attached/i.test(error.message); }
      release.resolve();
      const outcome = await sharing;
      if (!nativeDetached || !outcome.error?.includes('Sharing has ended') || tabs.tabs.size || tabs.sessions.size || events.length) throw Error('Revoked lookup retained or published its attachment');
      return { nativeDetachedBeforeLookupReturned: true, latePublicationRejected: true };
    } finally { release.resolve(); await sharing; await tabs.stop(); }
  }, url + '/shared');
  assert.equal(cancellation.nativeDetachedBeforeLookupReturned, true);
  assert.equal(cancellation.latePublicationRejected, true);
  console.log('Real chrome.debugger attachment detached before delayed lookup returned; no late publication.');
  const currentInspector = await chrome.target().createCDPSession();
  let currentBackgroundTargets;
  try {
    currentBackgroundTargets = (await currentInspector.send('Target.getTargets')).targetInfos.filter(target =>
      ['shared_worker', 'service_worker'].includes(target.type) && target.url.startsWith(url));
    assert.deepEqual(currentBackgroundTargets.map(target => target.type).sort(), ['service_worker', 'shared_worker']);
  } finally { await currentInspector.detach(); }
  const backgroundScope = await popup.evaluate(async ({ sharedUrl, targets }) => {
    const { SharedTabs } = await import(chrome.runtime.getURL('protocol.mjs'));
    const shared = (await chrome.debugger.getTargets()).find(row => row.tabId && row.url === sharedUrl);
    if (!shared) throw Error('Missing shared page');
    const tabs = new SharedTabs({ tabs: chrome.tabs, debugger: chrome.debugger }, () => {});
    try {
      await tabs.share(shared.tabId);
      const exposed = await tabs.command({ method: 'Target.getTargets' });
      if (exposed.targetInfos.some(target => targets.some(background => background.targetId === target.targetId))) throw Error('Background target exposed');
      const pageId = exposed.targetInfos.find(target => target.type === 'page').targetId;
      const { sessionId } = await tabs.command({ method: 'Target.attachToTarget', params: { targetId: pageId, flatten: true } });
      for (const target of targets) {
        for (const method of ['Target.attachToTarget', 'Target.activateTarget', 'Target.closeTarget']) {
          let rejected = false;
          try { await tabs.command({ method, sessionId, params: { targetId: target.targetId, flatten: true } }); }
          catch (error) { rejected = /not shared/.test(error.message); }
          if (!rejected) throw Error('Background target command escaped shared-page scope: ' + method);
        }
      }
      await tabs.stop();
      let revoked = false;
      try { await tabs.command({ method: 'Runtime.evaluate', sessionId, params: { expression: '1' } }); }
      catch (error) { revoked = /Sharing has ended/.test(error.message); }
      if (!revoked || tabs.sessions.size) throw Error('Revocation retained a route');
      return { excludedTypes: targets.map(target => target.type).sort(), deniedCommands: targets.length * 3, revoked: true };
    } finally { await tabs.stop(); }
  }, { sharedUrl: url + '/shared', targets: currentBackgroundTargets });
  assert.equal(backgroundScope.deniedCommands, 6);
  assert.equal(backgroundScope.revoked, true);
  await shared.evaluate(() => document.querySelector('#background-run').click());
  await shared.waitForFunction(() => document.querySelector('#shared-worker-output').textContent.includes('SHARED BACKGROUND 2') &&
    document.querySelector('#service-worker-output').textContent.includes('SHARED BACKGROUND 2'), { timeout: 10000 });
  console.log('Background targets remain outside shared-tab attachment/activation/closure; revocation removes routes while page workers keep functioning.');
  relay = await createExtensionRelay();
  await popup.type('#pairing', relay.pairingUrl);
  await shared.bringToFront();
  await popup.evaluate(() => document.querySelector('#pair').click());
  for (let i = 0; i < 50 && !relay.ready; i++) await delay(100);
  assert(relay.ready, 'A fresh relay must pair before testing remote disconnection');
  await popup.waitForFunction(() => !document.querySelector('#share').hidden, { timeout: 5000 });
  relay.close();
  await popup.waitForFunction(() => !document.querySelector('#pair').hidden && document.querySelector('#share').hidden &&
    document.querySelector('#stop').hidden && document.querySelector('#tabs').children.length === 0 &&
    document.querySelector('#status').textContent.includes('DSCODE disconnected'), { timeout: 5000, polling: 100 });
  assert.equal(await popup.evaluate(() => globalThis.chrome.action.getBadgeText({})), '');
  console.log('Open popup tracks renamed/closed shared tabs and remote relay disconnection without reloading.');
  await mkdir(resolve('artifacts/local'), { recursive: true });
  await writeFile(resolve('artifacts/local/browser-extension-workers.json'), JSON.stringify({
    date: new Date().toISOString(), chrome: await chrome.version(), liveModelInference: false,
    extensionDirectory: extension, extensionFiles,
    pageFacingSharedAndServiceWorkerReplies: true, unsharedPageRepliesExcluded: true,
    backgroundConsoleExcluded: true, backgroundScope, workerRepliesAfterRevocation: true,
    attachmentCancellation: cancellation,
    activeSharingBadge: true, stoppedSharingBadgeCleared: true,
    popupStopDuringTabLookup: true,
    reopenedPendingPairing: true, handshakeStopAllowsImmediateRepairing: true,
    livePopupTabChanges: true, livePopupRemoteDisconnection: true,
    limitations: ['Direct SharedWorker and ServiceWorker debugging remains unsupported; only page-facing behavior and target exclusion are qualified.',
      'Disposable same-origin loopback pages in Chrome for Testing with the real unpacked MV3 extension.'],
  }, null, 2) + '\n');
  console.log('BROWSER_EXTENSION_PASSED: real MV3 popup pairing, selected-tab isolation, MCP DOM/form/screenshot, cross-site iframe form/navigation/process swaps, dedicated/nested worker execution/restart/console isolation, SharedWorker/ServiceWorker page replies and target exclusion, new/close tab, adding another user tab, ownership-preserving cleanup, user revocation and in-flight attachment cancellation; no live model.');
} finally {
  relay?.close();
  await browser?.close();
  await chrome?.close();
  for (const socket of stalledHandshakes) socket.destroy();
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
}
