import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserConnection } from '../plugins/browser/connection.mjs';
import { BrowserAccess } from '../plugins/browser/access.mjs';
import { checkFileArguments } from '../plugins/browser/files.mjs';

// Real Chrome, loopback-only fixtures, no external account or model requests.
const home = await mkdtemp(join(tmpdir(), 'dscode-browser-e2e-'));
const outside = await mkdtemp(join(tmpdir(), 'dscode-browser-outside-'));
const config = { mode: 'persistent', headless: true, ...(process.env.DSCODE_TEST_CHROME ? { executablePath: process.env.DSCODE_TEST_CHROME } : {}) };
const html = `<!doctype html><html><head><title>Browser fixture</title></head><body>
<h1>Browser fixture</h1><form><label>Name <input name="name" aria-label="Name"></label><button>Save</button></form>
<button id="dialog">Confirm fixture</button><label>Attachment <input type="file" aria-label="Attachment"></label><output id="result">Ready</output>
<script>
console.log('browser-fixture-console');
document.querySelector('form').onsubmit = async e => { e.preventDefault(); const response = await fetch('/save',{method:'POST',body:document.querySelector('input').value}); document.querySelector('output').textContent = await response.text(); };
document.querySelector('#dialog').onclick = () => { document.querySelector('output').textContent = confirm('Fixture confirmation') ? 'Confirmed' : 'Cancelled'; };
</script></body></html>`;
let requests = 0;
const server = createServer((req, res) => {
  if (req.url === '/save') { requests++; res.setHeader('Set-Cookie', 'fixture_login=retained; Max-Age=3600; SameSite=Lax'); res.end('Saved fixture'); }
  else { res.setHeader('Content-Type', 'text/html'); res.end(html); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const access = new BrowserAccess(home);
await access.update('allow', url);
await access.update('developer-mode', 'on');
await access.update('developer-allow', url);
let browser;
let external;
const text = result => result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
async function call(name, args) {
  const result = await browser.call(name, args);
  assert(!result.isError, `${name}: ${text(result)}`);
  return result;
}
function uid(snapshot, label) {
  const line = text(snapshot).split('\n').find(line => line.includes(label));
  const id = line?.match(/uid=([^\s]+)/)?.[1];
  assert(id, `Cannot find ${label}: ${text(snapshot)}`);
  return id;
}
async function queuedFileBoundary(pageId) {
  const inside = join(home, 'safe-files'), link = join(home, 'chosen-files');
  await mkdir(inside); await symlink(inside, link);
  await writeFile(join(outside, 'fixture.txt'), 'Outside fixture must remain untouched');
  for (const [name, field] of [['take_snapshot', 'filePath'], ['upload_file', 'filePaths']]) {
    await writeFile(join(inside, 'fixture.txt'), 'Allowed upload fixture');
    const snapshot = await call('take_snapshot', { pageId });
    const args = { pageId, ...(name === 'upload_file' ? { uid: uid(snapshot, 'button "Attachment"') } : {}),
      [field]: field === 'filePaths' ? [join(link, 'fixture.txt')] : join(link, 'fixture.txt') };
    const release = Promise.withResolvers(), entered = Promise.withResolvers();
    const blocker = browser.enqueue(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    await checkFileArguments(args, [home]);
    const original = browser.client.callTool; let dispatched = 0;
    browser.client.callTool = async (request, ...rest) => {
      if (request.name === name && request.arguments[field]) dispatched++;
      return original.call(browser.client, request, ...rest);
    };
    const outcome = browser.call(name, args).then(value => ({ value }), error => ({ error }));
    try { await unlink(link); await symlink(outside, link); }
    finally { release.resolve(); }
    try {
      await blocker;
      assert.match((await outcome).error?.message ?? '', /outside the workspace/);
      assert.equal(dispatched, 0, 'Changed file paths must be rejected before attached Chrome receives them');
      assert.equal(await readFile(join(outside, 'fixture.txt'), 'utf8'), 'Outside fixture must remain untouched');
    } finally { browser.client.callTool = original; }
    await unlink(link); await symlink(inside, link);
    await call(name, args);
    if (name === 'upload_file') assert.match(text(await call('evaluate_script', { pageId,
      function: 'async () => await document.querySelector("input[type=file]").files[0].text()' })), /Allowed upload fixture/);
    else assert.match(await readFile(join(inside, 'fixture.txt'), 'utf8'), /Browser fixture/);
  }
}
try {
  browser = new BrowserConnection({ home, sessionId: 'verification', config });
  browser.args.push('--filesystem-root', home);
  await browser.start();
  assert(browser.tools.some(t => t.name === 'click_at'));
  const page = (await call('new_page', { url, background: true })).structuredContent.pages.find(p => p.selected);
  const pageId = page.id;
  const initialShot = (await call('take_screenshot', { pageId, format: 'png' })).content.find(block => block.type === 'image');
  assert(initialShot, 'The initial viewport screenshot must be inline');
  const initialPng = Buffer.from(initialShot.data, 'base64');
  assert.deepEqual([initialPng.readUInt32BE(16), initialPng.readUInt32BE(20)], [1280, 800], 'Headless Chrome starts with a useful, deterministic viewport');
  let snapshot = await call('take_snapshot', { pageId });
  await call('fill', { pageId, uid: uid(snapshot, 'textbox "Name"'), value: 'Local fixture' });
  snapshot = await call('take_snapshot', { pageId });
  await call('click', { pageId, uid: uid(snapshot, 'button "Save"') });
  await call('wait_for', { pageId, text: ['Saved fixture'], timeout: 5000 });
  assert.equal(requests, 1);
  assert.match(text(await call('list_console_messages', { pageId })), /browser-fixture-console/);
  assert.match(text(await call('list_network_requests', { pageId })), /\/save/);
  await call('resize_page', { pageId, width: 640, height: 800 });
  const shot = await call('take_screenshot', { pageId });
  const image = shot.content.find(b => b.type === 'image');
  assert.equal(image?.mimeType, 'image/png');
  assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
  const resizedPng = Buffer.from(image.data, 'base64');
  assert.deepEqual([resizedPng.readUInt32BE(16), resizedPng.readUInt32BE(20)], [640, 800], 'Explicit resizing overrides the initial headless viewport');
  snapshot = await call('take_snapshot', { pageId });
  const dialogClick = await browser.call('click', { pageId, uid: uid(snapshot, 'button "Confirm fixture"') });
  // Chrome can report a click timeout after opening a modal. Observe the
  // dialog and handle it; replaying the click would duplicate the action.
  assert.match(text(dialogClick), /Fixture confirmation/);
  await call('handle_dialog', { pageId, action: 'accept' });
  await call('wait_for', { pageId, text: ['Confirmed'], timeout: 5000 });
  const upload = join(home, 'upload.txt'); await writeFile(upload, 'fixture only');
  snapshot = await call('take_snapshot', { pageId });
  await call('upload_file', { pageId, uid: uid(snapshot, 'button "Attachment"'), filePaths: [upload] });
  assert.match(text(await call('evaluate_script', { pageId, function: '() => document.querySelector("input[type=file]").files[0].name' })), /upload.txt/);
  const handed = await browser.takeHandoff(pageId, 'Update the form manually.');
  assert.equal(handed.handoff.pageId, pageId);
  await assert.rejects(browser.call('fill', { pageId, uid: 'stale', value: 'must not run' }), /handed to the user/);
  assert.equal((await browser.cleanup()).skipped, 'user-handoff');
  // The separate direct MCP call simulates the user's edit while automation is
  // paused. Production agent tools cannot reach this transport directly.
  await browser.client.callTool({ name: 'evaluate_script', arguments: { pageId, function: '() => { document.querySelector("input[name=name]").value = "Human fixture"; }' } });
  assert.equal((await browser.resume()).resumedPageId, pageId);
  snapshot = await call('take_snapshot', { pageId });
  assert.match(text(snapshot), /Human fixture/);
  browser.keep(pageId);
  const beforeVerificationFailure = browser.client.callTool.bind(browser.client);
  let unverifiedPage, failVerification = false;
  browser.client.callTool = async (request, ...rest) => {
    const result = await beforeVerificationFailure(request, ...rest);
    if (request.name === 'new_page') {
      unverifiedPage = result.structuredContent.pages.find(page => page.selected);
      failVerification = true;
    } else if (request.name === 'list_pages' && failVerification) {
      failVerification = false;
      throw Error('Fixture lost the post-create page-list response');
    }
    return result;
  };
  try { await assert.rejects(browser.call('new_page', { url: url + '/unverified', background: true })); }
  finally { browser.client.callTool = beforeVerificationFailure; }
  assert(unverifiedPage, 'Chrome must confirm a real created page before verification fails');
  const lateKeep = (await call('new_page', { url: url + '/late-keep', background: true })).structuredContent.pages.find(p => p.selected);
  const temp = (await call('new_page', { url: url + '/temporary', background: true })).structuredContent.pages.find(p => p.selected);
  const user = await browser.client.callTool({ name: 'new_page', arguments: { url: url + '/user', background: true } });
  const userId = user.structuredContent.pages.find(p => p.selected).id;
  const nativeCall = browser.client.callTool.bind(browser.client);
  const cleanupEntered = Promise.withResolvers(), cleanupRelease = Promise.withResolvers();
  let cleanupLists = 0, cleaned;
  browser.client.callTool = async (request, ...rest) => {
    const result = await nativeCall(request, ...rest);
    if (request.name === 'list_pages' && ++cleanupLists === 2) {
      cleanupEntered.resolve(); await cleanupRelease.promise;
    }
    return result;
  };
  try {
    const cleaning = browser.cleanup();
    await cleanupEntered.promise;
    browser.keep(lateKeep.id, 'preview');
    cleanupRelease.resolve();
    cleaned = await cleaning;
  } finally { cleanupRelease.resolve(); browser.client.callTool = nativeCall; }
  assert(cleaned.closed.includes(temp.id));
  assert(!cleaned.closed.includes(unverifiedPage.id), 'Cleanup must preserve a created tab whose post-action verification failed');
  assert(cleaned.pages.some(page => page.id === unverifiedPage.id && page.kept));
  console.log('BROWSER_UNVERIFIED_TAB_PASSED: actual new-page result followed by a lost verification response; cleanup preserves the page without replay.');
  assert(!cleaned.closed.includes(lateKeep.id), 'Retention added while cleanup reads Chrome must win before close dispatch');
  assert(cleaned.pages.some(p => p.id === lateKeep.id && p.retention === 'preview'));
  assert(cleaned.pages.some(p => p.id === userId));
  assert(cleaned.pages.some(p => p.id === pageId));
  await browser.close();
  browser = new BrowserConnection({ home, sessionId: 'verification', config });
  await browser.start();
  assert.equal(browser.owned.size, 0, 'Ownership does not survive a connection generation');
  const resumed = (await call('new_page', { url, background: true })).structuredContent.pages.find(p => p.selected);
  const resumedImage = (await call('take_screenshot', { pageId: resumed.id, format: 'png' })).content.find(block => block.type === 'image');
  assert(resumedImage, 'The restarted browser screenshot must be inline');
  const resumedPng = Buffer.from(resumedImage.data, 'base64');
  assert.deepEqual([resumedPng.readUInt32BE(16), resumedPng.readUInt32BE(20)], [1280, 800], 'Restarting resets the initial viewport even when the profile retains a resized window');
  assert.match(text(await call('evaluate_script', { pageId: resumed.id, function: '() => document.cookie' })), /fixture_login=retained/);
  await browser.close();
  // A separate disposable Chrome stands in for a browser opened by the user.
  // No personal profile or existing browser process is touched.
  const externalProfile = join(home, 'external-profile'); await mkdir(externalProfile);
  const executable = config.executablePath ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome');
  external = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${externalProfile}`, url + '/existing'], { stdio: 'ignore' });
  let launchError;
  external.on('error', error => { launchError = error; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    port = await readFile(join(externalProfile, 'DevToolsActivePort'), 'utf8').then(s => Number(s.split('\n')[0]), () => undefined);
    if (port) break;
    await delay(100);
  }
  assert(port, 'Disposable debugging Chrome did not start');
  const endpoint = `http://127.0.0.1:${port}`;
  // DevToolsActivePort precedes the initial page target on some Chrome builds.
  // Wait for the fixture tab before MCP takes its initial page inventory.
  let existingPageReady = false;
  for (let i = 0; i < 100; i++) {
    const targets = await fetch(endpoint + '/json/list').then(r => r.json());
    if (targets.some(target => target.type === 'page' && target.url === url + '/existing')) {
      existingPageReady = true; break;
    }
    await delay(100);
  }
  assert(existingPageReady, 'Disposable Chrome did not expose the original fixture tab');
  browser = new BrowserConnection({ home, sessionId: 'attached', config: { mode: 'connect', url: endpoint }, fileRoots: [home] });
  browser.args.push('--filesystem-root', home);
  await browser.start();
  // The debugging endpoint can be ready before Chrome's startup tab navigates.
  // Wait for that original tab without opening or claiming a replacement.
  await browser.waitForPage({ urlContains: url + '/existing', timeoutMs: 10000 });
  assert(browser.pages.some(p => p.url === url + '/existing'));
  await queuedFileBoundary(browser.pages.find(p => p.url === url + '/existing').id);
  await call('new_page', { url: url + '/owned', background: true });
  await browser.cleanup();
  await browser.close();
  const remaining = await fetch(endpoint + '/json/list').then(r => r.json());
  assert(remaining.some(p => p.url === url + '/existing'), 'Disconnect must preserve user Chrome and its original tab');
  console.log('BROWSER_E2E_PASSED: real Chrome navigation, DOM, form submission, network/console, viewport, screenshot, dialog, upload, handoff/manual edit/resume, owned-tab cleanup, persistent cookies after restart, attached upload/export symlink queue checks with valid recovery, and attached-browser preservation.');
} finally {
  await browser?.close();
  if (external?.pid && external.exitCode === null && !external.killed) {
    const stopped = new Promise(resolve => external.once('exit', resolve));
    external.kill('SIGTERM');
    const timer = setTimeout(() => external.kill('SIGKILL'), 5000);
    await stopped; clearTimeout(timer);
  }
  await new Promise(resolve => server.close(resolve));
  await rm(home, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
