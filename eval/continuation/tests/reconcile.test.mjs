import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../fixture.mjs';
import { reconcile } from '../reconcile.mjs';

test('reconciliation replaces only infrastructure errors with one compatible first rerun', t => {
  const root = mkdtempSync(join(tmpdir(), 'continuation-reconcile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'), rerun = join(root, 'rerun'), datasetFile = join(root, 'dataset.json');
  mkdirSync(main); mkdirSync(rerun);
  const dataset = { version: 1, id: 'test-dataset', cases: [{ id: 'a' }, { id: 'b' }] };
  writeFileSync(datasetFile, JSON.stringify(dataset));
  const full = { id: 'full', compact: false }, compressed = { id: 'compressed', compact: true, thresholdRatio: .8, retainRatio: .16 };
  const common = { status: 'completed', model: 'fixture', thinking: 'disabled', contextWindow: 1000000, repeats: 1, maxSteps: 8, timeoutMs: 300000, backend: 'offline', endpoint: 'offline', toolSchemaHash: 'tools', sourceHashes: { runner: 'one' }, sharedHashes: {}, dependencyHashes: {}, lockfileHash: 'lock', checkHashes: { a: 'check-a', b: 'check-b' }, callsUsed: 2 };
  const mainManifest = { ...common, status: 'completed-with-errors', policies: [full, compressed], dataset: { id: dataset.id, hash: hash(dataset) }, plannedBranches: 4, completedBranches: 4 };
  const rerunManifest = { ...common, policies: [full], dataset: { id: dataset.id, hash: hash({ ...dataset, cases: [dataset.cases[0]] }) }, plannedBranches: 1, completedBranches: 1, callsUsed: 1 };
  writeFileSync(join(main, 'manifest.json'), JSON.stringify(mainManifest));
  writeFileSync(join(rerun, 'manifest.json'), JSON.stringify(rerunManifest));
  const rows = [
    { case: 'a', repeat: 1, policy: 'full', error: 'TRANSPORT', success: false, calls: 1, compactions: 0 },
    { case: 'a', repeat: 1, policy: 'compressed', error: null, success: false, calls: 1, compactions: 0 },
    { case: 'b', repeat: 1, policy: 'full', error: null, success: true, calls: 1, compactions: 0 },
    { case: 'b', repeat: 1, policy: 'compressed', error: null, success: true, calls: 1, compactions: 1 },
  ];
  writeFileSync(join(main, 'scores.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const replacement = { ...rows[0], error: null, success: true, calls: 1 };
  writeFileSync(join(rerun, 'scores.jsonl'), JSON.stringify(replacement) + '\n');
  const result = reconcile(main, datasetFile, [rerun]);
  assert.equal(result.rows[0].success, true);
  assert.equal(result.rows[1].success, false);
  assert.equal(result.manifest.reconciliation.replacements.length, 1);
  assert.equal(result.losses[0].lostWithoutSummary, 1);
  assert.match(readFileSync(join(main, 'reconciled-report.md'), 'utf8'), /first valid rerun/);
  writeFileSync(join(rerun, 'manifest.json'), JSON.stringify({ ...rerunManifest, endpoint: 'different' }));
  assert.throws(() => reconcile(main, datasetFile, [rerun]), /Incompatible rerun/);
  writeFileSync(join(rerun, 'manifest.json'), JSON.stringify(rerunManifest));
  writeFileSync(join(rerun, 'scores.jsonl'), JSON.stringify({ ...rows[1], success: true }) + '\n');
  assert.throws(() => reconcile(main, datasetFile, [rerun]), /replace exactly one unresolved/);
});
