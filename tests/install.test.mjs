import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const installer = readFileSync(join(root, 'install.sh'), 'utf8');

/** A release tarball whose own installer only records that the archive was handed over. */
function releaseTarball(directory, version) {
  const stage = join(directory, 'stage');
  mkdirSync(stage, { recursive: true });
  writeFileSync(join(stage, 'install.sh'), '#!/bin/sh\nset -eu\nmkdir -p "$DSCODE_BIN_DIR"\nprintf "stub\\n" > "$DSCODE_BIN_DIR/dscode"\n');
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: 'stub-release', version }) + '\n');
  const archive = join(directory, 'dscode-' + version + '.tar.gz');
  const packed = spawnSync('tar', ['-czf', archive, '-C', stage, '.']);
  assert.equal(packed.status, 0, String(packed.stderr));
  return readFileSync(archive);
}

/**
 * A fake GitHub Releases API the installer can reach without the network. It is served
 * from this process, so a piped run must be spawned asynchronously: a synchronous spawn
 * would block the event loop that answers the installer's requests.
 */
async function serve(t, respond) {
  const requests = [];
  const server = createServer((request, response) => { requests.push(request.url); respond(request, response, base); });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, base };
}

function listing(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function install({ base, installDir, binDir, args = [], cwd, path, extraEnv = {} }) {
  return new Promise(done => {
    const child = spawn('sh', args, {
      cwd,
      env: { ...process.env, PATH: path ?? process.env.PATH, DSCODE_RELEASES_API: base + '/releases', DSCODE_INSTALL_DIR: installDir, DSCODE_BIN_DIR: binDir, ...extraEnv },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const expire = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', status => { clearTimeout(expire); done({ status, stdout, stderr }); });
    child.stdin.end(installer);
  });
}

function scratch(t, name) {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-install-' + name + '-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function release(body, base, name, digest) {
  return { tag_name: body, draft: false, prerelease: false, assets: [{ name, browser_download_url: base + '/asset/' + name, digest: 'sha256:' + digest }] };
}

test('the piped installer resolves the latest release, verifies its digest and hands over', async t => {
  const work = scratch(t, 'latest');
  const bytes = releaseTarball(work, '9.9.9');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const api = await serve(t, (request, response, base) => request.url === '/releases/latest'
    ? listing(response, release('v9.9.9', base, 'dscode-9.9.9.tar.gz', digest))
    : response.writeHead(200, { 'content-type': 'application/gzip' }).end(bytes));
  const installDir = join(work, 'install'), binDir = join(work, 'bin');
  const result = await install({ base: api.base, installDir, binDir, cwd: work });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Downloading DSCODE 9\.9\.9/);
  assert.match(result.stdout, /Installing DSCODE 9\.9\.9/);
  assert.equal(readFileSync(join(binDir, 'dscode'), 'utf8'), 'stub\n');
  assert.deepEqual(api.requests, ['/releases/latest', '/asset/dscode-9.9.9.tar.gz']);
});

test('a pinned version resolves its own tag and installs it', async t => {
  const work = scratch(t, 'pinned');
  const bytes = releaseTarball(work, '9.9.8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const api = await serve(t, (request, response, base) => request.url === '/releases/tags/v9.9.8'
    ? listing(response, release('v9.9.8', base, 'dscode-9.9.8.tar.gz', digest))
    : response.writeHead(200, { 'content-type': 'application/gzip' }).end(bytes));
  const installDir = join(work, 'install'), binDir = join(work, 'bin');
  const result = await install({ base: api.base, installDir, binDir, args: ['-s', '--', '9.9.8'], cwd: work });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Installing DSCODE 9\.9\.8/);
  assert.deepEqual(api.requests, ['/releases/tags/v9.9.8', '/asset/dscode-9.9.8.tar.gz']);
});

test('a release whose tag reports another version is refused', async t => {
  const work = scratch(t, 'mismatch');
  const bytes = releaseTarball(work, '9.9.8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const api = await serve(t, (request, response, base) => request.url === '/releases/tags/v9.9.8'
    ? listing(response, release('v9.9.9', base, 'dscode-9.9.9.tar.gz', digest))
    : response.writeHead(200, { 'content-type': 'application/gzip' }).end(bytes));
  const installDir = join(work, 'install'), binDir = join(work, 'bin');
  const result = await install({ base: api.base, installDir, binDir, args: ['-s', '--', '9.9.8'], cwd: work });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GitHub published 9\.9\.9 for the requested tag/);
  assert.equal(existsSync(binDir), false, 'a refused version must not install anything');
});

test('a digest mismatch and a missing digest both refuse before the handover', async t => {
  const work = scratch(t, 'digest');
  const bytes = releaseTarball(work, '9.9.9');
  let digest = createHash('sha256').update(bytes).digest('hex');
  const api = await serve(t, (request, response, base) => request.url === '/releases/latest'
    ? listing(response, digest === null
      ? { tag_name: 'v9.9.9', draft: false, prerelease: false, assets: [{ name: 'dscode-9.9.9.tar.gz', browser_download_url: base + '/asset/dscode-9.9.9.tar.gz' }] }
      : release('v9.9.9', base, 'dscode-9.9.9.tar.gz', digest))
    : response.writeHead(200, { 'content-type': 'application/gzip' }).end(bytes));
  const installDir = join(work, 'install'), binDir = join(work, 'bin');
  digest = 'f'.repeat(64);
  const mismatch = await install({ base: api.base, installDir, binDir, cwd: work });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /does not match the release digest; nothing was installed/);
  digest = null;
  const unverified = await install({ base: api.base, installDir, binDir, cwd: work });
  assert.equal(unverified.status, 1);
  assert.match(unverified.stderr, /publishes no sha256 digest/);
  assert.equal(existsSync(binDir), false);
});

test('the script still installs a local tree, and its guards run before anything is touched', async t => {
  const work = scratch(t, 'local');
  const tree = join(work, 'tree');
  for (const entry of ['bin', 'scripts', 'packages', 'plugins', 'tests', 'presets', 'config', 'docs']) mkdirSync(join(tree, entry), { recursive: true });
  writeFileSync(join(tree, 'package.json'), '{"name":"fake-harness","version":"1.2.3"}\n');
  writeFileSync(join(tree, 'package-lock.json'), '{}\n');
  writeFileSync(join(tree, '.npmrc'), '');
  writeFileSync(join(tree, '.env.example'), '');
  writeFileSync(join(tree, 'README.md'), '# fixture\n');
  writeFileSync(join(tree, 'scripts/harness.mjs'), 'export {};\n');
  writeFileSync(join(tree, 'bin/dscode.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(tree, 'install.sh'), installer);
  const stub = join(work, 'stubbin');
  mkdirSync(stub, { recursive: true });
  const log = join(work, 'npm.log');
  writeFileSync(join(stub, 'npm'), '#!/bin/sh\nprintf "%s (cwd=%s)\\n" "$*" "$PWD" >> "$STUB_LOG"\n');
  chmodSync(join(stub, 'npm'), 0o755);
  const installDir = join(work, 'install'), binDir = join(work, 'bin');
  const run = await install({ base: 'http://127.0.0.1:1', installDir, binDir, args: [join(tree, 'install.sh')], cwd: work, path: stub + ':' + process.env.PATH, extraEnv: { STUB_LOG: log } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(log, 'utf8'), `ci --ignore-scripts --no-audit (cwd=${installDir})\nrun setup (cwd=${installDir})\n`);
  assert.equal(readlinkSync(join(binDir, 'dscode')), join(installDir, 'bin/dscode.mjs'));
  const guarded = await install({ base: 'http://127.0.0.1:1', installDir, binDir, args: [join(tree, 'install.sh')], cwd: work, path: stub + ':' + process.env.PATH, extraEnv: { STUB_LOG: log } });
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /Install directory already exists/);
  const versioned = await install({ base: 'http://127.0.0.1:1', installDir: join(work, 'other'), binDir: join(work, 'other-bin'), args: [join(tree, 'install.sh'), '9.9.9'], cwd: work, path: stub + ':' + process.env.PATH, extraEnv: { STUB_LOG: log } });
  assert.equal(versioned.status, 1, 'a local tree must not silently install under a requested version');
  assert.match(versioned.stderr, /installs the tree it came from/);
});
