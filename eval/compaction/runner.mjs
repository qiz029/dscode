import { readFileSync, readdirSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hash, integer, validateDataset, validatePolicies, probePrompt, gradeResponse } from './fixture.mjs';
import { OfflineAdapter, BudgetAdapter, deepseekAdapter } from './adapters.mjs';
import { createRuntime, visibleMessages } from './runtime.mjs';
import { markdownReport, summarize } from './report.mjs';
import { JUDGE_PROTOCOL, semanticGrade, calibrateJudge } from './judge.mjs';

const here = import.meta.dirname;
export async function runEvaluation({ dataset, policies, backend = 'offline', provider, judgeModel, model = backend === 'offline' ? 'scripted-state-fixture' : 'deepseek-flash', contextWindow = 16384, repeats = 1, maxCalls = 200, timeoutMs = 60000, output, apiKey, baseURL, thinking = 'disabled', signal = new AbortController().signal, adapterFactory, onProgress = () => {} }) {
  dataset = validateDataset(dataset); policies = validatePolicies(policies);
  const routedProvider = provider ?? (backend === 'offline' ? 'eval-offline' : 'deepseek-official');
  integer(contextWindow, 'contextWindow', 4096); integer(repeats, 'repeats', 1, 20); integer(maxCalls, 'maxCalls', 1, 10000); integer(timeoutMs, 'timeoutMs', 1, 300000);
  if (!['offline', 'deepseek'].includes(backend)) throw Error('Unknown backend');
  if (typeof model !== 'string' || !model.trim() || !['disabled', 'enabled'].includes(thinking)) throw Error('Invalid model or thinking configuration');
  const hasSemantic = dataset.cases.some(item => item.stages.some(stage => stage.probes.some(probe => probe.grading?.kind === 'semantic')));
  if (hasSemantic && backend === 'offline' && !adapterFactory) throw Error('Semantic fixtures require a live judge; use the synthetic fixture for offline smoke tests');
  const calibration = hasSemantic ? JSON.parse(readFileSync(join(here, 'fixtures/judge-calibration.json'), 'utf8')) : null;
  const makeAdapter = adapterFactory ?? (() => backend === 'offline' ? new OfflineAdapter(contextWindow) : deepseekAdapter({ model, contextWindow, apiKey, baseURL, thinking }));
  // Validate credentials/endpoint before creating an output directory.
  const firstAdapter = makeAdapter();
  output = resolve(output ?? join(here, '../results', new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID().slice(0, 8)));
  mkdirSync(resolve(output, '..'), { recursive: true });
  mkdirSync(output); // Refuse to overwrite or merge an existing run.
  const sourceHashes = Object.fromEntries(readdirSync(here).filter(file => file.endsWith('.mjs')).sort().map(file => [file, hash(readFileSync(join(here, file), 'utf8'))]));
  const dependencyHashes = { 'dscode-compaction-engine': hash(readFileSync(join(here, '../../plugins/compaction/engine.mjs'), 'utf8')), ...Object.fromEntries(['dsh-compaction-basic', 'dsh-compaction-tool-result-pruner', 'dsh-token-meter', 'dsh-llm-deepseek'].map(name => [name, hash(readFileSync(join(here, '../../node_modules/@deepseek-ai', name, 'lib/index.js'), 'utf8'))])) };
  const manifest = {
    version: 1, startedAt: new Date().toISOString(), status: 'running',
    backend, model, thinking, contextWindow, repeats, maxCalls, timeoutMs,
    plannedCheckpoints: repeats * policies.length * dataset.cases.reduce((sum, item) => sum + item.stages.length, 0),
    dataset: { id: dataset.id, hash: hash(dataset) }, policies, sourceHashes, dependencyHashes,
    lockfileHash: hash(readFileSync(join(here, '../../package-lock.json'), 'utf8')),
    node: process.version,
    endpoint: backend === 'deepseek' ? (baseURL ?? 'https://api.deepseek.com') : null,
    design: 'fixed-transcript-replay-and-recall',
    grading: hasSemantic ? { protocol: JUDGE_PROTOCOL, answerProtocol: 'recall-v2-reference-and-fenced-json', judgeModel: judgeModel ?? model, calibrationHash: hash(calibration), blindToPolicy: true } : { protocol: 'exact-v1' },
    modelRevision: 'Requested model id only; provider aliases may change.',
  };
  const rows = [], calls = [], budget = { used: 0, limit: maxCalls };
  const json = (name, value) => writeFileSync(join(output, name), JSON.stringify(value, null, 2) + '\n');
  const append = (name, value) => appendFileSync(join(output, name), JSON.stringify(value) + '\n');
  json('manifest.json', manifest);
  let failure;
  try {
    if (hasSemantic) {
      const runtime = createRuntime({ policy: { compact: false }, adapter: new BudgetAdapter(makeAdapter(), budget, timeoutMs), provider: routedProvider, model, judgeModel, contextWindow, onCall: call => { const record = { phase: 'judge-calibration', ...call }; calls.push(record); append('calls.jsonl', record); } });
      try {
        const result = await calibrateJudge(calibration.cases, runtime.judge, signal);
        json('judge-calibration.json', result);
        manifest.grading.calibration = { passed: result.passed, correct: result.correct, total: result.total };
        console.log(`Judge calibration: ${result.correct}/${result.total}`);
        if (!result.passed) throw Error('judge-calibration-failed');
      } finally { await runtime.close(); }
    }
    for (let repeat = 1; repeat <= repeats; repeat++) for (const item of dataset.cases) {
      // Rotate policy order to reduce systematic timing/cache-order effects.
      const order = policies.map((_, i) => policies[(i + repeat - 1) % policies.length]);
      for (const policy of order) {
        signal.throwIfAborted();
        const identity = { case: item.id, repeat, policy: policy.id };
        let stageId = '';
        const runtime = createRuntime({ policy, adapter: new BudgetAdapter(firstAdapter && budget.used === 0 ? firstAdapter : makeAdapter(), budget, timeoutMs), provider: routedProvider, model, judgeModel, contextWindow, onCall: call => { const record = { ...identity, stage: stageId, ...call }; calls.push(record); append('calls.jsonl', record); } });
        try {
          runtime.initialize(item.system);
          let broken = false;
          for (const stage of item.stages) {
            signal.throwIfAborted(); stageId = stage.id;
            const seq = runtime.session.seq;
            let response = '', error = broken ? 'prior-stage-failed' : null;
            const beforeTokens = runtime.measure().totalTokens;
            try {
              if (!broken) {
                for (const message of stage.messages) await runtime.append(message, signal);
                response = await runtime.answer(probePrompt(stage.probes), signal);
              }
            } catch (cause) {
              if (signal.aborted || budget.used >= budget.limit) throw cause;
              // Persist a bounded code, never raw provider bodies or credentials.
              const knownCodes = ['MAX_TOKENS', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'CONTEXT_WINDOW_EXCEEDED', 'QUOTA_EXCEEDED'];
              error = knownCodes.includes(cause.code) ? cause.code : ['probe-context-overflow', 'incomplete-probe-response'].includes(cause.message) ? cause.message : 'runtime-or-provider-error';
              broken = true;
            }
            const events = runtime.session.snapshotEvents().slice(seq);
            let grade = gradeResponse(response, stage.probes);
            if (!error && grade.parseError) error = grade.parseError;
            if (!error && hasSemantic) {
              grade = await semanticGrade(grade, stage.probes, runtime.judge, signal, evidence => append('judgments.jsonl', { ...identity, stage: stage.id, ...evidence }));
              if (grade.judgeError) error = grade.judgeError;
            }
            const row = { ...identity, stage: stage.id, beforeTokens, afterTokens: runtime.measure().totalTokens, compactions: events.filter(event => event.type === 'compaction/summary').length, prunes: events.filter(event => event.type === 'compaction/prune').length, error, grade };
            rows.push(row); append('scores.jsonl', row);
            // Native failure events include an error chain which can contain
            // provider response bodies. Persist only the bounded failure code.
            const compactions = events.filter(event => event.type.startsWith('compaction/')).map(event => event.data.error === undefined ? event : { ...event, data: { ...event.data, error: error ?? 'compaction-failed' } });
            append('contexts.jsonl', { ...identity, stage: stage.id, messages: visibleMessages(runtime.session), compactions, response });
            onProgress(row);
          }
        } finally { await runtime.close(); }
      }
    }
    manifest.status = rows.some(row => row.error) ? 'completed-with-errors' : 'completed';
  } catch (error) { manifest.status = 'aborted'; failure = error; }
  finally {
    manifest.finishedAt = new Date().toISOString(); manifest.callsUsed = budget.used; manifest.completedCheckpoints = rows.length;
    json('manifest.json', manifest); json('summary.json', summarize(rows));
    writeFileSync(join(output, 'report.md'), markdownReport(manifest, rows, calls));
  }
  if (failure) throw Error(`Eval aborted; partial evidence saved in ${output}`, { cause: failure });
  return { output, manifest, rows, calls };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    backend: { type: 'string', default: 'offline' }, dataset: { type: 'string' }, policies: { type: 'string' }, model: { type: 'string' }, out: { type: 'string' },
    'context-window': { type: 'string', default: '16384' }, repeats: { type: 'string', default: '1' }, 'max-calls': { type: 'string', default: '200' }, 'timeout-ms': { type: 'string', default: '60000' }, 'base-url': { type: 'string' }, thinking: { type: 'string', default: 'disabled' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log('node eval/compaction/runner.mjs [--backend offline|deepseek] [--dataset path] [--policies path] [--context-window 16384] [--repeats 1] [--max-calls 200] [--timeout-ms 60000] [--model deepseek-flash] [--base-url https://api.deepseek.com] [--thinking disabled|enabled] [--out new-directory]'); return; }
  if (!['disabled', 'enabled'].includes(values.thinking)) throw Error('thinking must be disabled or enabled');
  const controller = new AbortController();
  const abort = () => controller.abort(Error('eval-interrupted'));
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const fixtureName = values.backend === 'offline' ? 'synthetic.json' : 'coding-v2.json';
    const result = await runEvaluation({ dataset: JSON.parse(readFileSync(values.dataset ?? join(here, 'fixtures', fixtureName), 'utf8')), policies: JSON.parse(readFileSync(values.policies ?? join(here, 'policies.json'), 'utf8')), backend: values.backend, model: values.model, contextWindow: Number(values['context-window']), repeats: Number(values.repeats), maxCalls: Number(values['max-calls']), timeoutMs: Number(values['timeout-ms']), output: values.out, apiKey: process.env.DEEPSEEK_API_KEY, baseURL: values['base-url'], thinking: values.thinking, signal: controller.signal, onProgress: row => console.log(`${row.case}/${row.policy}/${row.stage}: ${row.grade.passed}/${row.grade.total}; summaries=${row.compactions}${row.error ? '; ' + row.error : ''}`) });
    console.log(`Report: ${join(result.output, 'report.md')}`);
    if (result.manifest.status !== 'completed' || result.rows.some(row => row.grade.passed < row.grade.total)) process.exitCode = 1;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Eval failed. Check input, credentials and the latest manifest/partial report under eval/results (or --out).'); process.exitCode = 1; });
