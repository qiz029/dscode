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
      // A torn or corrupt line is skipped, never allowed to break every later read.
      // Audit rows are a telemetry sidecar: silent skips are accepted and the usable trail stays readable.
      return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    },
    append(id, record) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(pathFor(id), JSON.stringify({ time: Date.now(), ...record }) + '\n', { mode: 0o600, flush: true });
    },
  };
}
