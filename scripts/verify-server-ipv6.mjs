// Exercise the actual foreground launcher: a working IPv6 Host must pass its
// authenticated readiness gate and survive the launcher's 90-second deadline.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { root, environment } from './harness.mjs';
import { hostSocket } from './host.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
import { callDscode } from '../plugins/local-carrier/client.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-server-ipv6-'));
const token = 'ipv6-fixture-private-token';
let child, done, timer, output = '', exited = false;
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const port = await new Promise((resolve, reject) => {
    const probe = createServer().on('error', reject).listen(0, '::', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const target = { url: `http://[::1]:${port}`, token };
  child = spawn(process.execPath, [join(root, 'bin/dscode.mjs'), 'server', '--port', String(port), '--bind', '::', '--cwd', workspace, '--token', token], {
    cwd: root,
    env: { ...environment(home), DSCODE_SOURCE_HOME: home, DSCODE_HOST_PATCH: '', DSCODE_MEMORY_HOME: join(home, 'memories'), DSCODE_LANGUAGE: 'en', DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { exited = true; resolve(code); });
  });
  timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
  const startupDeadline = Date.now() + 30_000;
  while (!output.includes('Connect a client with:') && !exited && Date.now() < startupDeadline) await tick(100);
  assert.match(output, /Connect a client with:/, 'the launcher must announce authenticated readiness');
  assert.equal(exited, false, output);
  const status = await callDscode(target, 'host/status', {}, AbortSignal.timeout(2000));
  const local = await callDscode(hostSocket(home), 'host/status', {}, AbortSignal.timeout(2000));
  assert.equal(status.pid, local.pid);
  assert.equal(status.launchId, local.launchId);
  assert.equal(status.defaultCwd, workspace);
  console.log('SERVER_IPV6_READY: authenticated TCP and Unix socket identify the same Host');

  // Measure from readiness, so even a slow startup stays alive past the full deadline.
  const aliveUntil = Date.now() + 95_000;
  while (Date.now() < aliveUntil) {
    await Promise.race([tick(1000), done]);
    assert.equal(exited, false, output);
    const current = await callDscode(target, 'host/status', {}, AbortSignal.timeout(2000));
    assert.equal(current.pid, status.pid);
    assert.equal(current.launchId, status.launchId);
  }
  assert(!output.includes('timed out before becoming ready'), output);
  console.log('SERVER_IPV6_VERIFIED: same Host remains reachable beyond the 90-second readiness deadline');
} finally {
  if (child && !exited) child.kill('SIGTERM');
  try { await done; } finally {
    clearTimeout(timer);
    rmSync(socketDirectory(home), { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}
