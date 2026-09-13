import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const command = fileURLToPath(new URL('../bin/apply_patch', import.meta.url));
const patch = 'diff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-before\n+after\n';

for (const repository of [false, true]) test(`patch paths follow cwd ${repository ? 'inside a repository subdirectory' : 'outside a repository'}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-patch-'));
  try {
    if (repository) assert.equal(spawnSync('git', ['init', '--quiet', root]).status, 0);
    const cwd = join(root, 'nested');
    mkdirSync(cwd);
    const file = join(cwd, 'sample.txt');
    writeFileSync(file, 'before\n');
    const check = spawnSync(command, ['--check'], { cwd, input: patch, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(readFileSync(file, 'utf8'), 'before\n');
    const applied = spawnSync(command, [], { cwd, input: patch, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(file, 'utf8'), 'after\n');
    assert(!existsSync(join(root, 'sample.txt')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
