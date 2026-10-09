import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixture } from '../fixture.mjs';
import { actionDenial } from '../host.mjs';
import { parseOptions, runEvaluation, report } from '../runner.mjs';

test('the independent browser oracle requires a correct single submission, observed receipt and retained result', async t => {
  const site = await createFixture('reservation'); t.after(() => site.close());
  const page = await fetch(site.origin + '/').then(r => r.text());
  assert(!page.includes('DS-'), 'receipt cannot be read before completing the task');
  const args = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product: 'atlas-blue', quantity: 2, name: 'Morgan Lee', marketing: false }) };
  const saved = await fetch(site.origin + '/api/submit', args).then(r => r.json());
  const tabs = [{ url: site.origin + '/details?product=atlas-blue', owned: true, kept: true }];
  assert.equal(site.judge('I succeeded', tabs).success, false);
  assert.equal(site.judge(saved.message, []).success, false);
  assert.equal(site.judge(saved.message, tabs).success, true);
  await fetch(site.origin + '/api/submit', args);
  assert.equal(site.judge(saved.message, tabs).success, false);
  assert.equal(site.judge(saved.message, tabs).duplicateSubmissions, 1);
});

test('reference codes vary per case and the oracle rejects archived and wrong values', async t => {
  const a = await createFixture('reference'), b = await createFixture('reference');
  t.after(async () => { await a.close(); await b.close(); });
  const referenceA = await fetch(a.origin + '/reference').then(r => r.text());
  const referenceB = await fetch(b.origin + '/reference').then(r => r.text());
  const codeA = referenceA.match(/Current code: (REF-[a-f0-9]+)/)[1];
  assert(!referenceB.includes(codeA));
  const wrong = await fetch(a.origin + '/api/submit', { method: 'POST', body: JSON.stringify({ code: 'REF-expired' }) });
  assert.equal(wrong.status, 400);
  assert.equal(a.judge('Done', []).correct, false);
});

test('benchmark boundaries reject evaluation, file tools and navigation outside the fixture', () => {
  const origin = 'http://127.0.0.1:23456';
  assert.equal(actionDenial('mcp__browser__new_page', { url: origin + '/' }, origin), undefined);
  assert.equal(actionDenial('mcp__browser__click', { pageId: 1, uid: '2_1' }, origin), undefined);
  for (const [name, args] of [['bash', { command: 'curl x' }], ['mcp__browser__evaluate_script', {}], ['mcp__browser__upload_file', {}], ['mcp__browser__take_snapshot', { filePath: '/tmp/a' }], ['mcp__browser__new_page', { url: 'https://example.com' }], ['mcp__browser__navigate_page', { url: 'javascript:alert(1)' }]]) assert(actionDenial(name, args, origin));
});

test('live eval refuses missing credentials before creating a report; budgets and cases are bounded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'browser-eval-options-')); t.after(() => rm(root, { recursive: true, force: true }));
  const saved = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const options = parseOptions(['--out', join(root, 'missing')]);
    await assert.rejects(runEvaluation(options), /DEEPSEEK_API_KEY/);
    await assert.rejects(access(options.out));
  } finally { if (saved !== undefined) process.env.DEEPSEEK_API_KEY = saved; }
  for (const args of [['--max-calls', '0'], ['--max-tools', 'Infinity'], ['--cases', 'reservation,reservation'], ['--cases', 'unknown'], ['--case-timeout-ms', '0']]) assert.throws(() => parseOptions(args));
});

test('scripted reports cannot claim model quality and partial reports have no numeric score', () => {
  const data = { qualityScore: null, rows: [{ id: 'reservation', success: true, modelCalls: 12, toolCalls: 11, toolErrors: 0, handoffs: 0, elapsedMs: 2000, oracle: { duplicateSubmissions: 0 } }] };
  const text = report({ selfTest: true, status: 'completed' }, data);
  assert.match(text, /no model quality score/); assert(!text.includes('100%'));
  assert.match(report({ selfTest: false, model: 'fixture', status: 'timed-out' }, data), /Quality score: not measured/);
});
