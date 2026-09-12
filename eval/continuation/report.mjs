export function summarize(rows, policies) {
  return policies.map(policy => {
    const selected = rows.filter(row => row.policy === policy.id);
    return { policy: policy.id, cases: selected.length, success: selected.filter(row => row.success).length, summaries: selected.reduce((sum, row) => sum + row.compactions, 0), errors: selected.filter(row => row.error && row.error !== 'step-limit').length, calls: selected.reduce((sum, row) => sum + row.calls, 0) };
  });
}

export function paired(rows, policies) {
  return policies.filter(policy => policy.id !== 'full').map(policy => {
    let compared = 0, lost = 0, gained = 0, bothFailed = 0, excluded = 0;
    for (const row of rows.filter(row => row.policy === policy.id)) {
      const control = rows.find(other => other.case === row.case && other.repeat === row.repeat && other.policy === 'full');
      if (!control) continue;
      if ([row, control].some(value => value.error && value.error !== 'step-limit')) { excluded++; continue; }
      compared++;
      if (control.success && !row.success) lost++;
      if (!control.success && row.success) gained++;
      if (!control.success && !row.success) bothFailed++;
    }
    return { policy: policy.id, compared, lost, gained, bothFailed, excluded };
  });
}

export function markdownReport(manifest, rows) {
  const groups = summarize(rows, manifest.policies);
  const comparisons = paired(rows, manifest.policies);
  return [
    '# Coding continuation evaluation', '',
    `Status: ${manifest.status}; model: ${manifest.model}; window: ${manifest.contextWindow}; dataset: ${manifest.dataset.id}.`,
    `Completed branches: ${rows.length}/${manifest.plannedBranches}; calls: ${manifest.callsUsed ?? 'in progress'}.`,
    'Each branch replays the same case history into a fresh fixture workspace, then gives the model the same read/write/test tools and step budget. Hidden checks run only after the model finishes. This is a bounded agent loop, not the full dscode CLI.', '',
    '| Policy | Tasks passed | Branches | Summaries | Eval errors | Model calls |', '|---|---:|---:|---:|---:|---:|',
    ...groups.map(group => `| ${group.policy} | ${group.success} | ${group.cases} | ${group.summaries} | ${group.errors} | ${group.calls} |`), '',
    '## Paired with full history', '',
    '| Policy | Compared tasks | Lost | Gained | Both failed | Excluded eval errors |', '|---|---:|---:|---:|---:|---:|',
    ...comparisons.map(group => `| ${group.policy} | ${group.compared} | ${group.lost} | ${group.gained} | ${group.bothFailed} | ${group.excluded} |`), '',
    '## By case', '',
    '| Case | ' + manifest.policies.map(policy => policy.id).join(' | ') + ' |',
    '|---|' + manifest.policies.map(() => '---:|').join(''),
    ...[...new Set(rows.map(row => row.case))].map(id => `| ${id} | ${manifest.policies.map(policy => { const row = rows.find(value => value.case === id && value.policy === policy.id); return row ? `${row.success ? 'pass' : 'fail'} (${row.compactions} summaries)` : '—'; }).join(' | ')} |`), '',
    'Passing requires a changed source file, model completion within the step limit, and the hidden behavior/constraint checks to pass. A visible-test pass alone is insufficient. Provider and compaction errors are excluded from paired task-quality counts, never treated as task failures. Failed and partial branches remain in scores.jsonl and their isolated workspaces.', '',
  ].join('\n');
}
