import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const cache = new Map();
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
    if (cache.get(path)?.key === key) return cache.get(path).value;
    let corrupt = false;
    const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { corrupt = true; return []; }
    });
    const value = { rows, corrupt };
    cache.set(path, { key, value });
    return value;
  } catch (e) { return { rows: [], corrupt: e.code !== 'ENOENT' }; }
}
