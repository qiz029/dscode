import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, chmodSync, statSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { buildRelease } from '../scripts/release.mjs';
import { root, manifest, alignHubCredentials } from '../scripts/harness.mjs';

test('all Harness modules in the lock use exactly the runtime release', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  for (const [path, value] of Object.entries(lock.packages)) {
    if (path.split('node_modules/').at(-1).startsWith('@deepseek-ai/dsh')) assert.equal(value.version, manifest.dependencies['@deepseek-ai/dsh'], path);
  }
});

test('Hub archive is reproducible and the real importer rejects changed patches', async () => {
  const { archive, release } = await buildRelease();
  const first = readFileSync(archive);
  await buildRelease();
  assert.deepEqual(readFileSync(archive), first);
  const { readProfileArchive } = await import(pathToFileURL(join(root, 'node_modules/@dsh-plugin-hub/cli/dist/profile-archive.js')).href);
  assert.equal((await readProfileArchive(archive)).contentHash, release.contentHash);
  const entries = unzipSync(first);
  const changed = JSON.parse(strFromU8(entries['release.json']));
  changed.patchYaml += '\n# unexpected change\n';
  entries['release.json'] = strToU8(JSON.stringify(changed));
  const temp = mkdtempSync(join(tmpdir(), 'tui-archive-test-'));
  try {
    const path = join(temp, 'tampered.dshprofile');
    writeFileSync(path, zipSync(entries));
    await assert.rejects(readProfileArchive(path), /content hash mismatch/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('a Hub login in the user home is copied into the state directory once', () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-state-'));
  const user = mkdtempSync(join(tmpdir(), 'dscode-user-'));
  try {
    assert.equal(alignHubCredentials(home, user), false, 'nothing to align before a login exists');
    const source = join(user, '.dsh', '.hub', 'auth.json');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, '{"accessToken":"fixture"}');
    assert.equal(alignHubCredentials(home, user), true);
    assert.equal(readFileSync(join(home, '.hub', 'auth.json'), 'utf8'), '{"accessToken":"fixture"}');
    // The copy is authoritative afterwards: a refresh written there is never undone.
    writeFileSync(join(home, '.hub', 'auth.json'), '{"accessToken":"refreshed"}');
    assert.equal(alignHubCredentials(home, user), false);
    assert.equal(readFileSync(join(home, '.hub', 'auth.json'), 'utf8'), '{"accessToken":"refreshed"}');
    // When the state directory is the user home there is nothing to copy.
    assert.equal(alignHubCredentials(join(user, '.dsh'), user), false);
    // An existing loose directory is normalized around the copied token.
    const loose = mkdtempSync(join(tmpdir(), 'dscode-loose-'));
    try {
      mkdirSync(join(loose, '.hub'), { recursive: true });
      chmodSync(join(loose, '.hub'), 0o755);
      assert.equal(alignHubCredentials(loose, user), true);
      assert.equal(statSync(join(loose, '.hub')).mode & 0o777, 0o700);
      assert.equal(statSync(join(loose, '.hub', 'auth.json')).mode & 0o777, 0o600);
    } finally { rmSync(loose, { recursive: true, force: true }); }
    // An unreadable or malformed source is a no-op, never a launch failure.
    const broken = mkdtempSync(join(tmpdir(), 'dscode-broken-'));
    const fresh = mkdtempSync(join(tmpdir(), 'dscode-fresh-'));
    try {
      mkdirSync(join(broken, '.dsh', '.hub', 'auth.json'), { recursive: true });
      assert.equal(alignHubCredentials(fresh, broken), false);
    } finally {
      rmSync(broken, { recursive: true, force: true });
      rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
  }
});
