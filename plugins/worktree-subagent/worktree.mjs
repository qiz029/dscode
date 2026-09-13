import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
async function git(cwd, args, signal, timeout = 60000) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout, signal });
    return stdout.trim();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error((error.stderr || error.stdout || error.message).trim(), { cause: error });
  }
}

export async function createChildWorktree(parentCwd, signal) {
  if (typeof parentCwd !== 'string' || !isAbsolute(parentCwd)) throw new Error('Subagent worktree requires an absolute parent workspace.');
  const root = realpathSync(await git(parentCwd, ['rev-parse', '--show-toplevel'], signal));
  if (root !== realpathSync(parentCwd)) throw new Error('Subagent worktree requires the parent session to start at its Git repository root.');
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
  if (status) throw new Error('Subagent worktree starts at HEAD, but the parent workspace has uncommitted changes. Use the shared workspace for work that needs those changes, or commit/stash them first.');
  const directory = join(root, '.dscode-worktrees');
  if (await git(root, ['ls-files', '--', '.dscode-worktrees'], signal)) throw new Error('The repository tracks .dscode-worktrees; choose a different workspace before delegating.');
  if (lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Refusing a symlinked .dscode-worktrees directory.');
  const excludePath = resolve(root, await git(root, ['rev-parse', '--git-path', 'info/exclude'], signal));
  const exclude = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
  if (!exclude.split(/\r?\n/).includes('/.dscode-worktrees/')) {
    mkdirSync(resolve(excludePath, '..'), { recursive: true });
    appendFileSync(excludePath, `${exclude && !exclude.endsWith('\n') ? '\n' : ''}/.dscode-worktrees/\n`);
  }
  mkdirSync(directory, { recursive: true });
  const path = join(directory, randomUUID());
  signal?.throwIfAborted();
  try { await git(root, ['worktree', 'add', '--detach', path, 'HEAD'], signal); }
  catch (error) {
    try { await git(root, ['worktree', 'remove', '--force', path], undefined, 1500); } catch { /* Git may already have cleaned up. */ }
    throw error;
  }
  return { cwd: path, parentCwd: root };
}

export async function discardCleanChildWorktree(worktree) {
  try {
    if (await git(worktree.cwd, ['status', '--porcelain=v1', '--untracked-files=all'])) return false;
    await git(worktree.parentCwd, ['worktree', 'remove', worktree.cwd]);
    return true;
  } catch { return false; }
}
