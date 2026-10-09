/* global document */
// Real Chrome document changes against preview admission; no user browser or model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { puppeteer } from '../node_modules/chrome-devtools-mcp/build/src/third_party/index.js';
import { BrowserConnection } from '../plugins/browser/connection.mjs';
import { BrowserPreview } from '../plugins/browser/preview.mjs';

const executablePath = process.env.DSCODE_TEST_CHROME;
const home = await mkdtemp(join(tmpdir(), 'dscode-frame-preview-'));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const port = server.address().port;
  res.end(req.url === '/root' ? `<title>Document preview fixture</title><h1>Unchanged main document</h1>
    <iframe id="same" src="http://127.0.0.1:${port}/same"></iframe>
    <iframe id="cross" src="http://localhost:${port}/cross"></iframe>
    <iframe srcdoc="<p>Inline document</p>"></iframe><iframe></iframe>` :
    req.url === '/cross' ? `<title>Cross-site frame</title><iframe src="http://localhost:${port}/nested"></iframe>` :
      '<title>Child document</title><p>Frame ready</p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let chrome, browser;
try {
  chrome = await puppeteer.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true, args: ['--site-per-process'], protocolTimeout: 15000 });
  const page = await chrome.newPage(); await page.goto(origin + '/root');
  const inspector = await chrome.target().createCDPSession();
  try {
    const targets = (await inspector.send('Target.getTargets')).targetInfos;
    assert(targets.some(target => target.type === 'iframe' && target.url.endsWith('/cross')), 'Must exercise an actual cross-process frame');
  } finally { await inspector.detach(); }
  const endpoint = new URL(chrome.wsEndpoint());
  browser = new BrowserConnection({ home, sessionId: 'frame-preview', config: { mode: 'connect', url: `http://${endpoint.host}` } });
  await browser.access.update('allow', origin);
  await browser.start();
  const pageId = browser.pages.find(p => p.url === origin + '/root').id;
  const preview = new BrowserPreview(browser), messages = [], attachments = [];
  const agent = { session: { requestHeader: () => undefined }, options: { provider: 'fixture', model: 'scripted' }, followup: message => messages.push(message) };
  const ctx = { get: name => name === 'attachments' ? { saveImage: async image => { attachments.push(image); return { id: `fixture-${attachments.length}` }; } } :
    { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } };
  const input = frame => ({ token: frame.token, x: 0.5, y: 0.5, text: 'Inspect these captured pixels' });
  // Delay only the fixture clock after real Chrome has returned screenshot
  // bytes; do not spend a minute sleeping or replace the browser transport.
  let now = 1000;
  const timedPreview = new BrowserPreview(browser, () => now);
  const call = browser.call.bind(browser);
  try {
    for (const elapsed of [59999, 60000]) {
      const started = now;
      browser.call = async (...args) => {
        const result = await call(...args);
        if (args[0] === 'take_screenshot') now += elapsed;
        return result;
      };
      if (elapsed === 60000) await assert.rejects(timedPreview.capture(pageId), /expired/);
      else {
        const captured = await timedPreview.capture(pageId);
        assert.equal(captured.capturedAt, started);
        now++;
        const writes = attachments.length;
        await assert.rejects(timedPreview.annotate(input(captured), ctx, agent), /expired/);
        assert.equal(attachments.length, writes);
      }
    }
  } finally { browser.call = call; }
  const recovered = await timedPreview.capture(pageId);
  await timedPreview.annotate(input(recovered), ctx, agent);
  assert.equal(messages.length, 1);
  console.log('PREVIEW_CAPTURE_AGE_PASSED: real screenshots with simulated delivery age; sixty-second expiry cannot be renewed, fresh capture recovers.');
  const mainLoader = page.mainFrame()._loaderId;
  const cases = [];
  for (const suffix of ['/same', '/nested', '/cross']) cases.push([`reload ${suffix}`, async () => {
    const child = page.frames().find(frame => frame.url().endsWith(suffix));
    await child.goto(child.url());
  }]);
  cases.push(['cross-process to same-process navigation', async () => {
    // Set src from the unchanged parent. Navigating through the old child CDP
    // session can lose its response when Chrome replaces that process.
    await page.$eval('#cross', (element, url) => { element.src = url; }, origin + '/swapped');
    await page.waitForFrame(frame => frame.url() === origin + '/swapped');
  }]);
  cases.push(['remove iframe', async () => {
    await page.$eval('#same', element => element.remove());
    await page.waitForFunction(() => !document.querySelector('#same'));
  }]);
  cases.push(['add iframe', async () => {
    await page.evaluate(() => { const frame = document.createElement('iframe'); frame.id = 'added'; frame.src = '/added'; document.body.append(frame); });
    await page.waitForFrame(frame => frame.url().endsWith('/added'));
  }]);
  for (const [label, mutate] of cases) {
    const captured = await preview.capture(pageId), before = messages.length, writes = attachments.length;
    await mutate();
    assert.equal(page.mainFrame()._loaderId, mainLoader, 'Only child documents may change');
    assert.equal(browser.pages.find(p => p.id === pageId).documentId, captured.documentId, 'Cache must remain untouched until admission');
    await assert.rejects(preview.annotate(input(captured), ctx, agent), /page changed/, label);
    assert.equal(messages.length, before); assert.equal(attachments.length, writes);
    const fresh = await preview.capture(pageId);
    assert.notEqual(fresh.documentId, captured.documentId, label);
    await preview.annotate(input(fresh), ctx, agent);
    assert.equal(messages.length, before + 1);
    console.log(`PREVIEW_DOCUMENT_CASE_PASSED: ${label}; stale receipt refused, fresh capture sent`);
  }
  assert.equal((await browser.access.status()).developerMode, false);
  console.log('BROWSER_PREVIEW_DOCUMENTS_PASSED: same-process, cross-process and nested iframe reloads, process swap, removal and insertion; blank/srcdoc frames remain capturable; no Developer access, no live model.');
} finally {
  await browser?.close(); await chrome?.close();
  await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true });
}
