import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const exec = promisify(execFile);
const maxBytes = 2 * 1024 * 1024;

export function reviewSpec(scope = 'working', ref = '', path = '') {
  if (!['working', 'staged', 'base', 'commit'].includes(scope)) throw Error('Scope must be working, staged, base, or commit.');
  if (['base', 'commit'].includes(scope) !== Boolean(ref)) throw Error(`${scope} review ${['base', 'commit'].includes(scope) ? 'requires' : 'does not accept'} a ref.`);
  if (ref && (!/^[A-Za-z0-9][A-Za-z0-9._/~^]*$/.test(ref) || ref.includes('..') || ref.includes('@{'))) throw Error('Unsafe Git ref.');
  if (path && (path.startsWith('/') || path.startsWith(':') || path.includes('\\') || path.split('/').includes('..') || /[\r\n\0]/.test(path))) throw Error('Path must stay inside the workspace.');
  return { scope, ref, path: path ? posix.normalize(path).replace(/^\.$/, '') : '' };
}

export function parseReviewCommand(raw = '') {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return reviewSpec();
  let scope = 'working', ref = '', path = '';
  if (words[0] === '--staged') { scope = 'staged'; words.shift(); }
  else if (words[0] === '--base' || words[0] === '--commit') {
    scope = words.shift().slice(2);
    ref = words.shift() ?? '';
  }
  if (words[0] === '--path') { words.shift(); path = words.shift() ?? ''; if (!path) throw Error('Usage: /review [--staged|--base REF|--commit REF] [--path RELATIVE_PATH]'); }
  if (words.length) throw Error('Usage: /review [--staged|--base REF|--commit REF] [--path RELATIVE_PATH]');
  return reviewSpec(scope, ref, path);
}

async function git(cwd, args, signal, encoding = 'utf8') {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, signal, encoding, maxBuffer: maxBytes, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout;
}

const matchesPath = (file, path) => !path || file === path || file.startsWith(`${path.replace(/\/$/, '')}/`);
const safeLabel = value => JSON.stringify(value);
const sensitiveFile = file => /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519))$|\.(?:pem|p12|pfx|key)$/i.test(posix.basename(file));

async function untracked(cwd, path, signal) {
  const args = ['ls-files', '--others', '--exclude-standard', '-z', '--', ...(path ? [path] : [])];
  const names = (await git(cwd, args, signal)).split('\0').filter(Boolean).filter(file => matchesPath(file, path));
  const chunks = [], omitted = [];
  for (const file of names) {
    signal?.throwIfAborted();
    if (sensitiveFile(file) || /[\r\n]/.test(file)) {
      omitted.push(file);
      chunks.push(`Untracked file omitted from review: ${safeLabel(file)} (sensitive or unsupported path)\n`);
      continue;
    }
    const full = join(cwd, file);
    const info = await lstat(full);
    if (!info.isFile() || info.size > 128 * 1024) {
      omitted.push(file);
      chunks.push(`Untracked file omitted from review: ${safeLabel(file)} (not a small regular file)\n`);
      continue;
    }
    const data = await readFile(full);
    if (data.includes(0)) {
      omitted.push(file);
      chunks.push(`Untracked binary file omitted from review: ${safeLabel(file)}\n`);
      continue;
    }
    const lines = data.toString('utf8').replace(/\n$/, '').split('\n');
    chunks.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n`);
  }
  return { text: chunks.join(''), omitted };
}

/** The Git work tree containing cwd, or null when cwd is not inside a repository (or git is unavailable). */
export async function gitWorkspace(cwd, signal) {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'], signal)).trim() || null; }
  catch (error) {
    if (signal?.aborted) throw error;
    if (error.code === 'ENOENT' || /not a git repository|cannot change to|No such file/i.test(`${error.stderr ?? ''}${error.message ?? ''}`)) return null;
    throw error;
  }
}

const gitWorkspaceCache = new Map();
/** Synchronous, briefly cached variant for prompt assembly; unknown cwd counts as a repository. */
export function isGitWorkspaceSync(cwd, run = execFileSync, now = Date.now()) {
  if (!cwd) return true;
  const cached = gitWorkspaceCache.get(cwd);
  if (cached && now - cached.at < 60_000) return cached.value;
  // Any failure (no repository, missing directory, git unavailable) means the review tool cannot work here.
  let value = false;
  try { run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }); value = true; }
  catch { value = false; }
  gitWorkspaceCache.set(cwd, { at: now, value });
  return value;
}

/** HEAD as it was at `time` (ms), read from the reflog (newest first); undefined when the reflog does not reach back that far. */
async function headAt(cwd, time, signal) {
  let log;
  try { log = await git(cwd, ['reflog', 'show', '--date=unix', '--format=%H %gd', 'HEAD'], signal); }
  catch (error) { if (signal?.aborted) throw error; return undefined; }
  for (const line of log.split('\n')) {
    const match = line.match(/^([0-9a-f]{40,64}) HEAD@\{(\d+)\}$/);
    if (match && Number(match[2]) * 1000 <= time) return match[1];
  }
  return undefined;
}

export async function collectReviewDiff(cwd, options = {}, signal) {
  const { scope, ref, path } = reviewSpec(options.scope, options.ref, options.path);
  let label = scope === 'working' ? 'uncommitted changes (tracked and untracked)' : scope === 'staged' ? 'staged changes' : `${scope} ${ref}`;
  const repository = await gitWorkspace(cwd, signal);
  if (repository === null) return { scope, ref, path, diff: '', omitted: [], label, repository: null };
  const pathArgs = ['--', ...(path ? [path] : [])];
  let diff, omitted = [];
  if (scope === 'working') {
    try { diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', ...pathArgs], signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      let hasHead = false;
      try { await git(cwd, ['rev-parse', '--verify', 'HEAD'], signal); hasHead = true; } catch { /* unborn branch */ }
      if (hasHead) throw error;
      await git(cwd, ['rev-parse', '--is-inside-work-tree'], signal);
      diff = (await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--cached', ...pathArgs], signal)) +
        (await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', ...pathArgs], signal));
    }
    const extra = await untracked(cwd, path, signal);
    diff += extra.text; omitted = extra.omitted;
    // A task that committed or merged its work leaves nothing uncommitted: review the commits made since it started.
    if (!diff.trim() && Number.isFinite(options.since)) {
      const start = await headAt(cwd, options.since, signal);
      const head = start && (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim();
      if (start && head !== start) {
        diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', start, 'HEAD', ...pathArgs], signal);
        label = `commits made since this task started (${start.slice(0, 12)}..HEAD)`;
      }
    }
  } else if (scope === 'staged') diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--cached', ...pathArgs], signal);
  else if (scope === 'base') diff = await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', `${ref}...HEAD`, ...pathArgs], signal);
  // Plain `git show` prints a merge as a combined diff, which is empty for a clean merge; review it against its first parent.
  else diff = await git(cwd, ['show', '--format=', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv', ref, ...pathArgs], signal);
  if (Buffer.byteLength(diff) > 160 * 1024) throw Error('Review diff exceeds 160 KiB. Use --path to review a smaller part.');
  if (/^Binary files .* differ$/m.test(diff)) omitted.push('tracked binary diff');
  return { scope, ref, path, diff, omitted, label, repository };
}
