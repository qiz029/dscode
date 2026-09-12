import { createHash } from 'node:crypto';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';

export function socketDirectory(home, create = false) {
  let canonical = resolve(home);
  try { canonical = realpathSync(canonical); } catch {}
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 20);
  // macOS Unix socket paths have a small byte limit. Do not put them beneath
  // potentially long workspace/profile paths. The directory is private per UID.
  const path = join('/tmp', `dscode-${process.getuid()}-${hash}`);
  if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Unsafe DSCODE socket directory');
  return path;
}

export function ensureSocketDirectory(home) {
  try { return socketDirectory(home); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return socketDirectory(home, true); }
}
