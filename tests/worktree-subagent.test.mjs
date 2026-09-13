import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChildWorktree, discardCleanChildWorktree } from '../plugins/worktree-subagent/worktree.mjs';

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('isolated child worktree starts at clean HEAD and remains for parent integration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-child-worktree-'));
  try {
    git(root, 'init', '-q');
    writeFileSync(join(root, 'file.txt'), 'parent\n');
    git(root, 'add', 'file.txt');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(createChildWorktree(root, cancelled.signal), /abort/i);
    const child = await createChildWorktree(root);
    assert.equal(readFileSync(join(child.cwd, 'file.txt'), 'utf8'), 'parent\n');
    assert.equal(git(root, 'status', '--porcelain=v1'), '');
    writeFileSync(join(child.cwd, 'file.txt'), 'child\n');
    assert.equal(readFileSync(join(root, 'file.txt'), 'utf8'), 'parent\n');
    assert.equal(await discardCleanChildWorktree(child), false);
    assert(existsSync(child.cwd));
    assert.match(git(child.cwd, 'diff', '--', 'file.txt'), /\+child/);
    writeFileSync(join(child.cwd, 'file.txt'), 'parent\n');
    assert.equal(await discardCleanChildWorktree(child), true);
    assert(!existsSync(child.cwd));
    writeFileSync(join(root, 'file.txt'), 'uncommitted\n');
    await assert.rejects(createChildWorktree(root), /uncommitted changes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
