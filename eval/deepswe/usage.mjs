import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeUsage(calls) {
  const usage = calls.map(call => call.usage).filter(Boolean);
  return {
    calls: calls.length,
    callsWithUsage: usage.length,
    callsMissingUsage: calls.length - usage.length,
    uncachedInputTokens: usage.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
    cacheReadTokens: usage.reduce((sum, item) => sum + (item.cacheReadTokens ?? 0), 0),
    inputTokensIncludingCache: usage.reduce((sum, item) => sum + (item.inputTokens ?? 0) + (item.cacheReadTokens ?? 0), 0),
    outputTokens: usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    peakPromptTokensIncludingCache: Math.max(0, ...usage.map(item => (item.inputTokens ?? 0) + (item.cacheReadTokens ?? 0))),
  };
}

export function writeUsageAnalysis(agentDirectory) {
  const directory = resolve(agentDirectory);
  const calls = readFileSync(join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const priorReport = JSON.parse(readFileSync(join(directory, 'agent-report.json'), 'utf8'));
  const result = {
    source: 'calls.jsonl',
    note: 'DeepSeek cacheReadTokens are part of prompt input; original agent-report.json is preserved.',
    priorReportPeakInputTokens: priorReport.peakInputTokens,
    ...summarizeUsage(calls),
  };
  writeFileSync(join(directory, 'usage-analysis.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw Error('Usage: node eval/deepswe/usage.mjs <pier-trial-agent-dir>');
  console.log(JSON.stringify(writeUsageAnalysis(process.argv[2]), null, 2));
}
