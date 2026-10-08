import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { desktopShellEnvironment } from '../plugins/desktop/shell-environment.mjs';

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

test('Desktop shell helpers win over foreign commands without changing the parent environment', () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-patch-env-'));
  try {
    const foreign = join(root, 'foreign commands');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'apply_patch'), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    const parent = { ...process.env, PATH: foreign + delimiter + process.env.PATH };
    const originalPath = parent.PATH;
    writeFileSync(join(root, 'sample.txt'), 'before\n');
    const shadowed = spawnSync('/bin/sh', ['-c', 'apply_patch'], { cwd: root, env: parent, input: patch, encoding: 'utf8' });
    assert.equal(shadowed.status, 91);
    const applied = spawnSync('/bin/sh', ['-c', 'apply_patch'], { cwd: root, env: { ...parent, ...desktopShellEnvironment(parent) }, input: patch, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(root, 'sample.txt'), 'utf8'), 'after\n');
    assert.equal(parent.PATH, originalPath);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
