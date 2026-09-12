import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { reserve } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/quota.mjs')));
const original = { balance: 9, reservations: { old: 2 } };
const fresh = reserve(original, 'new', 3);
assert.deepEqual(fresh, { ok: true, state: { balance: 6, reservations: { old: 2, new: 3 } } });
assert.deepEqual(original, { balance: 9, reservations: { old: 2 } });
const repeated = reserve(original, 'old', 2);
assert.equal(repeated.ok, true);
assert.equal(repeated.state, original);
const mismatch = reserve(original, 'old', 4);
assert.equal(mismatch.ok, false);
assert.equal(mismatch.state, original);
for (const amount of [0, -1, 1.5, 10]) {
  const result = reserve(original, 'another', amount);
  assert.equal(result.ok, false);
  assert.equal(result.state, original);
}
console.log('hidden checks passed');
