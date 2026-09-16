import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { reviewSpec } from './git.mjs';

// Outside a Git repository the review diffs two snapshots of the workspace, each written as a tree
// into a shadow bare repository under DSH_HOME: the baseline taken before the task's first tool call,
// and the workspace as it is when review runs. The workspace itself is never touched.

const exec = promisify(execFile);
const maxDiffBytes = 160 * 1024;
const IGNORED_DIRECTORIES = ['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox', '.cache'];
const SENSITIVE_PATTERNS = ['.env', '.env.*', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', '*.pem', '*.p12', '*.pfx', '*.key'];
const IDENTITY = { GIT_AUTHOR_NAME: 'dscode', GIT_AUTHOR_EMAIL: 'review@dscode.invalid', GIT_COMMITTER_NAME: 'dscode', GIT_COMMITTER_EMAIL: 'review@dscode.invalid' };
export const snapshotLimits = { files: 20000, bytes: 256 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 };

const defaultRoot = () => join(process.env.DSH_HOME ?? process.env.DSCODE_HOME ?? join(homedir(), '.local/share/dscode-hub'), 'review-baselines');
const anchored = path => `/${path.replace(/[\\*?[\]!#]/g, '\\$&').replace(/ $/, '\\ ')}`;
const refPart = value => String(value).replace(/[^A-Za-z0-9_-]/g, '_');
const refsFor = task => {
  const prefix = `refs/dscode/review/s-${refPart(task.session)}/`;
  return { prefix, ref: `${prefix}t-${refPart(task.seq)}` };
};

function environment(extra = {}) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...extra };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) if (!(name in extra)) delete env[name];
  return env;
}

async function git(dir, cwd, args, { index, signal, env = {} } = {}) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd, signal, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
      env: environment({ GIT_DIR: dir, GIT_WORK_TREE: cwd, ...(index ? { GIT_INDEX_FILE: index } : {}), ...env }),
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('Review diff exceeds 160 KiB. Use --path to review a smaller part.', { cause: error });
    throw error;
  }
}

/** Count what a snapshot would hash; files over the per-file limit are listed so they can be excluded. */
async function scan(cwd, skip, limits, signal) {
  let files = 0, bytes = 0;
  const large = [], stack = [''];
  while (stack.length) {
    signal?.throwIfAborted();
    const directory = stack.pop();
    let entries;
    try { entries = await readdir(join(cwd, directory), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.includes(entry.name) && path !== skip) stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (++files > limits.files) return { skipped: `more than ${limits.files} files` };
      const size = await lstat(join(cwd, path)).then(info => info.size, () => 0);
      if (size > limits.fileBytes) { if (!/[\r\n]/.test(path)) large.push(path); }
      else if ((bytes += size) > limits.bytes) return { skipped: `more than ${Math.round(limits.bytes / 1048576)} MiB of files` };
    }
  }
  return { large };
}

/** Write the workspace as a tree object through a throwaway index; returns { tree } or { skipped }. */
async function snapshot(dir, cwd, limits, signal) {
  const inside = relative(cwd, dir);
  const skip = inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside.split(sep).join('/') : undefined;
  const found = await scan(cwd, skip, limits, signal);
  if (found.skipped) return found;
  const id = randomUUID();
  const excludes = join(dir, `exclude-${id}`), index = join(dir, `index-${id}`);
  const patterns = [...IGNORED_DIRECTORIES.map(name => `${name}/`), ...SENSITIVE_PATTERNS, ...(skip ? [`${anchored(skip)}/`] : []), ...found.large.map(anchored)];
  await writeFile(excludes, `${patterns.join('\n')}\n`);
  try {
    try { await git(dir, cwd, ['-c', `core.excludesFile=${excludes}`, 'add', '-A', '--ignore-errors', '--', '.'], { index, signal }); }
    catch (error) { if (signal?.aborted) throw error; /* unreadable files are left out; the rest is indexed */ }
    return { tree: (await git(dir, cwd, ['write-tree'], { index, signal })).trim() };
  } finally {
    await Promise.all([rm(excludes, { force: true }), rm(index, { force: true })]);
  }
}

async function treeAt(dir, cwd, ref) {
  try { return (await git(dir, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`])).trim() || null; }
  catch { return null; }
}

/**
 * Task baselines for workspaces outside Git. A task is { session, seq }: the session id and the
 * sequence of the user message that started it. Baselines are refs, so they survive a resume.
 */
export function baselineStore(root = defaultRoot(), limits = snapshotLimits) {
  const captures = new Map();
  const locate = async cwd => {
    const real = await realpath(cwd);
    return { cwd: real, dir: join(root, createHash('sha256').update(real).digest('hex').slice(0, 16)) };
  };
  return {
    /** Take the task's baseline once; later calls for the same task reuse it. */
    capture(cwd, task) {
      const id = `${cwd}\0${task.session}\0${task.seq}`;
      if (!captures.has(id)) captures.set(id, (async () => {
        const { cwd: work, dir } = await locate(cwd);
        const { prefix, ref } = refsFor(task);
        await mkdir(dir, { recursive: true });
        if (!await lstat(join(dir, 'HEAD')).then(() => true, () => false)) await exec('git', ['init', '-q', '--bare', dir], { env: environment() });
        const existing = await treeAt(dir, work, ref);
        if (existing) return { tree: existing };
        const shot = await snapshot(dir, work, limits);
        if (shot.skipped) return shot;
        const commit = (await git(dir, work, ['commit-tree', shot.tree, '-m', 'dscode review baseline'], { env: IDENTITY })).trim();
        await git(dir, work, ['update-ref', ref, commit]);
        // Only the session's latest task keeps a baseline.
        const refs = (await git(dir, work, ['for-each-ref', '--format=%(refname)', prefix])).split('\n');
        for (const old of refs.filter(name => name && name !== ref)) await git(dir, work, ['update-ref', '-d', old]);
        return { tree: shot.tree };
      })().catch(error => { captures.delete(id); throw error; }));
      return captures.get(id);
    },
    /** Diff the task's baseline against the workspace now; `baseline` is 'missing' or 'too_large' when there is nothing to diff. */
    async collect(cwd, task, options = {}, signal) {
      const { scope, path } = reviewSpec(options.scope, options.ref, options.path);
      if (scope !== 'working') throw Error(`The ${scope} scope needs a Git repository; outside one, review takes only path.`);
      const label = 'files changed since this task started (workspace snapshot)';
      const { cwd: work, dir } = await locate(cwd);
      const base = task ? await treeAt(dir, work, refsFor(task).ref) : null;
      if (!base) return { scope, path, diff: '', omitted: [], label, baseline: 'missing' };
      const shot = await snapshot(dir, work, limits, signal);
      if (shot.skipped) return { scope, path, diff: '', omitted: [], label, baseline: 'too_large', reason: shot.skipped };
      const diff = await git(dir, work, ['diff-tree', '-p', '--no-ext-diff', '--no-textconv', base, shot.tree, '--', ...(path ? [path] : [])], { signal });
      if (Buffer.byteLength(diff) > maxDiffBytes) throw Error('Review diff exceeds 160 KiB. Use --path to review a smaller part.');
      return { scope, path, diff, omitted: /^Binary files .* differ$/m.test(diff) ? ['binary file diff'] : [], label };
    },
  };
}
