import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash } from '../compaction/fixture.mjs';

const readLines = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const key = (row, score) => JSON.stringify([row.case, row.repeat, row.stage, score.id]);
const ratio = (passed, total) => `${passed}/${total}`;

export function analyze(manifest, rows, calls, dataset) {
  if (manifest.dataset.hash !== hash(dataset)) throw Error('Dataset hash does not match the run manifest');
  const policyIds = manifest.policies.map(policy => policy.id);
  const categories = ['recall', 'artifact', 'decision', 'continuation', 'constraint'];
  const byPolicy = new Map(policyIds.map(id => [id, { calls: 0, input: 0, cacheRead: 0, output: 0, missingUsage: 0, passed: 0, total: 0, ungraded: 0, unknown: 0, errors: 0, compactions: 0, prunes: 0, cases: new Map(), categories: new Map() }]));
  const paired = new Map();
  const failures = [];
  const judgeAudit = [];
  const original = new Map(dataset.cases.map(item => [item.id, item]));
  for (const row of rows) {
    const group = byPolicy.get(row.policy);
    if (!group) throw Error(`Unknown policy in score row: ${row.policy}`);
    group.errors += Number(!!row.error); group.compactions += row.compactions; group.prunes += row.prunes;
    let caseGroup = group.cases.get(row.case);
    if (!caseGroup) group.cases.set(row.case, caseGroup = { passed: 0, total: 0, compactions: 0, prunes: 0 });
    caseGroup.compactions += row.compactions; caseGroup.prunes += row.prunes;
    for (const score of row.grade.scores) {
      group.total++; group.passed += Number(score.passed); caseGroup.total++; caseGroup.passed += Number(score.passed);
      group.ungraded += Number(score.status === 'ungraded' || score.status === 'pending');
      group.unknown += Number(typeof score.answer === 'string' && score.answer.trim().toUpperCase() === 'UNKNOWN');
      let category = group.categories.get(score.category);
      if (!category) group.categories.set(score.category, category = { passed: 0, total: 0 });
      category.total++; category.passed += Number(score.passed);
      const pairKey = key(row, score);
      let pair = paired.get(pairKey);
      if (!pair) paired.set(pairKey, pair = new Map());
      if (pair.has(row.policy)) throw Error(`Duplicate policy result at ${pairKey}`);
      pair.set(row.policy, score);
      if (!score.passed) {
        const probe = original.get(row.case)?.stages.find(stage => stage.id === row.stage)?.probes.find(probe => probe.id === score.id);
        const failure = { case: row.case, repeat: row.repeat, policy: row.policy, stage: row.stage, probe: score.id, status: score.status, answer: score.answer, expected: probe?.accept, reason: score.judgment?.reason ?? row.error ?? row.grade.parseError ?? null };
        failures.push(failure);
        const norm = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
        if (score.method === 'semantic' && typeof score.answer === 'string' && probe?.accept.some(expected => norm(expected) === norm(score.answer))) judgeAudit.push(failure);
      }
    }
  }
  for (const call of calls) {
    const group = byPolicy.get(call.policy);
    if (!group) continue; // Calibration has no policy by design.
    group.calls++;
    if (!call.usage) group.missingUsage++;
    else { group.input += call.usage.inputTokens ?? 0; group.cacheRead += call.usage.cacheReadTokens ?? 0; group.output += call.usage.outputTokens ?? 0; }
  }
  const comparisons = policyIds.filter(id => id !== 'full').map(id => {
    let pairs = 0, lost = 0, gained = 0, bothWrong = 0;
    for (const pair of paired.values()) {
      const control = pair.get('full'), candidate = pair.get(id);
      if (!control || !candidate) continue;
      pairs++;
      if (control.passed && !candidate.passed) lost++;
      if (!control.passed && candidate.passed) gained++;
      if (!control.passed && !candidate.passed) bothWrong++;
    }
    return { policy: id, pairs, lost, gained, bothWrong };
  });
  const lines = [
    '# Expanded compaction evaluation breakdown', '',
    `Run status: ${manifest.status}; model: ${manifest.model}; dataset: ${manifest.dataset.id}; context window: ${manifest.contextWindow}; repeats: ${manifest.repeats}.`,
    `Completed checkpoints: ${manifest.completedCheckpoints}/${manifest.plannedCheckpoints}. These are correlated synthetic transcript probes, not independent coding tasks.`, '',
    '| Policy | Correct/probes | Ungraded | UNKNOWN | Eval errors | Summaries | Tool prunes | Calls | Provider uncached input / cache read / output tokens |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...policyIds.map(id => { const g = byPolicy.get(id); return `| ${id} | ${ratio(g.passed, g.total)} | ${g.ungraded} | ${g.unknown} | ${g.errors} | ${g.compactions} | ${g.prunes} | ${g.calls} | ${g.missingUsage ? 'usage incomplete' : `${g.input}/${g.cacheRead}/${g.output}`} |`; }), '',
    'Calibration calls are excluded from policy call and token totals. Token values are raw provider usage, with no price estimate. Total prompt tokens are uncached input plus cache read.', '',
    '## Paired with full context', '',
    'Each pair is the same case, repeat, stage and probe. Lost means full passed and the policy failed; gained means the reverse. These counts are descriptive because probes within a session are correlated.', '',
    '| Policy | Paired probes | Lost | Gained | Both wrong |', '|---|---:|---:|---:|---:|',
    ...comparisons.map(c => `| ${c.policy} | ${c.pairs} | ${c.lost} | ${c.gained} | ${c.bothWrong} |`), '',
    '## By case', '',
    '| Case | ' + policyIds.join(' | ') + ' |',
    '|---|' + policyIds.map(() => '---:|').join(''),
    ...dataset.cases.map(item => `| ${item.id} | ${policyIds.map(id => { const c = byPolicy.get(id).cases.get(item.id); return c ? ratio(c.passed, c.total) : '—'; }).join(' | ')} |`), '',
    '## By question type', '',
    '| Type | ' + policyIds.join(' | ') + ' |', '|---|' + policyIds.map(() => '---:|').join(''),
    ...categories.map(category => `| ${category} | ${policyIds.map(id => { const c = byPolicy.get(id).categories.get(category); return c ? ratio(c.passed, c.total) : '—'; }).join(' | ')} |`), '',
    '## Judge audit queue', '',
    `${judgeAudit.length} semantic answers exactly match a fixture reference after Unicode, whitespace and case normalization but were scored as failures. These require review; raw scores below are unchanged.`, '',
    ...judgeAudit.map(f => `- ${f.case} / repeat ${f.repeat} / ${f.policy} / ${f.stage} / ${f.probe}: answer ${JSON.stringify(f.answer)}; reference ${JSON.stringify(f.expected)}.`), '',
    '## Failed probes', '',
    `${failures.length} failed or ungraded probes. Raw answer, score and source-visible context remain in scores.jsonl and contexts.jsonl.`, '',
    '| Case / repeat | Policy / stage | Probe | Status | Answer | Reference |', '|---|---|---|---|---|---|',
    ...failures.slice(0, 80).map(f => `| ${f.case} / ${f.repeat} | ${f.policy} / ${f.stage} | ${f.probe} | ${f.status} | ${String(f.answer ?? 'null').replaceAll('|', '\\|').replaceAll('\n', ' ').slice(0, 100)} | ${f.expected?.join(' OR ').replaceAll('|', '\\|') ?? 'unknown'} |`),
    ...(failures.length > 80 ? [`| ... | ... | ... | ... | ${failures.length - 80} more rows in scores.jsonl | ... |`] : []), '',
  ];
  return { markdown: lines.join('\n'), comparisons, failures, judgeAudit, byPolicy };
}

export function writeAnalysis(runDirectory, datasetFile) {
  const directory = resolve(runDirectory);
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const dataset = JSON.parse(readFileSync(datasetFile, 'utf8'));
  const result = analyze(manifest, readLines(join(directory, 'scores.jsonl')), readLines(join(directory, 'calls.jsonl')), dataset);
  writeFileSync(join(directory, 'analysis.md'), result.markdown);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw Error('Usage: node eval/analysis/report.mjs <run-directory> <dataset-file>');
  writeAnalysis(process.argv[2], process.argv[3]);
  console.log(join(resolve(process.argv[2]), 'analysis.md'));
}
