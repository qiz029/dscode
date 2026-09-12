import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OfflineAdapter } from './adapters.mjs';
import { createRuntime } from './runtime.mjs';

// Exercises native trigger/retention logic without sending a provider request.
const dataset = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/coding-million-v1.json'), 'utf8'));
const policies = JSON.parse(readFileSync(join(import.meta.dirname, 'policies.json'), 'utf8'));
for (const item of dataset.cases) {
  const output = [];
  for (const policy of policies) {
    const runtime = createRuntime({ policy, adapter: new OfflineAdapter(1000000), provider: 'eval-offline', model: 'scripted', contextWindow: 1000000 });
    try {
      runtime.initialize(item.system);
      for (const message of item.stages[0].messages) await runtime.append(message, new AbortController().signal);
      const compactions = runtime.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length;
      output.push(`${policy.id}:${runtime.measure().totalTokens}/${compactions}`);
    } finally { await runtime.close(); }
  }
  console.log(`${item.id} ${output.join(' ')}`);
}
