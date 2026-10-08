import { realpath, lstat, readlink } from 'node:fs/promises';
import path, { dirname, isAbsolute, relative, resolve } from 'node:path';

async function canonical(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const entry = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (entry?.isSymbolicLink()) return canonical(resolve(dirname(path), await readlink(path)));
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonical(parent), relative(parent, path));
  }
}

/** Both inputs must already be canonical absolute paths. */
export function withinFileRoot(root, target, paths = path) {
  const rel = paths.relative(root, target);
  return rel === '' || (!paths.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + paths.sep));
}

/** Enforce file roots even for attached Chrome, where upstream skips some checks. */
export async function checkFileArguments(args, roots) {
  const paths = Object.entries(args).filter(([key]) => /filepaths?$/i.test(key)).flatMap(([, value]) => Array.isArray(value) ? value : [value]);
  if (!paths.length) return;
  const allowed = await Promise.all(roots.map(root => canonical(resolve(root))));
  for (const path of paths) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw Error('Browser file paths must be absolute and inside the workspace or browser artifact directory.');
    const target = await canonical(path);
    if (!allowed.some(root => withinFileRoot(root, target))) throw Error('Browser file path is outside the workspace and browser artifact directory.');
  }
}
