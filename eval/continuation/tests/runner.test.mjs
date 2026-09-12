import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { OfflineAdapter } from '../../compaction/adapters.mjs';
import { createRuntime } from '../../compaction/runtime.mjs';
import { hash, replayMessages, validateContinuationDataset } from '../fixture.mjs';
import { createWorkspace, runCheck, TOOL_SCHEMAS } from '../workspace.mjs';
import { runContinuationEvaluation } from '../runner.mjs';
import { paired } from '../report.mjs';

const dataset = validateContinuationDataset(JSON.parse(readFileSync(new URL('../fixtures/cases.json', import.meta.url))));
const reference = `export function parseRetryAfter(value, nowMs) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^-?\\d+$/.test(trimmed)) return trimmed.startsWith('-') ? null : Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}
`;
const visibleOnly = `export function parseRetryAfter(value) { return value === '2' ? 2000 : null; }\n`;
const signal = () => new AbortController().signal;
function directory(t) { const root = mkdtempSync(join(tmpdir(), 'dscode-continuation-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

class ScriptAdapter extends LlmAdapter {
  constructor(contextWindow, source, requests) { super(); this.contextWindow = contextWindow; this.source = source; this.requests = requests; this.step = 0; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: this.contextWindow } }; }
  async *stream(options) {
    this.requests.push({ purpose: options.purpose, messages: options.messages, tools: options.tools });
    if (options.purpose === 'compaction') {
      const initial = options.messages.find(message => message.role === 'user')?.content?.[0]?.text ?? '';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `## Primary Request and Intent\n- ${initial}\n## Next Step\n- Finish the task.` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const calls = [
      ['read_file', { path: 'src/retry.mjs' }],
      ['write_file', { path: 'src/retry.mjs', content: this.source }],
      ['run_tests', {}],
    ];
    const call = calls[this.step++];
    if (call) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${this.step}`, name: call[0], arguments: JSON.stringify(call[1]) } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Implemented and tested.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

test('fixture paths and workspace tools keep hidden checks outside the model surface', async t => {
  assert.equal(dataset.cases.length, 3);
  assert.equal(TOOL_SCHEMAS.length, 3);
  const workspace = createWorkspace(join(directory(t), 'branch'), dataset.cases[0]);
  assert.deepEqual(await workspace.execute('read_file', JSON.stringify({ path: '../fixtures/checks/retry-after.mjs' }), signal()), { ok: false, error: 'path-not-readable' });
  assert.deepEqual(await workspace.execute('write_file', JSON.stringify({ path: 'visible.mjs', content: 'pass' }), signal()), { ok: false, error: 'path-or-content-not-writable' });
  assert.equal(workspace.changes().length, 0);
  const million = replayMessages(dataset.cases[1], 1000000);
  assert(million.length > 50);
  assert(million.reduce((sum, message) => sum + message.text.length * (message.repeat ?? 1), 0) > 3200000);
});

test('1M continuation replay reaches the shipped 80% trigger in the native meter', async () => {
  const item = dataset.cases[1];
  const policies = [{ id: 'full', compact: false }, { id: 'shipped-80', compact: true, thresholdRatio: .8, retainRatio: .16 }];
  const measured = [];
  for (const policy of policies) {
    const runtime = createRuntime({ policy, adapter: new OfflineAdapter(1000000), provider: 'eval-offline', model: 'fixture', contextWindow: 1000000, tools: TOOL_SCHEMAS });
    try {
      runtime.initialize(item.system);
      for (const message of replayMessages(item, 1000000)) await runtime.append(message, signal());
      measured.push({ tokens: runtime.measure().totalTokens, summaries: runtime.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length });
    } finally { await runtime.close(); }
  }
  assert(measured[0].tokens > 800000 && measured[0].tokens < 1000000);
  assert.equal(measured[0].summaries, 0);
  assert(measured[1].summaries > 0);
});

test('paired continuation executes edits and hidden checks after native compression', async t => {
  const requests = [];
  const input = { ...dataset, cases: [dataset.cases[0]] };
  const policies = [{ id: 'full', compact: false }, { id: 'controlled-25', compact: true, thresholdRatio: .25, retainRatio: .064 }];
  const result = await runContinuationEvaluation({ dataset: input, policies, backend: 'offline', adapterFactory: () => new ScriptAdapter(16384, reference, requests), output: join(directory(t), 'run') });
  assert.equal(result.manifest.status, 'completed');
  assert.equal(result.manifest.dataset.hash, hash(input));
  assert.equal(result.rows.length, 2);
  assert(result.rows.every(row => row.success && row.changedFiles.includes('src/retry.mjs') && row.hidden.ok), JSON.stringify(result.rows.map(row => ({ policy: row.policy, success: row.success, changedFiles: row.changedFiles, hidden: row.hidden, error: row.error }))));
  assert.equal(result.rows[0].compactions, 0);
  assert(result.rows[1].compactions > 0);
  assert(result.calls.every(call => call.status === 'ok'));
  assert(requests.some(request => request.purpose === 'eval-continuation' && request.tools.length === 3));
  assert(!JSON.stringify(requests).includes('Fri, 01 Jan 2027'));
  assert.match(readFileSync(join(result.output, 'report.md'), 'utf8'), /Tasks passed/);
});

test('visible checks alone do not pass a coding task', async t => {
  const input = { ...dataset, cases: [dataset.cases[0]] };
  const result = await runContinuationEvaluation({ dataset: input, policies: [{ id: 'full', compact: false }], backend: 'offline', adapterFactory: () => new ScriptAdapter(16384, visibleOnly, []), output: join(directory(t), 'run') });
  assert.equal(result.rows[0].error, null);
  assert.equal(result.rows[0].done, true);
  assert.equal(result.rows[0].hidden.ok, false);
  assert.equal(result.rows[0].success, false);
  const trace = readFileSync(join(result.output, 'traces.jsonl'), 'utf8');
  assert(trace.includes('visible checks passed'));
});

test('paired quality excludes provider errors but counts bounded agent failures', () => {
  const policies = [{ id: 'full' }, { id: 'controlled-25' }];
  const rows = [
    { case: 'a', repeat: 1, policy: 'full', success: true, error: null },
    { case: 'a', repeat: 1, policy: 'controlled-25', success: false, error: 'PROVIDER_ERROR' },
    { case: 'b', repeat: 1, policy: 'full', success: true, error: null },
    { case: 'b', repeat: 1, policy: 'controlled-25', success: false, error: 'step-limit' },
  ];
  assert.deepEqual(paired(rows, policies), [{ policy: 'controlled-25', compared: 1, lost: 1, gained: 0, bothFailed: 0, excluded: 1 }]);
});

test('continuation rejects missing credentials before output and keeps budget failures as partial evidence', async t => {
  const root = directory(t);
  const input = { ...dataset, cases: [dataset.cases[0]] };
  const policies = [{ id: 'full', compact: false }];
  const noKey = join(root, 'no-key');
  await assert.rejects(runContinuationEvaluation({ dataset: input, policies, apiKey: '', output: noKey }), /DEEPSEEK_API_KEY/);
  assert(!existsSync(noKey));
  const out = join(root, 'budget');
  await assert.rejects(runContinuationEvaluation({ dataset: input, policies, backend: 'offline', adapterFactory: () => new ScriptAdapter(16384, reference, []), maxCalls: 1, output: out }), /partial evidence/);
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json')));
  assert.equal(manifest.status, 'aborted');
  assert.equal(manifest.callsUsed, 1);
  assert(existsSync(join(out, 'scores.jsonl')));
});

test('test subprocess cannot read files outside its fixture workspace', async t => {
  const workspace = createWorkspace(join(directory(t), 'branch'), dataset.cases[0]);
  await workspace.execute('write_file', JSON.stringify({ path: 'src/retry.mjs', content: `import { readFileSync } from 'node:fs';\nreadFileSync('/etc/hosts');\nexport function parseRetryAfter() { return null; }\n` }), signal());
  const result = await runCheck(workspace.root, join(workspace.root, 'visible.mjs'), signal());
  assert.equal(result.ok, false);
  assert.match(result.stderr, /ERR_ACCESS_DENIED/);
});
