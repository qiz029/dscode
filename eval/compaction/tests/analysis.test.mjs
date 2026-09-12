import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hash } from '../fixture.mjs';
import { analyze } from '../../analysis/report.mjs';

test('paired breakdown keeps baseline failures, policy losses and gains distinct', () => {
  const dataset = JSON.parse(readFileSync(new URL('../fixtures/coding-broad-v1.json', import.meta.url)));
  const manifest = { status: 'completed', model: 'test', dataset: { id: dataset.id, hash: hash(dataset) }, contextWindow: 16384, repeats: 1, completedCheckpoints: 2, plannedCheckpoints: 2, policies: [{ id: 'full' }, { id: 'controlled-40' }] };
  const scores = (endpoint, file) => [
    { id: 'endpoint', category: 'recall', answer: endpoint ? '/api/auth/login' : 'UNKNOWN', status: endpoint ? 'pass' : 'fail', passed: endpoint },
    { id: 'file', category: 'artifact', answer: file ? 'src/auth/session.ts' : 'UNKNOWN', status: file ? 'pass' : 'fail', passed: file },
  ];
  const rows = [
    { case: 'login-correction', repeat: 1, policy: 'full', stage: 'checkpoint-1', error: null, compactions: 0, prunes: 0, grade: { scores: scores(true, false) } },
    { case: 'login-correction', repeat: 1, policy: 'controlled-40', stage: 'checkpoint-1', error: null, compactions: 1, prunes: 0, grade: { scores: scores(false, true) } },
  ];
  const calls = [{ policy: 'full', usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5 } }, { policy: 'controlled-40', usage: null }, { phase: 'judge-calibration', usage: { inputTokens: 99, outputTokens: 99 } }];
  const result = analyze(manifest, rows, calls, dataset);
  assert.deepEqual(result.comparisons, [{ policy: 'controlled-40', pairs: 2, lost: 1, gained: 1, bothWrong: 0 }]);
  assert.equal(result.failures.length, 2);
  assert.equal(result.byPolicy.get('controlled-40').unknown, 1);
  assert.equal(result.byPolicy.get('controlled-40').missingUsage, 1);
  assert.equal(result.byPolicy.get('full').cacheRead, 20);
  assert.match(result.markdown, /10\/20\/5/);
  assert.match(result.markdown, /usage incomplete/);
  assert.throws(() => analyze({ ...manifest, dataset: { ...manifest.dataset, hash: 'wrong' } }, rows, calls, dataset), /hash/);
});

test('analysis flags a semantic rejection of an exact reference without rewriting its raw score', () => {
  const dataset = JSON.parse(readFileSync(new URL('../fixtures/coding-broad-v1.json', import.meta.url)));
  const manifest = { status: 'completed', model: 'test', dataset: { id: dataset.id, hash: hash(dataset) }, contextWindow: 16384, repeats: 1, completedCheckpoints: 1, plannedCheckpoints: 1, policies: [{ id: 'full' }] };
  const row = { case: 'login-correction', repeat: 1, policy: 'full', stage: 'checkpoint-1', error: null, compactions: 0, prunes: 0, grade: { scores: [{ id: 'decision', category: 'decision', method: 'semantic', answer: 'reuse the existing session store', status: 'fail', passed: false }] } };
  const result = analyze(manifest, [row], [], dataset);
  assert.equal(result.judgeAudit.length, 1);
  assert.equal(result.byPolicy.get('full').passed, 0);
});
