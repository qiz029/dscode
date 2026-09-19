export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    let group = groups.get(row.policy);
    if (!group) groups.set(row.policy, group = { policy: row.policy, checkpoints: 0, errors: 0, formatDeviations: 0, passed: 0, total: 0, ungraded: 0, compactions: 0, prunes: 0, retainedQuotes: 0, totalQuotes: 0, retainedTerms: 0, totalTerms: 0, estimatedBeforeTokens: 0, estimatedAfterTokens: 0, categories: {}, cases: new Set() });
    group.checkpoints++; group.cases.add(`${row.case}/${row.repeat}`);
    group.errors += row.error ? 1 : 0;
    group.formatDeviations += Number(row.grade.format === 'markdown-fence');
    group.passed += row.grade.passed; group.total += row.grade.total;
    group.compactions += row.compactions; group.prunes += row.prunes;
    group.retainedQuotes += row.retention?.retained ?? 0; group.totalQuotes += row.retention?.quotes ?? 0;
    group.retainedTerms += row.retention?.termsRetained ?? 0; group.totalTerms += row.retention?.terms ?? 0;
    group.estimatedBeforeTokens += row.beforeTokens; group.estimatedAfterTokens += row.afterTokens;
    for (const score of row.grade.scores) {
      if (['ungraded', 'pending'].includes(score.status)) group.ungraded++;
      const category = group.categories[score.category] ??= { passed: 0, total: 0 };
      category.total++; category.passed += Number(score.passed);
    }
  }
  return [...groups.values()].map(({ cases, ...group }) => ({ ...group, caseRuns: cases.size, accuracy: group.total ? group.passed / group.total : null, exercised: group.compactions > 0 }));
}

export function markdownReport(manifest, rows, calls) {
  const groups = summarize(rows);
  // Retention columns only appear for v2 datasets that carry verbatim evidence.
  const withRetention = groups.some(group => group.totalQuotes > 0);
  const columns = ['Policy', 'Correct / probes', 'Ungraded', 'Eval errors', ...(withRetention ? ['Evidence kept (quotes)', 'Evidence kept (terms)'] : []), 'Fenced JSON', 'Summaries', 'Tool prunes', 'Compression exercised'];
  const align = columns.map((_, index) => index === 0 ? '---' : '---:');
  const tableRow = group => {
    const cells = [group.policy, `${group.passed} / ${group.total}`, group.ungraded, group.errors];
    // A policy with no evidence-bearing probes gets a dash rather than a 0/0 ratio.
    if (withRetention) cells.push(group.totalQuotes ? `${group.retainedQuotes} / ${group.totalQuotes}` : '—', group.totalTerms ? `${group.retainedTerms} / ${group.totalTerms}` : '—');
    return `| ${cells.concat([group.formatDeviations, group.compactions, group.prunes, group.exercised ? 'yes' : 'no']).join(' | ')} |`;
  };
  return [
    '# Compaction evaluation', '',
    manifest.backend === 'offline' ? '**OFFLINE PIPELINE CHECK — scores are from a scripted adapter, not model quality.**' : '**MODEL RECALL EVAL — this does not execute coding tasks or prove task completion.**', '',
    `Dataset: ${manifest.dataset.id}; SHA-256: \`${manifest.dataset.hash}\``,
    `Model: ${manifest.model}; policy window: ${manifest.contextWindow}; repeats: ${manifest.repeats}.`,
    `Started: ${manifest.startedAt}; status: ${manifest.status}.`, '',
    `Grading: ${manifest.grading?.protocol ?? 'exact-v1'}${manifest.grading?.answerProtocol ? '; answer protocol: ' + manifest.grading.answerProtocol : ''}${manifest.grading?.judgeModel ? '; isolated judge model: ' + manifest.grading.judgeModel : ''}.`,
    ...(manifest.grading?.calibration ? [`Judge calibration: ${manifest.grading.calibration.correct}/${manifest.grading.calibration.total}; ${manifest.grading.calibration.passed ? 'passed' : 'FAILED'}. Same-model judging can still share biases; this is a calibration check, not proof of judge infallibility.`] : []), '',
    `Completed checkpoints: ${manifest.completedCheckpoints ?? rows.length} / ${manifest.plannedCheckpoints}.`,
    manifest.contextWindow < 1000000 ? '**Reduced-window micro-eval. This run cannot establish the best threshold at the real 1M window.**' : 'The declared window is 1M; check actual compaction counts and transcript provenance before interpreting thresholds.', '',
    `| ${columns.join(' | ')} |`,
    `|${align.join('|')}|`,
    ...groups.map(tableRow), '',
    `Model calls recorded: ${calls.length}; calls without provider usage: ${calls.filter(call => !call.usage).length}.`,
    'Raw provider usage is preserved in calls.jsonl. Missing usage/cost is unknown, never zero. No price estimate is made.', '',
    'Token pressure is the native DSH estimate for the replayed transcript, not an exact tokenizer count. Probe calls are separate and never enter subsequent history.',
    'A policy with no compactions supplies no evidence about summary quality. Full-context overflow is recorded as an error, not silently truncated.',
    'Different checkpoints from the same case are correlated. Compare repeated case runs; do not treat individual probes as independent benchmark trials.',
    'shipped-80 reproduces current ratios; only controlled-* hold retention constant to isolate trigger thresholds.',
    ...(withRetention ? ["Evidence kept counts the probe's verbatim source quotes still present in the exact context the answer was produced from; it needs no judge call and is independent of answer phrasing.", ''] : ['']),
  ].join('\n');
}
