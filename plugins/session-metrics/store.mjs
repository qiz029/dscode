import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// The render path reads this once a second per session; keep the last few ledgers and
// append to the parsed rows instead of re-reading and re-parsing the whole jsonl.
const MAX_SESSIONS = 16;
const cache = new Map();
const parse = (line, onCorrupt) => { try { return [JSON.parse(line)]; } catch { onCorrupt(); return []; } };
const readsAsJson = text => { try { JSON.parse(text); return true; } catch { return false; } };
export const ledgerPath = (home, id) => join(home, 'session-metrics', createHash('sha256').update(id).digest('hex') + '.jsonl');
export function appendMetric(home, id, entry) {
  const path = ledgerPath(home, id);
  mkdirSync(join(home, 'session-metrics'), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600, flush: true });
}
export function readMetrics(home, id) {
  const path = ledgerPath(home, id);
  try {
    const st = statSync(path), key = `${st.mtimeMs}:${st.size}`;
    const entry = cache.get(path);
    if (entry?.key === key) return entry.value;
    // Touching a key refreshes its recency; the oldest ledger is dropped past the cap.
    if (entry) cache.delete(path);
    let corrupt = false;
    const onCorrupt = () => { corrupt = true; };
    let value, offset = 0, pending = false;
    if (entry && st.ino === entry.ino && st.dev === entry.dev && st.size > entry.size) {
      // Append-only ledger: read just the bytes written since the last read (offset is a newline boundary).
      const fd = openSync(path, 'r');
      try {
        const buffer = Buffer.allocUnsafe(st.size - entry.offset);
        let filled = 0;
        while (filled < buffer.length) {
          const read = readSync(fd, buffer, filled, buffer.length - filled, entry.offset + filled);
          if (read <= 0) break;
          filled += read;
        }
        // A short read must never read as "the writer stopped here": fall back to the full
        // parse below rather than caching an offset that would drop the unread bytes forever.
        if (filled < buffer.length) throw Object.assign(new Error('short ledger read'), { code: 'ESHORTREAD' });
        const tail = buffer.toString('utf8');
        const lastNewline = tail.lastIndexOf('\n') + 1;
        let complete = tail.slice(0, lastNewline);
        const pendingLine = tail.slice(lastNewline);
        // A fragment without a newline is either a torn write or a complete row this reader is
        // simply early for; keep it only when it parses, and re-read it next time either way.
        pending = pendingLine !== '' && readsAsJson(pendingLine);
        if (pending) complete += pendingLine + '\n';
        offset = entry.offset + Buffer.byteLength(tail.slice(0, lastNewline));
        value = { rows: [...(entry.pending ? entry.value.rows.slice(0, -1) : entry.value.rows), ...complete.split('\n').filter(Boolean).flatMap(line => parse(line, onCorrupt))], corrupt: entry.value.corrupt || corrupt };
      } finally { closeSync(fd); }
    } else {
      const raw = readFileSync(path);
      const lastNewline = raw.lastIndexOf(0x0a) + 1;
      let complete = raw.subarray(0, lastNewline);
      const pendingLine = raw.subarray(lastNewline).toString('utf8');
      pending = pendingLine !== '' && readsAsJson(pendingLine);
      if (pending) complete = Buffer.concat([complete, Buffer.from(pendingLine + '\n')]);
      offset = lastNewline;
      value = { rows: complete.toString('utf8').split('\n').filter(Boolean).flatMap(line => parse(line, onCorrupt)), corrupt };
    }
    cache.set(path, { key, offset, value, pending, size: st.size, ino: st.ino, dev: st.dev });
    while (cache.size > MAX_SESSIONS) cache.delete(cache.keys().next().value);
    return value;
  } catch (e) {
    cache.delete(path);
    if (e.code === 'ESHORTREAD') {
      // Read it the simple way once; the next call starts from a fresh offset.
      let corrupt = false;
      const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => parse(line, () => { corrupt = true; }));
      return { rows, corrupt };
    }
    return { rows: [], corrupt: e.code !== 'ENOENT' };
  }
}
