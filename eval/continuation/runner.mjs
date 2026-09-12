import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { integer } from '../compaction/fixture.mjs';
import { BudgetAdapter, deepseekAdapter } from '../compaction/adapters.mjs';
import { createRuntime, visibleMessages } from '../compaction/runtime.mjs';
import { hash, replayMessages, validateContinuationDataset, validatePolicies } from './fixture.mjs';
import { createWorkspace, runCheck, TOOL_SCHEMAS } from './workspace.mjs';
import { markdownReport, summarize, paired } from './report.mjs';

const here = import.meta.dirname;
const defaultDataset = join(here, 'fixtures/cases.json');
const defaultPolicies = join(here, '../compaction/policies.json');
const codeOf = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,47}$/u.test(error.code) ? error.code : ['continuation-context-overflow', 'incomplete-continuation-response', 'empty-continuation-tool-call'].includes(error?.message) ? error.message : 'runtime-or-provider-error';

export async function runContinuationEvaluation({ dataset, policies, backend = 'deepseek', model = 'deepseek-flash', contextWindow = 16384, repeats = 1, maxSteps = 8, maxCalls = 200, timeoutMs = 60000, output, apiKey, baseURL, thinking = 'disabled', adapterFactory, signal = new AbortController().signal, onProgress = () => {} }) {
  dataset = validateContinuationDataset(dataset); policies = validatePolicies(policies);
  integer(contextWindow, 'contextWindow', 4096); integer(repeats, 'repeats', 1, 20); integer(maxSteps, 'maxSteps', 1, 30); integer(maxCalls, 'maxCalls', 1, 10000); integer(timeoutMs, 'timeoutMs', 1, 300000);
  if (!['deepseek', 'offline'].includes(backend) || !['disabled', 'enabled'].includes(thinking)) throw Error('Invalid backend or thinking mode');
  if (backend === 'offline' && !adapterFactory) throw Error('Offline continuation requires a test adapter; scripted scores are not model quality');
  if (typeof model !== 'string' || !model.trim()) throw Error('Invalid model');
  const checks = Object.fromEntries(dataset.cases.map(item => [item.id, join(here, 'fixtures/checks', `${item.id}.mjs`)]));
  for (const path of Object.values(checks)) if (!existsSync(path)) throw Error(`Missing hidden check: ${path}`);
  const makeAdapter = adapterFactory ?? (() => deepseekAdapter({ model, contextWindow, apiKey, baseURL, thinking }));
  makeAdapter(); // Validate credential/endpoint before touching output.
  output = resolve(output ?? join(here, '../results', `continuation-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`));
  mkdirSync(resolve(output, '..'), { recursive: true });
  mkdirSync(output);
  const manifest = {
    version: 1, status: 'running', startedAt: new Date().toISOString(), backend, model, thinking, contextWindow, repeats, maxSteps, maxCalls, timeoutMs,
    plannedBranches: dataset.cases.length * policies.length * repeats,
    dataset: { id: dataset.id, hash: hash(dataset) }, policies, toolSchemaHash: hash(TOOL_SCHEMAS),
    sourceHashes: Object.fromEntries(readdirSync(here).filter(name => name.endsWith('.mjs')).sort().map(name => [name, hash(readFileSync(join(here, name), 'utf8'))])),
    sharedHashes: Object.fromEntries(['runtime.mjs', 'adapters.mjs'].map(name => [name, hash(readFileSync(join(here, '../compaction', name), 'utf8'))])),
    dependencyHashes: Object.fromEntries(['dsh-compaction-basic', 'dsh-compaction-tool-result-pruner', 'dsh-token-meter', 'dsh-llm-deepseek'].map(name => [name, hash(readFileSync(join(here, '../../node_modules/@deepseek-ai', name, 'lib/index.js'), 'utf8'))])),
    checkHashes: Object.fromEntries(Object.entries(checks).map(([id, path]) => [id, hash(readFileSync(path, 'utf8'))])),
    lockfileHash: hash(readFileSync(join(here, '../../package-lock.json'), 'utf8')),
    endpoint: backend === 'deepseek' ? baseURL ?? 'https://api.deepseek.com' : null,
    modelRevision: 'Requested model id only; provider aliases may change.',
    design: 'paired-isolated-coding-continuation',
  };
  const rows = [], calls = [], budget = { used: 0, limit: maxCalls };
  const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
  const append = (name, value) => appendFileSync(join(output, name), JSON.stringify(value) + '\n');
  json('manifest.json', manifest);
  let failure;
  try {
    for (let repeat = 1; repeat <= repeats; repeat++) for (const item of dataset.cases) {
      const order = policies.map((_, i) => policies[(i + repeat - 1) % policies.length]);
      for (const policy of order) {
        signal.throwIfAborted();
        const identity = { case: item.id, repeat, policy: policy.id };
        const branchDir = join(output, 'workspaces', `repeat-${repeat}`, item.id, policy.id);
        mkdirSync(resolve(branchDir, '..'), { recursive: true });
        const workspace = createWorkspace(branchDir, item);
        const callStart = budget.used;
        const runtime = createRuntime({ policy, adapter: new BudgetAdapter(makeAdapter(), budget, timeoutMs), provider: backend === 'deepseek' ? 'deepseek-official' : 'eval-offline', model, contextWindow, tools: TOOL_SCHEMAS,
          onCall: call => { const record = { ...identity, ...call }; calls.push(record); append('calls.jsonl', record); } });
        let done = false, error = null, steps = 0, finalText = '';
        try {
          runtime.initialize(`${item.system}\nAvailable files: ${workspace.files().join(', ')}. Writable source files: ${item.writable.join(', ')}. Use only the provided tools.`);
          for (const message of replayMessages(item, contextWindow)) await runtime.append(message, signal);
          while (!done && steps < maxSteps) {
            signal.throwIfAborted(); steps++;
            const step = await runtime.agentStep((name, args, currentSignal) => workspace.execute(name, args, currentSignal), signal, Math.min(4096, Math.floor(contextWindow * .08)));
            append('traces.jsonl', { ...identity, step: steps, ...step });
            done = step.done; finalText = step.text;
          }
          if (!done) error = 'step-limit';
        } catch (cause) {
          if (signal.aborted || budget.used >= budget.limit) throw cause;
          error = codeOf(cause);
        } finally {
          const events = runtime.session.snapshotEvents();
          const changedFiles = workspace.changes();
          const hidden = await runCheck(workspace.root, checks[item.id], signal);
          const row = { ...identity, steps, calls: budget.used - callStart, done, error, compactions: events.filter(event => event.type === 'compaction/summary').length, prunes: events.filter(event => event.type === 'compaction/prune').length,
            afterTokens: runtime.measure().totalTokens, changedFiles, hidden, success: done && !error && changedFiles.length > 0 && hidden.ok, finalText };
          rows.push(row); append('scores.jsonl', row);
          append('contexts.jsonl', { ...identity, messages: visibleMessages(runtime.session), compactions: events.filter(event => event.type.startsWith('compaction/')).map(event => event.data.error === undefined ? event : { ...event, data: { ...event.data, error: error ?? 'compaction-failed' } }) });
          onProgress(row);
          await runtime.close();
        }
      }
    }
    manifest.status = rows.some(row => row.error && row.error !== 'step-limit') ? 'completed-with-errors' : 'completed';
  } catch (cause) { manifest.status = 'aborted'; failure = cause; }
  finally {
    manifest.finishedAt = new Date().toISOString(); manifest.callsUsed = budget.used; manifest.completedBranches = rows.length;
    json('manifest.json', manifest); json('summary.json', { groups: summarize(rows, policies), comparisons: paired(rows, policies) });
    writeFileSync(join(output, 'report.md'), markdownReport(manifest, rows));
  }
  if (failure) throw Error(`Continuation eval aborted; partial evidence saved in ${output}`, { cause: failure });
  return { output, manifest, rows, calls };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    dataset: { type: 'string', default: defaultDataset }, policies: { type: 'string', default: defaultPolicies }, cases: { type: 'string' }, model: { type: 'string', default: 'deepseek-flash' }, out: { type: 'string' },
    'context-window': { type: 'string', default: '16384' }, repeats: { type: 'string', default: '1' }, 'max-steps': { type: 'string', default: '8' }, 'max-calls': { type: 'string', default: '200' }, 'timeout-ms': { type: 'string', default: '60000' }, 'base-url': { type: 'string' }, thinking: { type: 'string', default: 'disabled' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log('node eval/continuation/runner.mjs [--dataset file] [--cases id,id] [--policies file] [--model deepseek-flash] [--context-window 16384|1000000] [--max-steps 8] [--max-calls 200] [--timeout-ms 60000] [--out new-directory]'); return; }
  const controller = new AbortController();
  const abort = () => controller.abort(Error('eval-interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const dataset = JSON.parse(readFileSync(values.dataset, 'utf8'));
    if (values.cases) {
      const selected = values.cases.split(',');
      if (selected.some(id => !dataset.cases.some(item => item.id === id)) || new Set(selected).size !== selected.length) throw Error('Unknown or duplicate --cases id');
      dataset.cases = dataset.cases.filter(item => selected.includes(item.id));
    }
    const result = await runContinuationEvaluation({ dataset, policies: JSON.parse(readFileSync(values.policies, 'utf8')), model: values.model, contextWindow: Number(values['context-window']), repeats: Number(values.repeats), maxSteps: Number(values['max-steps']), maxCalls: Number(values['max-calls']), timeoutMs: Number(values['timeout-ms']), output: values.out, apiKey: process.env.DEEPSEEK_API_KEY, baseURL: values['base-url'], thinking: values.thinking, signal: controller.signal,
      onProgress: row => console.log(`${row.case}/${row.policy}: ${row.success ? 'pass' : 'fail'}; summaries=${row.compactions}${row.error ? '; ' + row.error : ''}`) });
    console.log(`Report: ${join(result.output, 'report.md')}`);
    if (result.manifest.status !== 'completed' || result.rows.some(row => !row.success)) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Continuation eval failed. Inspect the latest manifest and partial report under eval/results (or --out).'); process.exitCode = 1; });
