// Verify permission controls through the native Host's authenticated carrier.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const log = process.argv[2];
assert(log, 'Usage: node scripts/browser-permissions-rpc-probe.mjs <live-browser-fixture-log>');
const line = (await readFile(log, 'utf8')).split('\n').find(line => line.startsWith('BROWSER_UI_READY '));
assert(line, 'Fixture must be ready.');
const fixture = JSON.parse(line.slice('BROWSER_UI_READY '.length));
const base = new URL(fixture.url);
assert.equal(base.hostname, '127.0.0.1');
assert.equal(base.protocol, 'http:');
const login = await fetch(base, { redirect: 'manual' });
const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
assert(cookie);
async function request(action, args = {}, sessionId = fixture.sessionId) {
  const response = await fetch(new URL('/api/dscode-browser', base), { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base.origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-browser', payload: { action, sessionId, ...args } }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}
async function change(change, value) {
  const result = await request('permission', { change, value });
  assert(result.ok, result.error?.message);
  return result.value.permissions;
}
const tabs = await request('tabs');
assert(tabs.ok, tabs.error?.message);
assert(tabs.value.permissions);
const page = tabs.value.pages.find(page => page.url.startsWith('http://127.0.0.1:'));
assert(page, 'Choose a loopback-only fixture tab.');
const origin = new URL(page.url).origin;
for (const [headers, status] of [[{}, 401], [{ Cookie: cookie, Origin: 'https://untrusted.example' }, 403]]) {
  const rejected = await fetch(new URL('/api/dscode-browser', base), { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-browser',
      payload: { action: 'permission', sessionId: fixture.sessionId, change: 'block', value: origin } }),
  });
  assert.equal(rejected.status, status);
  assert.deepEqual((await request('tabs')).value.permissions, tabs.value.permissions, 'rejected transport requests must not mutate grants');
}
await change('developer-mode', 'off');
await change('forget', origin);
assert(!(await request('capture', { pageId: page.id })).ok);
assert((await change('once', origin)).sessionSites.includes(origin));
await change('developer-mode', 'on');
const granted = await change('developer-allow', origin);
assert(granted.sessionSites.includes(origin), 'Developer editing must retain temporary ordinary access');
assert.equal(granted.sites[origin].developer, true);
const captured = await request('capture', { pageId: page.id });
assert(captured.ok, captured.error?.message);
const blocked = await change('block', origin);
assert.equal(blocked.sites[origin].access, 'block');
assert.equal(blocked.sites[origin].developer, false);
assert(!blocked.sessionSites.includes(origin));
assert(!(await request('capture', { pageId: page.id })).ok);
assert(!(await request('permission', { change: 'once', value: origin })).ok);
await change('allow', origin);
const stale = await request('annotate', { annotation: { token: captured.value.token, x: 0.5, y: 0.5, text: 'Stale fixture annotation must not send' } });
assert(!stale.ok);
assert.match(stale.error.message, /expired|replaced/);
for (const value of [origin + '/path', 'https://user:password@example.com', '*']) {
  assert(!(await request('permission', { change: 'allow', value })).ok);
}
assert(!(await request('permission', { change: 'unknown', value: origin })).ok);
assert(!(await request('permission', { change: 'block', value: origin }, 'missing-fixture-session')).ok);
assert.equal((await request('tabs')).value.permissions.sites[origin].access, 'allow');
await change('developer-mode', 'off');
const output = resolve('artifacts/local/browser-permissions-rpc.json');
await mkdir(resolve('artifacts/local'), { recursive: true });
await writeFile(output, JSON.stringify({ nativeHostCarrier: true, anonymousRejected: true, untrustedOriginRejected: true, renderedUi: false, exactOrigin: true,
  temporaryGrantPreservedByDeveloperEdit: true, blockPreventsCapture: true, staleCaptureInvalidated: true,
  malformedPermissionChangesRejected: true, missingSessionRejected: true, liveModelInference: false }, null, 2) + '\n');
console.log('BROWSER_PERMISSIONS_RPC_PASSED: anonymous and cross-origin denial, exact-origin grants, temporary/Developer independence, blocked capture, stale annotation refusal and invalid request rejection.');
