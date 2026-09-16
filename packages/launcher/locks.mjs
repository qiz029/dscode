import { openSync, closeSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';

const contended = error => ['EAGAIN', 'EWOULDBLOCK'].includes(error.code);
const remove = path => { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } };

// The gate inode is permanent. Kernel ownership also survives a parent crash
// when the runtime inherits its own lease descriptor through spawn's fd 3.
export async function acquireLock(home, { waitMs = 2000 } = {}) {
  mkdirSync(home, { recursive: true });
  const fd = openSync(join(home, '.launcher.guard'), 'a', 0o600);
  try {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try { await tryLockExclusive(fd); break; }
      catch (error) {
        if (!contended(error) || Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    // An older launcher holds a PID file for its entire lifetime. Never upgrade
    // its profile while it is still running; leave stale legacy files untouched.
    let pid;
    try { pid = Number(readFileSync(join(home, '.launcher.lock'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pid !== undefined) {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid legacy DSCODE lock; inspect ' + home);
      try { process.kill(pid, 0); throw Error(`An older DSCODE launcher is running (pid ${pid}). Exit it first.`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    let released = false;
    return Object.assign(() => { if (!released) { released = true; closeSync(fd); } }, { fd });
  } catch (error) {
    closeSync(fd);
    if (contended(error)) throw Error('DSCODE is starting or changing versions. Retry when that operation finishes.', { cause: error });
    throw error;
  }
}

// Call while holding the gate, before creating a runtime or changing versions.
export async function activeRuns(home) {
  const directory = join(home, '.launcher-runs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const active = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.lock')) continue;
    const path = join(directory, name);
    let fd;
    try {
      fd = openSync(path, 'r+');
      await tryLockExclusive(fd);
      remove(path);
    } catch (error) {
      if (contended(error)) active.push(name);
      else if (error.code !== 'ENOENT') throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  return active;
}

export async function registerRun(home) {
  const directory = join(home, '.launcher-runs');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${process.pid}-${randomUUID()}.lock`);
  const fd = openSync(path, 'wx+', 0o600);
  try { await tryLockExclusive(fd); }
  catch (error) { closeSync(fd); remove(path); throw error; }
  let released = false;
  return { fd, release() {
    if (released) return;
    released = true;
    closeSync(fd);
    remove(path);
  } };
}
