import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { buildRelease } from '../scripts/release.mjs';
import { root, manifest } from '../scripts/harness.mjs';

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
