import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleDesktopDocs } from '../scripts/desktop-docs.mjs';

test('Desktop guides stay local while developer references point to the repository and stale build docs disappear', t => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-docs-')), destination = join(root, 'build');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs')); mkdirSync(join(destination, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/guide.md'), '# Current guide\n[other](other.md#usage) [record](verification.md#proof) [agents](../AGENTS.md)\n');
  writeFileSync(join(root, 'docs/other.md'), '# Other\n');
  writeFileSync(join(root, 'docs/verification.md'), 'Status: developer record with a local package hash.\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Rules\n');
  writeFileSync(join(destination, 'docs/stale.md'), 'Old build');
  bundleDesktopDocs(root, destination);
  assert.equal(readFileSync(join(destination, 'docs/guide.md'), 'utf8'), '# Current guide\n[other](other.md#usage) [record](https://github.com/qiz029/dscode/blob/main/docs/verification.md#proof) [agents](https://github.com/qiz029/dscode/blob/main/AGENTS.md)\n');
  assert(!existsSync(join(destination, 'docs/verification.md'))); assert(!existsSync(join(destination, 'docs/stale.md')));
  assert.throws(() => bundleDesktopDocs(root, root), /separate build/);
  writeFileSync(join(root, 'docs/broken.md'), '[missing](missing.md)');
  assert.throws(() => bundleDesktopDocs(root, destination), /Unresolved Desktop documentation link/);
});
