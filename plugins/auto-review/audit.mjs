import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// DSH rc.1 has a closed persisted-event vocabulary. Keep extension telemetry
// in a sidecar instead of writing unknown events that make sessions unresumable.
export function auditStore(directory) {
  const pathFor = id => join(directory, `${createHash('sha256').update(id).digest('hex')}.jsonl`);
  return {
    read(id) {
      const path = pathFor(id);
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    append(id, record) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(pathFor(id), JSON.stringify({ time: Date.now(), ...record }) + '\n', { mode: 0o600, flush: true });
    },
  };
}
