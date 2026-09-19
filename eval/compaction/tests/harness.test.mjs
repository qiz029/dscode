import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateDataset, validatePolicies, gradeResponse, probePrompt, hash } from '../fixture.mjs';
import { OfflineAdapter, BudgetAdapter, deepseekAdapter } from '../adapters.mjs';
import { createRuntime, visibleMessages, user } from '../runtime.mjs';
import { runEvaluation, selectBaselineCases } from '../runner.mjs';
import { measureRetention } from '../retention.mjs';
import { summarize } from '../report.mjs';

const dataset = JSON.parse(readFileSync(new URL('../fixtures/synthetic.json', import.meta.url)));
const policies = JSON.parse(readFileSync(new URL('../policies.json', import.meta.url)));
const signal = () => new AbortController().signal;
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-eval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const tiny = () => ({ version: 1, id: 'tiny', cases: [{ id: 'one', system: 'Preserve current work.', stages: [{ id: 'a', messages: [{ role: 'user', text: '<state>{"next":"run tests"}</state>' }], probes: [{ id: 'next', category: 'continuation', question: 'What is next?', accept: ['run tests'] }] }] }] });

test('fixture validation rejects ambiguous identifiers, malformed probes and unsafe expansion', () => {
  assert.deepEqual(validateDataset(dataset), dataset);
  const duplicate = tiny(); duplicate.cases.push(duplicate.cases[0]);
  assert.throws(() => validateDataset(duplicate), /Duplicate case/);
  for (const repeat of [0, 1.5, Infinity, 10001]) {
    const sample = tiny(); sample.cases[0].stages[0].messages[0].repeat = repeat;
    assert.throws(() => validateDataset(sample), /repeat/);
  }
  const malformed = tiny(); malformed.cases[0].stages[0].probes[0].accept = [];
  assert.throws(() => validateDataset(malformed), /Probe/);
  for (const p of [[{ id: 'bad', compact: true, thresholdRatio: .1, retainRatio: .2 }], [policies[0], policies[0]]]) assert.throws(() => validatePolicies(p));
});

test('probe projection excludes gold and grader rejects guessed substrings and invalid JSON', () => {
  const probes = [{ id: 'path', category: 'artifact', question: 'Which path?', accept: ['src/Exact.ts'] }];
  assert(!probePrompt(probes).includes('src/Exact.ts'));
  assert.equal(gradeResponse('{"answers":{"path":" src/Exact.ts "}}', probes).passed, 1);
  assert.equal(gradeResponse('{"answers":{"path":"src/exact.ts"}}', probes).passed, 0);
  assert.equal(gradeResponse('{"answers":{"path":"maybe src/Exact.ts or src/Other.ts"}}', probes).passed, 0);
  for (const text of ['bad JSON', '```json\n{}\n```', '{"answers":[]}', '{"answers":{"path":7}}', '{"answers":{"extra":"x"}}', '{"answers":{}}']) {
    const grade = gradeResponse(text, probes); assert.equal(grade.passed, 0); assert.equal(grade.total, 1);
  }
});

test('real engine matrix preserves corrections over repeated summaries; controls remain visible', async t => {
  const result = await runEvaluation({ dataset, policies, output: join(directory(t), 'run') });
  assert.equal(result.manifest.status, 'completed');
  assert.equal(result.rows.length, 75);
  assert(result.rows.every(row => row.grade.passed === 5));
  const groups = summarize(result.rows);
  assert.equal(groups.find(group => group.policy === 'full').compactions, 0);
  assert.equal(groups.find(group => group.policy === 'shipped-80').compactions, 3);
  assert.equal(groups.find(group => group.policy === 'controlled-80').compactions, 3);
  assert(groups.find(group => group.policy === 'controlled-25').compactions >= 9);
  const evidence = readFileSync(join(result.output, 'contexts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(evidence.every(row => !JSON.stringify(row.messages).includes('What is the next unfinished action?')));
  assert(result.calls.every(call => call.usage === null));
  assert.match(readFileSync(join(result.output, 'report.md'), 'utf8'), /OFFLINE PIPELINE CHECK/);
  assert.equal(result.manifest.dataset.hash, hash(dataset));
  assert.equal(Object.keys(result.manifest.dependencyHashes).length, 5);
  assert(Object.keys(result.manifest.dependencyHashes).includes('dscode-compaction-engine'));
});

test('old constraints and latest corrections survive at least five consecutive summaries', async t => {
  const long = structuredClone(dataset); long.cases = [long.cases[0]];
  const stages = long.cases[0].stages;
  for (let n = 6; n <= 8; n++) {
    const stage = structuredClone(stages[4]); stage.id = `checkpoint-${n}`;
    stage.messages = stage.messages.filter(message => message.role !== 'user');
    stages.push(stage);
  }
  const result = await runEvaluation({ dataset: long, policies: policies.filter(policy => policy.id === 'controlled-25'), output: join(directory(t), 'recurrent') });
  assert(summarize(result.rows)[0].compactions >= 5);
  assert.equal(result.rows.at(-1).grade.passed, 5);
  assert.equal(result.rows.at(-1).grade.scores.find(score => score.id === 'constraint').answer, 'preserve the error code; the message may change');
  assert.equal(result.rows.at(-1).grade.scores.find(score => score.id === 'endpoint').answer, '/api/auth/login');
});

test('compressor requests never receive evaluator-only gold or prior probe questions', async t => {
  const input = structuredClone(dataset); input.cases = [input.cases[0]];
  for (const stage of input.cases[0].stages) for (const probe of stage.probes) probe.accept = ['EVALUATOR_ONLY_CANARY'];
  const requests = [];
  class Capture extends OfflineAdapter {
    async *stream(options) { requests.push(structuredClone({ purpose: options.purpose, messages: options.messages })); yield* super.stream(options); }
  }
  await runEvaluation({ dataset: input, policies: policies.filter(policy => policy.id === 'controlled-25'), adapterFactory: () => new Capture(16384), output: join(directory(t), 'isolation') });
  assert(!JSON.stringify(requests).includes('EVALUATOR_ONLY_CANARY'));
  const summaries = requests.filter(request => request.purpose === 'compaction');
  assert(summaries.length > 0);
  assert(summaries.every(request => !JSON.stringify(request).includes('Which source file was modified?')));
});

test('a truncated native summary fails visibly without replacing the history', async t => {
  class Truncated extends OfflineAdapter {
    async *stream(options) {
      if (options.purpose !== 'compaction') { yield* super.stream(options); return; }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Incomplete checkpoint' } };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    }
  }
  const input = structuredClone(dataset); input.cases = [input.cases[0]];
  const result = await runEvaluation({ dataset: input, policies: policies.filter(policy => policy.id === 'controlled-25'), adapterFactory: () => new Truncated(16384), output: join(directory(t), 'truncated') });
  assert.equal(result.manifest.status, 'completed-with-errors');
  assert.equal(summarize(result.rows)[0].total, 25);
  assert.equal(summarize(result.rows)[0].compactions, 0);
  assert(result.calls.some(call => call.status === 'incomplete'));
  const saved = readFileSync(join(result.output, 'contexts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(saved.every(row => JSON.stringify(row.messages).includes('/api/auth/login')));
});

test('a lossy compressor scores worse without access to gold answers', async t => {
  const root = directory(t);
  const selected = policies.filter(policy => policy.id === 'controlled-25');
  const good = await runEvaluation({ dataset, policies: selected, output: join(root, 'good') });
  const bad = await runEvaluation({ dataset, policies: selected, adapterFactory: () => new OfflineAdapter(16384, { loseState: true }), output: join(root, 'bad') });
  assert(summarize(bad.rows)[0].accuracy < summarize(good.rows)[0].accuracy);
  assert(bad.rows.some(row => row.grade.scores.some(score => !score.passed && score.category === 'constraint')));
});

test('native tool pairs survive boundary selection and pruner runs before summarization', async () => {
  const runtime = createRuntime({ policy: policies.find(p => p.id === 'controlled-25'), adapter: new OfflineAdapter(16384), provider: 'eval-offline', model: 'fixture', contextWindow: 16384 });
  try {
    runtime.initialize('Keep working.');
    await runtime.append({ role: 'tool', name: 'read_file', text: 'Old log. '.repeat(3000) }, signal());
    await runtime.append({ role: 'user', text: 'Continue.' }, signal());
    const events = runtime.session.snapshotEvents();
    assert(events.some(event => event.type === 'compaction/prune'));
    assert(!events.some(event => event.type === 'compaction/summary'));
    const messages = visibleMessages(runtime.session);
    const calls = messages.flatMap(message => message.content.filter(block => block.type === 'tool-call'));
    const results = messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'));
    assert.deepEqual(calls.map(call => call.id), results.map(result => result.toolCallId));
    assert(runtime.measure().totalTokens < 4096);
  } finally { await runtime.close(); }
});

test('unchanged replay is deterministic and output folders cannot overwrite earlier evidence', async t => {
  const root = directory(t);
  const first = await runEvaluation({ dataset: tiny(), policies: [policies[0]], output: join(root, 'a') });
  const second = await runEvaluation({ dataset: tiny(), policies: [policies[0]], output: join(root, 'b') });
  assert.deepEqual(first.rows, second.rows);
  await assert.rejects(runEvaluation({ dataset: tiny(), policies: [policies[0]], output: join(root, 'a') }), /EEXIST/);
  assert.equal(first.manifest.dataset.hash, second.manifest.dataset.hash);
});

test('call budget exhaustion keeps partial evidence and records an aborted run', async t => {
  const out = join(directory(t), 'budget');
  await assert.rejects(runEvaluation({ dataset, policies: [policies[0]], maxCalls: 1, output: out }), /partial evidence/);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json')));
  assert.equal(manifest.status, 'aborted'); assert.equal(manifest.callsUsed, 1);
  assert.equal(manifest.completedCheckpoints, 1);
  assert(existsSync(join(out, 'report.md')));
});

test('overflow and malformed responses are counted as failed probes, not dropped trials', async t => {
  const root = directory(t);
  const big = tiny(); big.cases[0].stages[0].messages.push({ role: 'assistant', text: 'Irrelevant old history. '.repeat(2000) });
  const overflow = await runEvaluation({ dataset: big, policies: [policies[0]], contextWindow: 4096, output: join(root, 'overflow') });
  assert.equal(overflow.rows[0].error, 'probe-context-overflow'); assert.equal(overflow.rows[0].grade.passed, 0); assert.equal(overflow.rows[0].grade.total, 1);
  class BadAnswer extends OfflineAdapter {
    async *stream() { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: 'not json' } }; yield { type: 'finish', reason: { kind: 'stop' } }; }
  }
  const invalid = await runEvaluation({ dataset: tiny(), policies: [policies[0]], adapterFactory: () => new BadAnswer(16384), output: join(root, 'invalid') });
  assert.equal(invalid.manifest.status, 'completed-with-errors'); assert.equal(invalid.rows[0].grade.total, 1);
});

test('missing credentials and unsafe endpoints fail before creating live-run artifacts', async t => {
  const out = join(directory(t), 'live');
  await assert.rejects(runEvaluation({ dataset: tiny(), policies: [policies[0]], backend: 'deepseek', apiKey: '', output: out }), /DEEPSEEK_API_KEY/);
  assert(!existsSync(out));
  for (const baseURL of ['http://example.org', 'https://user:secret@example.org', 'https://example.org?key=x']) assert.throws(() => deepseekAdapter({ model: 'deepseek-flash', contextWindow: 16384, apiKey: 'placeholder', baseURL }), /Endpoint/);
});

test('official DeepSeek SSE adapter records usage and sends no gold or credentials into artifacts', async t => {
  const oldFetch = globalThis.fetch, requests = [];
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const chunks = [
      { id: 'mock', choices: [{ index: 0, delta: { content: '{"answers":{"next":"run tests"}}' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 300, completion_tokens: 20, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 200 } },
    ];
    return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const result = await runEvaluation({ dataset: tiny(), policies: [policies[0]], backend: 'deepseek', apiKey: 'test-only-secret', output: join(directory(t), 'wire') });
  assert.equal(result.rows[0].grade.passed, 1); assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'deepseek-flash'); assert.equal(requests[0].thinking.type, 'disabled');
  assert.equal(result.calls[0].usage.inputTokens, 200); assert.equal(result.calls[0].usage.cacheReadTokens, 100);
  for (const file of ['manifest.json', 'calls.jsonl', 'contexts.jsonl', 'scores.jsonl']) assert(!readFileSync(join(result.output, file), 'utf8').includes('test-only-secret'));
  assert(!JSON.stringify(requests).includes('"accept"'));
});

test('adapter deadline aborts an outstanding request', async () => {
  class Slow extends OfflineAdapter {
    async *stream(options) { await new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('deadline did not abort')), 1000); options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true }); }); }
  }
  const bounded = new BudgetAdapter(new Slow(16384), { used: 0, limit: 1 }, 10);
  await assert.rejects(async () => { for await (const _ of bounded.stream({ messages: [], signal: signal() })) {} }, /timeout/i);
});

test('adapter deadline returns even if a provider never observes the abort signal', async () => {
  class IgnoringAbort extends OfflineAdapter {
    async *stream() { await new Promise(() => {}); }
  }
  const bounded = new BudgetAdapter(new IgnoringAbort(16384), { used: 0, limit: 1 }, 10);
  const started = performance.now();
  await assert.rejects(async () => { for await (const _ of bounded.stream({ messages: [], signal: signal() })) {} }, /eval-call-timeout/);
  assert(performance.now() - started < 2000);
});

test('CLI help is offline and rejects unknown flags', () => {
  const entry = new URL('../runner.mjs', import.meta.url).pathname;
  const help = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /--backend offline\|deepseek/);
  const invalid = spawnSync(process.execPath, [entry, '--surprise'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
});

test('a prefetch summarizes early and commits at the threshold without a second summary', async t => {
  const contextWindow = 1000;
  const runtime = createRuntime({ policy: { compact: true, thresholdRatio: 0.8, retainRatio: 0.16 }, adapter: new OfflineAdapter(contextWindow), provider: 'offline', model: 'offline-1', contextWindow });
  t.after(() => runtime.close());
  runtime.initialize('Preserve the running checklist.');
  const events = type => [...Array(runtime.session.seq).keys()].filter(seq => runtime.session.eventAt(seq)?.type === type).length;
  const summaries = () => runtime.calls.filter(call => call.purpose === 'compaction').length;
  let turn = 0;
  const appendTurn = text => {
    turn += 1;
    runtime.session.append('turn/start', { turn });
    runtime.session.append('user/message', user(text), { surfaceOp: 'append' });
    runtime.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  };
  for (let n = 0; n < 200 && runtime.measure().totalTokens < 720; n += 1) appendTurn(`stage ${n} ` + 'x'.repeat(160));
  assert(runtime.measure().totalTokens >= 700 && runtime.measure().totalTokens < 800, 'the prefetch mark (70%) is due below the threshold (80%)');
  runtime.engine.dscodePlanPrefetch(runtime.agent, runtime.measure(), { thresholdTokens: 800, retainTokens: 160, contextWindow }, signal());
  const prefetch = runtime.engine.dscodePrefetch.get(runtime.session);
  assert(prefetch !== undefined, 'crossing the mark starts a background prefetch');
  assert.equal(events('compaction/start'), 0, 'the prefetch appends nothing before the threshold');
  await prefetch.wait;
  assert.equal(summaries(), 1, 'the prefetch summarizes in the background');
  assert.equal(events('compaction/start'), 0, 'the finished prefetch still appends nothing');
  for (let n = 0; n < 200 && runtime.measure().totalTokens < 810; n += 1) appendTurn(`later ${n} ` + 'y'.repeat(160));
  appendTurn('the freshest fact survives verbatim');
  assert(runtime.measure().totalTokens >= 800, 'the threshold is due');
  // Automatic compaction is triggered from a pre-step hook, so the commit is
  // exercised the way the agent calls it: inside an open turn.
  turn += 1;
  runtime.session.append('turn/start', { turn });
  const result = await runtime.engine.compactIfNeeded(runtime.agent, 'pressure', signal());
  runtime.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  assert(result !== null, 'the pressure path commits the prefetch');
  assert.equal(summaries(), 1, 'the commit reuses the prefetched summary instead of summarizing again');
  assert.equal(events('compaction/start'), 1);
  assert.equal(events('compaction/end'), 1);
  const visible = visibleMessages(runtime.session).map(message => JSON.stringify(message)).join('\n');
  assert(visible.includes('the freshest fact survives verbatim'), 'content appended past the prefetched span stays verbatim behind the checkpoint');
  assert(!visible.includes('stage 0 '), 'the prefetched prefix is replaced by its summary');
});

test('a threshold that arrives mid-prefetch waits under the compaction indicator', async t => {
  const contextWindow = 1000;
  class Gated extends OfflineAdapter {
    constructor(window) { super(window); this.gate = Promise.withResolvers(); this.compactions = 0; }
    async *stream(options) {
      if (options.purpose === 'compaction') { this.compactions += 1; await this.gate.promise; }
      yield* super.stream(options);
    }
  }
  const adapter = new Gated(contextWindow);
  const runtime = createRuntime({ policy: { compact: true, thresholdRatio: 0.8, retainRatio: 0.16 }, adapter, provider: 'offline', model: 'offline-1', contextWindow });
  t.after(() => runtime.close());
  runtime.initialize('Preserve the running checklist.');
  const events = type => [...Array(runtime.session.seq).keys()].filter(seq => runtime.session.eventAt(seq)?.type === type).length;
  let turn = 0;
  const appendTurn = text => {
    turn += 1;
    runtime.session.append('turn/start', { turn });
    runtime.session.append('user/message', user(text), { surfaceOp: 'append' });
    runtime.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  };
  for (let n = 0; n < 200 && runtime.measure().totalTokens < 720; n += 1) appendTurn(`stage ${n} ` + 'x'.repeat(160));
  runtime.engine.dscodePlanPrefetch(runtime.agent, runtime.measure(), { thresholdTokens: 800, retainTokens: 160, contextWindow }, signal());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.compactions, 1, 'the prefetch summarizes in the background');
  for (let n = 0; n < 200 && runtime.measure().totalTokens < 810; n += 1) appendTurn(`later ${n} ` + 'y'.repeat(160));
  turn += 1;
  runtime.session.append('turn/start', { turn });
  const compaction = runtime.engine.compactIfNeeded(runtime.agent, 'pressure', signal());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events('compaction/start'), 1, 'the wait opens the ordinary compaction indicator');
  assert.equal(events('compaction/end'), 0, 'the wait is still pending');
  assert.equal(adapter.compactions, 1, 'the wait does not summarize a second time');
  adapter.gate.resolve();
  const result = await compaction;
  runtime.session.append('turn/end', { turn, reason: { kind: 'completed' } });
  assert(result !== null, 'the commit resolves once the prefetch finishes');
  assert.equal(events('compaction/end'), 1);
  assert.equal(adapter.compactions, 1);
});

test('retention counts verdict-free evidence survival in the probe context', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'I met Sophia at a coffee shop in the city.' }] }];
  const probes = [{ id: 'where', category: 'recall', question: 'Where?', accept: ['a coffee shop'], evidence: [{ stage: 'checkpoint', message: 0, quote: 'a coffee shop in the city' }] }];
  const kept = measureRetention(messages, probes);
  assert.deepEqual([kept.quotes, kept.retained, kept.quoteRatio], [1, 1, 1]);
  const lost = measureRetention([{ role: 'user', content: [{ type: 'text', text: 'Earlier work has been summarized.' }] }], probes);
  assert.deepEqual([lost.quotes, lost.retained, lost.termRatio], [1, 0, 0]);
  // A file name that only survives inside a longer identifier is not retained;
  // the looser term ratio may still credit the shared word.
  const partial = measureRetention([{ role: 'user', content: [{ type: 'text', text: 'See login.tsx for details.' }] }], [{ id: 'f', category: 'artifact', question: 'Which file?', accept: ['login.ts'], evidence: [{ stage: 'checkpoint', message: 0, quote: 'login.ts' }] }]);
  assert.equal(partial.retained, 0);
  assert.equal(measureRetention(messages, [{ id: 'none', category: 'recall', question: 'q', accept: ['a'] }]), null);
});

test('retention detects evidence the native compressor summarized away', async () => {
  const probes = [{ id: 'where', category: 'recall', question: 'Where did I meet Sophia?', accept: ['a coffee shop in the city'], evidence: [{ stage: 'checkpoint', message: 0, quote: 'I met Sophia at a coffee shop in the city' }] }];
  const observe = async policy => {
    const runtime = createRuntime({ policy, adapter: new OfflineAdapter(16384), provider: 'eval-offline', model: 'fixture', contextWindow: 16384 });
    try {
      runtime.initialize('Answer from history only.');
      await runtime.append({ role: 'user', text: 'I met Sophia at a coffee shop in the city.' }, signal());
      for (let n = 0; n < 16; n++) await runtime.append({ role: 'user', text: 'Filler session about unrelated topics. '.repeat(60) }, signal());
      return { compacted: runtime.session.snapshotEvents().some(event => event.type === 'compaction/summary'), retention: measureRetention(visibleMessages(runtime.session), probes) };
    } finally { await runtime.close(); }
  };
  const kept = await observe(policies.find(item => item.id === 'full'));
  const lost = await observe(policies.find(item => item.id === 'controlled-25'));
  assert.equal(kept.compacted, false); assert.equal(lost.compacted, true);
  assert.deepEqual([kept.retention.quotes, kept.retention.retained], [1, 1]);
  assert.deepEqual([lost.retention.quotes, lost.retention.retained], [1, 0]);
  assert(lost.retention.termRatio < kept.retention.termRatio);
});
test('one protocol retry recovers a malformed probe reply without entering the history', async t => {
  let replies = 0;
  class Flaky extends OfflineAdapter {
    async *stream(options) {
      if (options.purpose !== 'compaction' && ++replies === 1) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'I would say run tests.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      yield* super.stream(options);
    }
  }
  const result = await runEvaluation({ dataset: tiny(), policies: [policies[0]], adapterFactory: () => new Flaky(16384), output: join(directory(t), 'retry') });
  assert.equal(result.rows[0].answerRetries, 1);
  assert.equal(result.rows[0].grade.passed, 1);
  assert.equal(result.manifest.status, 'completed');
  assert.equal(result.rows[0].retention, null);
  const saved = readFileSync(join(result.output, 'contexts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(saved[0].response, '{"answers":{"next":"run tests"}}');
  assert(!JSON.stringify(saved[0].messages).includes('I would say run tests.'));
});

test('baseline selection keeps only cases the full-context policy answered completely', t => {
  const file = join(directory(t), 'scores.jsonl');
  const line = (item, policy, passed, total, error = null, repeat = 1) => JSON.stringify({ case: item, repeat, policy, stage: 'checkpoint', error, grade: { passed, total }, compactions: 0, prunes: 0 });
  writeFileSync(file, [
    line('keep', 'full', 1, 1),
    line('keep', 'compact-80', 0, 1),
    line('drop', 'full', 0, 1),
    line('errored', 'full', 0, 1, 'invalid-answer-json'),
    line('missing', 'compact-80', 1, 1),
    line('flaky-repeat', 'full', 1, 1, null, 1),
    line('flaky-repeat', 'full', 0, 1, null, 2),
  ].join('\n') + '\n');
  const dataset = { version: 2, id: 'selection', cases: [{ id: 'keep' }, { id: 'drop' }, { id: 'errored' }, { id: 'missing' }, { id: 'flaky-repeat' }] };
  const picked = selectBaselineCases(dataset, file);
  assert.deepEqual(picked.dataset.cases.map(item => item.id), ['keep']);
  assert.deepEqual(picked.selection, { source: file, policy: 'full', selected: 1, total: 5 });
  assert.throws(() => selectBaselineCases(dataset, file, 'compact-90'), /passes every probe/);
});

test('a summary instruction variant changes only the compaction request', async t => {
  const requests = [];
  class Capture extends OfflineAdapter {
    async *stream(options) { requests.push(structuredClone({ purpose: options.purpose, messages: options.messages })); yield* super.stream(options); }
  }
  const variant = { id: 'keepfacts', compact: true, thresholdRatio: 0.25, retainRatio: 0.064, summaryInstruction: 'PRESERVE_QUOTABLE_FACTS_CANARY' };
  const input = structuredClone(dataset); input.cases = [input.cases[0]];
  const result = await runEvaluation({ dataset: input, policies: [variant], adapterFactory: () => new Capture(16384), output: join(directory(t), 'summary-instruction') });
  assert(summarize(result.rows)[0].compactions > 0);
  const summaries = requests.filter(request => request.purpose === 'compaction');
  assert(summaries.length > 0);
  assert(summaries.every(request => JSON.stringify(request).includes('PRESERVE_QUOTABLE_FACTS_CANARY')));
  assert(requests.filter(request => request.purpose !== 'compaction').every(request => !JSON.stringify(request).includes('PRESERVE_QUOTABLE_FACTS_CANARY')));
  assert.throws(() => validatePolicies([{ ...variant, summaryInstruction: '' }]), /summaryInstruction/);
});
