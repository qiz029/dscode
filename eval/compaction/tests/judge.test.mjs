import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateDataset, gradeResponse, probePrompt } from '../fixture.mjs';
import { judgeItems, applyJudgments, semanticGrade, calibrateJudge } from '../judge.mjs';
import { runEvaluation } from '../runner.mjs';
import { OfflineAdapter } from '../adapters.mjs';
import { createRuntime, visibleMessages } from '../runtime.mjs';
import { summarize } from '../report.mjs';

const dataset = JSON.parse(readFileSync(new URL('../fixtures/coding-v2.json', import.meta.url)));
const broadDataset = JSON.parse(readFileSync(new URL('../fixtures/coding-broad-v1.json', import.meta.url)));
const calibration = JSON.parse(readFileSync(new URL('../fixtures/judge-calibration.json', import.meta.url)));
const probe = dataset.cases[1].stages[0].probes.find(probe => probe.id === 'decision');
const signal = () => new AbortController().signal;
const grade = answer => gradeResponse(JSON.stringify({ answers: { decision: answer } }), [probe]);
const verdict = (id, answer, met = true, present = false) => ({ id, required: [{ met, quote: met ? answer : '' }], forbidden: [{ present, quote: present ? answer : '' }], reason: 'Fixture judgment' });

test('v2 evidence must exist before the checkpoint; rubric and evidence never enter answering prompts', () => {
  assert.deepEqual(validateDataset(dataset), dataset);
  const modified = structuredClone(dataset);
  modified.cases[0].stages[0].probes[0].evidence[0].stage = 'checkpoint-5';
  assert.throws(() => validateDataset(modified), /Evidence/);
  const missing = structuredClone(dataset); missing.cases[0].stages[0].probes[0].evidence[0].quote = 'not in source';
  assert.throws(() => validateDataset(missing), /Evidence/);
  const publicPrompt = probePrompt([probe]);
  assert(!publicPrompt.includes('required')); assert(!publicPrompt.includes('evidence')); assert(!publicPrompt.includes('PID-only'));
});

test('broad fixture exercises a real tool-prune boundary while preserving an unpruned control', async () => {
  assert.equal(validateDataset(broadDataset).cases.length, 5);
  const item = broadDataset.cases.find(item => item.id === 'incident-tool-pruning');
  const policies = [{ id: 'full', compact: false }, { id: 'controlled-40', compact: true, thresholdRatio: 0.4, retainRatio: 0.064 }];
  for (const policy of policies) {
    const runtime = createRuntime({ policy, adapter: new OfflineAdapter(16384), provider: 'eval-offline', model: 'test', contextWindow: 16384 });
    try {
      runtime.initialize(item.system);
      for (const stage of item.stages.slice(0, 2)) for (const message of stage.messages) await runtime.append(message, signal());
      const context = JSON.stringify(visibleMessages(runtime.session));
      const prunes = runtime.session.snapshotEvents().filter(event => event.type === 'compaction/prune').length;
      assert.equal(context.includes('rollback-manifest-4827.json'), !policy.compact);
      assert.equal(prunes > 0, policy.compact);
    } finally { await runtime.close(); }
  }
});

test('semantic paraphrases require adjudication; UNKNOWN remains a failed answer', () => {
  const original = grade('Kernel-backed locking.');
  assert.equal(original.passed, 0); assert.equal(original.scores[0].status, 'pending');
  const result = applyJudgments(original, judgeItems(original, [probe]), JSON.stringify({ verdicts: [verdict('decision', 'Kernel-backed locking.')] }));
  assert.equal(result.passed, 1); assert.equal(result.scores[0].status, 'pass');
  assert.equal(grade('UNKNOWN').scores[0].status, 'fail');
  assert.equal(grade('').scores[0].status, 'fail');
});

test('a candidate quote differing only in case remains grounded; an invented quote does not', () => {
  const original = grade('Reuse the existing session store rather than introducing a new one.');
  const items = judgeItems(original, [probe]);
  const sameFact = verdict('decision', 'reuse the existing session store');
  assert.equal(applyJudgments(original, items, JSON.stringify({ verdicts: [sameFact] })).passed, 1);
  const invented = verdict('decision', 'a totally different store');
  assert.equal(applyJudgments(original, items, JSON.stringify({ verdicts: [invented] })).scores[0].status, 'ungraded');
});

test('v2 accepts a literal semantic reference and one fenced JSON block without hiding the format deviation', () => {
  const reference = grade('use kernel locks instead of PID-only ownership');
  assert.equal(reference.passed, 1); assert.equal(reference.scores[0].status, 'pass');
  assert.deepEqual(judgeItems(reference, [probe]), []);
  const fenced = gradeResponse('```json\n{"answers":{"decision":"use kernel locks instead of PID-only ownership"}}\n```', [probe]);
  assert.equal(fenced.format, 'markdown-fence'); assert.equal(fenced.passed, 1); assert.equal(fenced.parseError, null);
  const [summary] = summarize([{ policy: 'full', case: 'one', repeat: 1, beforeTokens: 0, afterTokens: 0, compactions: 0, prunes: 0, error: null, grade: fenced }]);
  assert.equal(summary.formatDeviations, 1);
  const extra = gradeResponse('Intro\n```json\n{"answers":{"decision":"use kernel locks instead of PID-only ownership"}}\n```', [probe]);
  assert.equal(extra.passed, 0); assert.equal(extra.parseError, 'invalid-answer-json');
  const v1 = gradeResponse('```json\n{"answers":{"path":"src/Exact.ts"}}\n```', [{ id: 'path', category: 'artifact', question: 'Which path?', accept: ['src/Exact.ts'] }]);
  assert.equal(v1.passed, 0); assert.equal(v1.parseError, 'invalid-answer-json');
});

test('updated pending-action judgments are not contaminated by unrelated probes quoting old work', () => {
  for (const item of dataset.cases) {
    const oldAction = item.stages[0].probes.find(probe => probe.id === 'next').accept[0];
    for (const stage of item.stages.slice(2)) {
      const current = stage.probes.find(probe => probe.id === 'next');
      assert.notEqual(current.accept[0], oldAction);
      const parsed = gradeResponse(JSON.stringify({ answers: Object.fromEntries(stage.probes.map(probe => [probe.id, probe.id === 'next' ? `The next task is ${probe.accept[0]}` : probe.accept[0]])) }), stage.probes);
      const items = judgeItems(parsed, stage.probes);
      for (const probe of stage.probes) for (const evidence of probe.evidence) assert(!evidence.quote.includes(oldAction));
      assert(items.find(item => item.id === 'next').evidence.some(quote => quote.includes(current.accept[0])));
    }
  }
});

test('wrong facts and contradictions cannot pass merely by containing a correct phrase', () => {
  for (const [answer, met, present] of [['Use PID checks only.', false, true], ['Kernel locks, but use only PID checks for ownership.', true, true]]) {
    const original = grade(answer);
    const result = applyJudgments(original, judgeItems(original, [probe]), JSON.stringify({ verdicts: [verdict('decision', answer, met, present)] }));
    assert.equal(result.passed, 0); assert.equal(result.scores[0].status, 'fail');
  }
});

test('invalid judge JSON, fabricated quotes, duplicate IDs and incomplete checklists are ungraded', () => {
  const original = grade('Kernel locks'); const items = judgeItems(original, [probe]);
  const good = verdict('decision', 'Kernel locks');
  const bads = ['not JSON', JSON.stringify({ verdicts: [{ ...good, required: [{ met: true, quote: 'not in candidate' }] }] }), JSON.stringify({ verdicts: [good, good] }), JSON.stringify({ verdicts: [{ ...good, forbidden: [] }] }), JSON.stringify({ verdicts: [{ ...good, id: 'unknown' }] })];
  for (const text of bads) {
    const result = applyJudgments(original, items, text);
    assert.equal(result.judgeError, 'invalid-judge-response'); assert.equal(result.scores[0].status, 'ungraded'); assert.equal(result.total, 1); assert.equal(result.passed, 0);
  }
});

test('judge outage is an evaluation error and cancellation is propagated', async () => {
  const original = grade('Kernel locks');
  const result = await semanticGrade(original, [probe], async () => { throw Error('transport failed'); }, signal());
  assert.equal(result.judgeError, 'judge-call-failed'); assert.equal(result.scores[0].status, 'ungraded');
  const controller = new AbortController(); controller.abort(Error('stop'));
  await assert.rejects(semanticGrade(original, [probe], async () => { throw controller.signal.reason; }, controller.signal), /stop/);
});

test('merged checklist entries get one format retry with evidence of both attempts', async () => {
  const control = calibration.cases.find(item => item.probe.id === 'pending-positive');
  const original = gradeResponse(JSON.stringify({ answers: { [control.probe.id]: control.answer } }), [control.probe]);
  let calls = 0, evidence;
  const result = await semanticGrade(original, [control.probe], async (_system, prompt) => {
    const request = JSON.parse(prompt);
    assert.equal(request.responseShape.verdicts[0].forbidden.length, 2);
    const judgment = verdict(control.probe.id, control.answer);
    if (calls++) {
      assert.match(request.validationFeedback, /present checklist requires exactly 2/);
      judgment.forbidden.push({ present: false, quote: '' });
    }
    return JSON.stringify({ verdicts: [judgment] });
  }, signal(), value => { evidence = value; });
  assert.equal(calls, 2); assert.equal(result.passed, 1); assert.equal(result.judgeError, undefined);
  assert.equal(evidence.attempts[0].error, 'invalid-judge-response'); assert.equal(evidence.attempts[1].error, null);
  let invalidCalls = 0;
  const invalid = await semanticGrade(original, [control.probe], async () => { invalidCalls++; return '{}'; }, signal());
  assert.equal(invalidCalls, 2); assert.equal(invalid.scores[0].status, 'ungraded');
});

test('a valid failing judgment is never retried to obtain a passing score', async () => {
  let calls = 0;
  const result = await semanticGrade(grade('Use PID checks only.'), [probe], async () => {
    calls++; return JSON.stringify({ verdicts: [verdict('decision', 'Use PID checks only.', false, true)] });
  }, signal());
  assert.equal(calls, 1); assert.equal(result.scores[0].status, 'fail');
});

test('calibration includes positive and negative controls and rejects an always-pass judge', async () => {
  assert(calibration.cases.some(item => item.expected)); assert(calibration.cases.some(item => !item.expected));
  let calls = 0;
  const alwaysPass = async (_system, prompt) => {
    calls++;
    const { items } = JSON.parse(prompt);
    assert(!prompt.includes('"expected"'));
    assert(items.length <= 4);
    return JSON.stringify({ verdicts: items.map(item => ({ id: item.id, required: item.rubric.required.map(() => ({ met: true, quote: item.answer })), forbidden: item.rubric.forbidden.map(() => ({ present: false, quote: '' })), reason: 'always pass' })) });
  };
  const result = await calibrateJudge(calibration.cases, alwaysPass, signal());
  assert.equal(calls, 4); assert.equal(result.evidence.batches.length, 4);
  assert.equal(result.passed, false); assert.equal(result.correct, 7);
});

test('judge request has no history, policy name, prior summaries or tools', async () => {
  const captured = [];
  class Capture extends OfflineAdapter {
    async *stream(options) {
      captured.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const runtime = createRuntime({ policy: { id: 'hidden-policy', compact: false }, adapter: new Capture(16384), provider: 'eval-offline', model: 'test', contextWindow: 16384 });
  try {
    runtime.initialize('HISTORY_CANARY');
    await runtime.judge('isolated judge', 'candidate', signal());
    const text = JSON.stringify(captured);
    assert(!text.includes('HISTORY_CANARY')); assert(!text.includes('hidden-policy')); assert.equal(captured[0].messages.length, 2); assert.equal(captured[0].tools, undefined);
  } finally { await runtime.close(); }
});

test('failed calibration aborts before any candidate session is evaluated', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-judge-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  class InvalidJudge extends OfflineAdapter {
    async *stream() {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '{}' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  await assert.rejects(runEvaluation({ dataset, policies: [{ id: 'full', compact: false }], adapterFactory: () => new InvalidJudge(16384), output: join(root, 'run') }), /aborted/);
  const manifest = JSON.parse(readFileSync(join(root, 'run/manifest.json')));
  assert.equal(manifest.completedCheckpoints, 0); assert.equal(manifest.status, 'aborted'); assert.equal(manifest.grading.calibration.passed, false);
  assert(existsSync(join(root, 'run/judge-calibration.json')));
});
