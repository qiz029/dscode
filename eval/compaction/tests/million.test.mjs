import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateDataset, validatePolicies } from '../fixture.mjs';
import { OfflineAdapter } from '../adapters.mjs';
import { createRuntime } from '../runtime.mjs';

const root = join(import.meta.dirname, '..');
const dataset = validateDataset(JSON.parse(readFileSync(join(root, 'fixtures/coding-million-v1.json'), 'utf8')));
const policies = validatePolicies(JSON.parse(readFileSync(join(root, 'policies.json'), 'utf8')));

test('1M pressure fixture crosses each native threshold without overflowing the full control', async () => {
  assert.equal(dataset.cases.length, 10);
  const exercised = Object.fromEntries(policies.map(policy => [policy.id, 0]));
  for (const item of dataset.cases) {
    assert.equal(item.stages.length, 1);
    assert.equal(item.stages[0].probes.length, 5);
    for (const policy of policies) {
      const runtime = createRuntime({ policy, adapter: new OfflineAdapter(1000000), provider: 'eval-offline', model: 'scripted', contextWindow: 1000000 });
      try {
        runtime.initialize(item.system);
        for (const message of item.stages[0].messages) await runtime.append(message, new AbortController().signal);
        const count = runtime.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length;
        if (count) exercised[policy.id]++;
        assert(runtime.measure().totalTokens < 1000000, `${item.id}/${policy.id} overflowed`);
      } finally { await runtime.close(); }
    }
  }
  assert.deepEqual(exercised, { full: 0, 'shipped-80': 4, 'controlled-80': 4, 'controlled-40': 7, 'controlled-25': 10 });
});
