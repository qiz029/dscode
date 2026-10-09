import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, join } from 'node:path';

/** Exercise the production Connection carrier on an already-running fixture.
 * This verifies Host integration, not Electron's rendered controls. */
export async function verifyPreviewRpc({ url, sessionId, home, stopSharing }) {
  const base = new URL(url);
  assert.equal(base.hostname, '127.0.0.1');
  assert.equal(base.protocol, 'http:');
  const login = await fetch(base, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie, 'Fixture launch token must establish an authenticated cookie.');
  async function request(action, args = {}) {
    const response = await fetch(new URL('/api/dscode-browser', base), { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base.origin },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-browser', payload: { action, sessionId, ...args } }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result;
  }
  const tabs = await request('tabs');
  assert(tabs.ok); assert.equal(tabs.value.mode, 'extension');
  assert.equal(tabs.value.pages.length, 1, 'Unshared fixture page must not reach the native preview.');
  const pageId = tabs.value.pages[0].id;
  const captured = await request('capture', { pageId });
  assert(captured.ok, captured.error?.message);
  assert.equal(captured.value.image.mimeType, 'image/png');
  const frame = captured.value;
  const annotation = { token: frame.token, x: 0.5, y: 0.5, text: 'Change the orange button label to Schedule a visit.' };
  const sent = await request('annotate', { annotation });
  assert(sent.ok, sent.error?.message);
  assert.equal(sent.value.imageInput, true);
  const duplicate = await request('annotate', { annotation });
  assert(!duplicate.ok, 'A capture token must not admit two messages.');
  let receipt;
  for (let i = 0; i < 100; i++) {
    receipt = await readFile(join(home, 'annotation-receipt.json'), 'utf8').then(JSON.parse, () => undefined);
    if (receipt) break;
    await delay(100);
  }
  assert.equal(receipt?.count, 1); assert.equal(receipt.hasImage, true);
  const pendingFrame = await request('capture', { pageId });
  assert(pendingFrame.ok);
  await stopSharing();
  let denied;
  for (let i = 0; i < 50; i++) {
    denied = await request('tabs');
    if (!denied.ok) break;
    await delay(100);
  }
  assert(!denied.ok, 'Revocation must reach the native Host.');
  const afterRevoke = await request('capture', { pageId });
  assert(!afterRevoke.ok);
  const stale = await request('annotate', { annotation: { ...annotation, token: pendingFrame.value.token } });
  assert(!stale.ok);
  const finalReceipt = JSON.parse(await readFile(join(home, 'annotation-receipt.json'), 'utf8'));
  assert.equal(finalReceipt.count, 1, 'Revoked captures must not enqueue another annotation.');
  return { frame, receipt, revocation: { tabs: denied.error.message, capture: afterRevoke.error.message, annotation: stale.error.message } };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [log, pidText] = process.argv.slice(2);
  assert(log && /^\d+$/.test(pidText ?? ''), 'Usage: node scripts/browser-preview-rpc-probe.mjs <live-electron-fixture-log> <fixture-launcher-pid>');
  const line = (await readFile(log, 'utf8')).split('\n').find(line => line.startsWith('BROWSER_UI_READY '));
  assert(line, 'Fixture must be ready.');
  const fixture = JSON.parse(line.slice('BROWSER_UI_READY '.length));
  assert.equal(fixture.mode, 'extension');
  const result = await verifyPreviewRpc({ ...fixture, stopSharing: async () => { process.kill(Number(pidText), 'SIGUSR2'); } });
  const output = resolve('artifacts/local'); await mkdir(output, { recursive: true });
  await writeFile(join(output, 'browser-electron-extension-capture.png'), Buffer.from(result.frame.image.data, 'base64'));
  await writeFile(join(output, 'browser-electron-extension-rpc.json'), JSON.stringify({ surface: 'official Electron Host Connection HTTP carrier', renderedUi: false,
    mode: 'extension', liveModelInference: false, annotation: result.receipt, revocation: result.revocation }, null, 2) + '\n');
  console.log('ELECTRON_EXTENSION_RPC_PASSED: scoped tabs, captured image, single annotation delivery, duplicate refusal, and revocation blocking tabs/capture/annotation. Rendered UI is a separate check.');
}
