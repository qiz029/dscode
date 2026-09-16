import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';

export function emailStore(directory, label = 'email') {
  const read = name => {
    try { return JSON.parse(readFileSync(join(directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw Error('Cannot read local ' + label + ' configuration.', { cause: error }); }
  };
  return {
    directory, read,
    exists: name => existsSync(join(directory, name)),
    write(name, value) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temp = join(directory, '.' + randomUUID());
      try {
        writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        renameSync(temp, join(directory, name));
      } finally { try { unlinkSync(temp); } catch { /* best-effort cleanup: never mask the write's own outcome */ } }
    },
    async locked(action) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const fd = openSync(join(directory, '.sync.lock'), 'a', 0o600);
      try {
        try { await tryLockExclusive(fd); }
        catch (error) { if (['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) return { busy: true }; throw error; }
        return await action();
      } finally { closeSync(fd); }
    },
  };
}
