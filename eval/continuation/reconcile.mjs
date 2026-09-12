import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from './fixture.mjs';
import { markdownReport, summarize, paired } from './report.mjs';

const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const lines = (dir, name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const identity = row => JSON.stringify([row.case, row.repeat, row.policy]);
const errorRow = row => row.error && row.error !== 'step-limit';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function reconcile(mainDirectory, datasetFile, rerunDirectories) {
  const main = resolve(mainDirectory);
  const dataset = JSON.parse(readFileSync(datasetFile, 'utf8'));
  const manifest = read(main, 'manifest.json');
  if (manifest.dataset.hash !== hash(dataset) || manifest.completedBranches !== manifest.plannedBranches) throw Error('Main run dataset or branch count does not match');
  const original = lines(main, 'scores.jsonl');
  const byKey = new Map(original.map(row => [identity(row), row]));
  if (byKey.size !== original.length || original.length !== manifest.plannedBranches) throw Error('Main run has duplicate or missing branches');
  const replacements = new Map();
  let rerunCalls = 0;
  for (const directory of rerunDirectories) {
    const path = resolve(directory), revision = read(path, 'manifest.json'), rows = lines(path, 'scores.jsonl');
    if (revision.status !== 'completed' || revision.completedBranches !== rows.length || !['model', 'thinking', 'contextWindow', 'repeats', 'maxSteps', 'timeoutMs', 'backend', 'endpoint', 'toolSchemaHash', 'sourceHashes', 'sharedHashes', 'dependencyHashes', 'lockfileHash'].every(key => same(manifest[key], revision[key]))) throw Error(`Incompatible rerun: ${path}`);
    const selected = { ...dataset, cases: dataset.cases.filter(item => rows.some(row => row.case === item.id)) };
    if (revision.dataset.hash !== hash(selected)) throw Error(`Rerun dataset differs: ${path}`);
    rerunCalls += revision.callsUsed;
    for (const row of rows) {
      const key = identity(row), old = byKey.get(key);
      if (!old || !errorRow(old) || replacements.has(key) || errorRow(row)) throw Error(`Rerun may replace exactly one unresolved infrastructure error: ${key}`);
      const expectedPolicy = manifest.policies.find(policy => policy.id === row.policy);
      const actualPolicy = revision.policies.find(policy => policy.id === row.policy);
      if (!same(expectedPolicy, actualPolicy) || manifest.checkHashes[row.case] !== revision.checkHashes[row.case]) throw Error(`Policy or hidden check changed: ${key}`);
      replacements.set(key, { row, source: path, priorError: old.error });
    }
  }
  for (const row of original) if (errorRow(row) && !replacements.has(identity(row))) throw Error(`Missing rerun for ${identity(row)}`);
  const rows = original.map(row => replacements.get(identity(row))?.row ?? row);
  const reconciled = { ...manifest, status: rows.some(errorRow) ? 'completed-with-errors' : 'completed', completedBranches: rows.length, callsUsed: manifest.callsUsed + rerunCalls,
    reconciliation: { method: 'first-valid-rerun-of-infrastructure-errors-only', original: main, reruns: rerunDirectories.map(path => resolve(path)), replacements: [...replacements].map(([key, value]) => ({ key: JSON.parse(key), source: value.source, priorError: value.priorError })), analysisSourceHash: hash(readFileSync(fileURLToPath(import.meta.url), 'utf8')) } };
  const reconciliationNote = [
    '## Reconciliation of infrastructure errors', '',
    `Original run: ${main}.`,
    `Only the ${replacements.size} provider/compaction error branches were replaced by their first valid rerun; all original task outcomes remain unchanged. Total attempted calls across original and reruns: ${reconciled.callsUsed}. Effective per-policy calls below exclude discarded error attempts.`,
    'A paired loss without an actual compaction is sampling or runtime variation, not evidence of summary loss.', '',
  ].join('\n');
  const losses = paired(rows, manifest.policies).map(comparison => {
    const lost = rows.filter(row => row.policy === comparison.policy && !row.success && !errorRow(row) && rows.some(control => control.case === row.case && control.repeat === row.repeat && control.policy === 'full' && control.success));
    return { policy: comparison.policy, lostWithSummary: lost.filter(row => row.compactions > 0).length, lostWithoutSummary: lost.filter(row => row.compactions === 0).length };
  });
  const suffix = ['## Losses by actual compaction', '', '| Policy | Lost after summary | Lost without summary |', '|---|---:|---:|', ...losses.map(value => `| ${value.policy} | ${value.lostWithSummary} | ${value.lostWithoutSummary} |`), ''].join('\n');
  writeFileSync(join(main, 'reconciled-manifest.json'), JSON.stringify(reconciled, null, 2) + '\n');
  writeFileSync(join(main, 'reconciled-scores.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeFileSync(join(main, 'reconciled-summary.json'), JSON.stringify({ groups: summarize(rows, manifest.policies), comparisons: paired(rows, manifest.policies), losses }, null, 2) + '\n');
  writeFileSync(join(main, 'reconciled-report.md'), markdownReport(reconciled, rows) + '\n' + reconciliationNote + suffix);
  return { manifest: reconciled, rows, losses };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 5) throw Error('Usage: node eval/continuation/reconcile.mjs <main-run> <dataset-file> <rerun> [rerun...]');
  const result = reconcile(process.argv[2], process.argv[3], process.argv.slice(4));
  console.log(join(resolve(process.argv[2]), 'reconciled-report.md'), `${result.rows.length} branches`, `${result.manifest.reconciliation.replacements.length} replaced`);
}
