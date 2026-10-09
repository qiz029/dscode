// Native regression: an occupied default port and an interrupted startup must
// never produce a false browser-UI qualification. No rendered UI interaction.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const [app, runtime] = process.argv.slice(2);
assert(process.platform === 'darwin' && app && runtime, 'Usage on macOS: node scripts/verify-browser-electron-startup.mjs <Harness.app> <runtime-directory>');
const root = resolve(import.meta.dirname, '..'), output = join(root, 'artifacts/local');
mkdirSync(output, { recursive: true });
let defaultPortRequests = 0;
const occupied = createServer((_request, response) => { defaultPortRequests++; response.end('Owned startup regression sentinel'); });
occupied.listen(19387, '127.0.0.1');
await once(occupied, 'listening');
const results = [];
try {
  for (const interrupt of [false, true]) {
    const name = interrupt ? 'interrupted' : 'occupied-port';
    const child = spawn(process.execPath, [join(root, 'scripts/verify-browser-electron.mjs'), resolve(app), resolve(runtime)],
      { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '', pending = '', home, fixtureReady, settled = false;
    const ready = Promise.withResolvers();
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { settled = true; resolve({ code, signal }); });
    });
    child.stderr.on('data', data => { log += data; });
    child.stdout.on('data', data => {
      log += data; pending += data;
      for (let end; (end = pending.indexOf('\n')) >= 0;) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line.startsWith('ELECTRON_FIXTURE ')) {
          home = JSON.parse(line.slice('ELECTRON_FIXTURE '.length)).home;
          if (interrupt) child.kill('SIGTERM');
        }
        if (line.startsWith('BROWSER_UI_READY ')) {
          fixtureReady = JSON.parse(line.slice('BROWSER_UI_READY '.length)); ready.resolve(fixtureReady);
        }
      }
    });
    const timeout = setTimeout(() => { child.kill('SIGTERM'); }, 150000);
    try {
      if (interrupt) {
        const exit = await closed;
        assert(home, 'Interrupted fixture must have started its isolated setup.');
        assert(!fixtureReady, 'Interrupted startup must not reach readiness.');
        assert.notEqual(exit.code, 0, 'Stopping before readiness must fail qualification.');
        assert.match(log, /exited before the fixture became ready/);
        results.push({ name, ...exit, unreadyRejected: true });
      } else {
        const fixture = await Promise.race([ready.promise, closed.then(exit => { throw Error(`Fixture exited before readiness: ${JSON.stringify(exit)}`); })]);
        const base = new URL(fixture.url);
        assert.equal(base.hostname, '127.0.0.1');
        assert.notEqual(base.port, '19387');
        const login = await fetch(base, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
        assert(cookie);
        const rpc = async (action, args = {}) => {
          const response = await fetch(new URL('/api/dscode-browser', base), { method: 'POST', signal: AbortSignal.timeout(15000),
            headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: base.origin },
            body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-browser', payload: { sessionId: fixture.sessionId, action, ...args } }) });
          assert.equal(response.status, 200);
          const result = (await response.json()).result;
          assert(result.ok, result.error?.message); return result.value;
        };
        const tabs = await rpc('tabs'), page = tabs.pages.find(page => page.url.startsWith('http://127.0.0.1:'));
        assert(page);
        const frame = await rpc('capture', { pageId: page.id });
        assert.equal(frame.image.mimeType, 'image/png'); assert(frame.width > 0 && frame.height > 0);
        child.kill('SIGTERM');
        const exit = await closed;
        assert.equal(exit.code, 0);
        results.push({ name, ...exit, port: Number(base.port), authenticatedTabsAndCapture: true });
      }
    } finally {
      clearTimeout(timeout);
      if (!settled) {
        child.kill('SIGTERM');
        await Promise.race([closed, delay(10000)]);
        if (!settled) { child.kill('SIGKILL'); await closed; }
      }
      writeFileSync(join(output, `browser-electron-startup-${name}.log`), log.replace(/token=[^"&\s]+/g, 'token=[REDACTED]'));
    }
    assert(home && !existsSync(home), 'Owned fixture home must be removed after exit.');
    results.at(-1).temporaryHomeRemoved = true;
  }
  assert.equal(defaultPortRequests, 0, 'The fixture must never contact the occupied default port.');
  writeFileSync(join(output, 'browser-electron-startup.json'), JSON.stringify({ date: new Date().toISOString(), results,
    defaultPortRequests, renderedUi: false, liveModelInference: false }, null, 2) + '\n');
  console.log('ELECTRON_STARTUP_PASSED: occupied default port isolated; authenticated tabs/capture work; interrupted startup fails; owned homes cleaned.');
} finally {
  occupied.closeAllConnections(); await new Promise(resolve => occupied.close(resolve));
}
