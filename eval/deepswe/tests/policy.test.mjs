import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPolicy } from '../agent.mjs';

test('paired DeepSWE policies differ only in trigger threshold', () => {
  const early = selectPolicy(.4);
  const shipped = selectPolicy(.8);
  assert.equal(shipped.id, 'shipped-80');
  assert.equal(early.id, 'threshold-40-retain-16');
  assert.deepEqual({ ...early, id: shipped.id, thresholdRatio: shipped.thresholdRatio }, shipped);
  assert.throws(() => selectPolicy(.25), /threshold ratio/);
});
