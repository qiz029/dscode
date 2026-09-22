// A permanent inode and a kernel lock serialize CLI processes. The Host inherits
// the descriptor so a killed parent cannot leave a still-running session unowned.
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { setTimeout as sleep } from 'node:timers/promises';

export async function acquireTriggerLease(home, id, { wait = false, delay = sleep } = {}) {
  const directory = join(home, 'triggers', 'locks');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fd = openSync(join(directory, `${id}.guard`), 'a', 0o600);
  try {
    for (;;) {
      try { await tryLockExclusive(fd); break; }
      catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error;
        if (!wait) { closeSync(fd); return undefined; }
        await delay(100);
      }
    }
    let released = false;
    return { fd, release() { if (!released) { released = true; closeSync(fd); } } };
  } catch (error) { closeSync(fd); throw error; }
}
