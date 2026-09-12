import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../plugins/memory/store.mjs';
import { rollout, extraction, consolidation, redact } from '../plugins/memory/content.mjs';
import { runPipeline, defaults } from '../plugins/memory/pipeline.mjs';
import { apply, resolveConfig } from '../plugins/memory/index.mjs';

test('memory rejects fractional counts before work starts, while allowing fractional idle hours', t => {
  for (const key of ['maxPerRun', 'maxCandidates', 'maxInputChars', 'maxConsolidationChars', 'timeoutMs']) {
    for (const value of [1.5, NaN, Infinity, '2', -1, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => resolveConfig({ [key]: value }), new RegExp(`Invalid memory ${key}`));
    }
  }
  assert.equal(resolveConfig({ minIdleHours: 0.5 }).minIdleHours, 0.5);
  const f = fixture(t);
  assert.deepEqual(f.store.candidates(30, resolveConfig({ maxCandidates: 1 }).maxCandidates), []);
  assert.equal(resolveConfig({ maxCandidates: 256 }).maxCandidates, 256);
  assert.throws(() => resolveConfig({ maxCandidates: 257 }), /Invalid memory maxCandidates/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-memory-'));
  const store = new MemoryStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const time = Date.now() - 86400000;
  const header = { id: 'old-session', agentPreset: 'dscode', cwd: '/project', createdAt: time };
  const events = [
    { type: 'user/message', seq: 0, time, data: { source: { kind: 'human' }, content: [{ type: 'text', text: 'Use pnpm for this project.' }] } },
    { type: 'assistant/message', seq: 1, time, data: { message: { content: [{ type: 'reasoning', text: 'SECRET THINKING' }, { type: 'text', text: 'Confirmed pnpm in packageManager.' }] } } },
  ];
  let revision = 'rev1', closes = 0;
  const persistence = { async list() { return [{ header, revision }]; }, async open() { return { async read() { return { events }; }, async close() { closes++; } }; } };
  const calls = [];
  const generate = async (system, input, route, effort) => {
    calls.push({ system, input, effort });
    return input.messages ? { raw_memory: 'Use pnpm.', rollout_summary: 'pnpm confirmed.', evidence: [0, 1] } :
      { summary: 'Project /project uses pnpm.', entries: [{ title: '/project', body: 'Use pnpm.', sources: ['old-session'] }], skills: [] };
  };
  const args = { store, persistence, generate, route: { provider: 'fixture', model: 'fixture' }, config: defaults, signal: new AbortController().signal };
  return { root, store, header, events, calls, args, setRevision: r => { revision = r; }, closes: () => closes };
}

test('two phases persist evidence, reuse unchanged extraction, and repair materialized files', async t => {
  const f = fixture(t);
  assert.deepEqual(await runPipeline(f.args), { extracted: 1, failures: 0, consolidated: true });
  assert.deepEqual(f.calls.map(c => c.effort), ['low', 'high']);
  assert(!JSON.stringify(f.calls).includes('SECRET THINKING'));
  assert.equal(f.closes(), 1);
  assert.match(readFileSync(join(f.root, 'MEMORY.md'), 'utf8'), /source: old-session/);
  rmSync(join(f.root, 'MEMORY.md'));
  assert.equal((await runPipeline(f.args)).unchanged, true);
  assert.equal(f.calls.length, 2);
  assert.match(readFileSync(join(f.root, 'MEMORY.md'), 'utf8'), /pnpm/);
});

test('lease excludes another connection and active, child, or opted-out sessions never extract', async t => {
  const f = fixture(t), other = new MemoryStore(f.root);
  try {
    assert(other.acquire('pipeline', 'other', 60000));
    assert.equal((await runPipeline(f.args)).busy, true);
    other.release('pipeline', 'other');
    f.store.acquire('session:old-session', 'active', 60000);
    await runPipeline(f.args); assert.equal(f.calls.length, 0);
    f.store.release('session:old-session', 'active');
    f.store.enable('old-session', false);
    await runPipeline(f.args); assert.equal(f.calls.length, 0);
    f.store.enable('old-session', true); f.header.origin = 'subagent';
    await runPipeline(f.args); assert.equal(f.calls.length, 0);
  } finally { other.close(); }
});

test('resumed/changed source is not committed, malformed extraction backs off', async t => {
  const f = fixture(t), generate = f.args.generate;
  f.args.generate = async (...args) => { f.setRevision('rev2'); return generate(...args); };
  await runPipeline(f.args);
  assert.equal(f.store.candidates(30, 32).length, 0);
  f.args.generate = async () => ({ raw_memory: 'bad', rollout_summary: '', evidence: [999] });
  assert.equal((await runPipeline(f.args)).failures, 1);
  assert.equal(f.store.pending('old-session', 'rev2'), false);
});

test('clear during consolidation cancels commit and prevents old sessions regenerating', async t => {
  const f = fixture(t), generate = f.args.generate;
  f.args.generate = async (...args) => { const value = await generate(...args); if (!args[1].messages) f.store.clear(); return value; };
  await assert.rejects(runPipeline(f.args), /lease lost/);
  assert.equal(f.store.get('snapshot'), null);
  f.calls.length = 0;
  await runPipeline({ ...f.args, generate });
  assert.equal(f.calls.length, 0);
});

test('filter excludes injected memory and secrets; output requires valid evidence', () => {
  const input = rollout({ id: 'a' }, [{ type: 'user/message', seq: 0, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'injected' }] } }]);
  assert.equal(input.messages.length, 0);
  assert.equal(rollout({ id: 'a' }, [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Native TUI human message' }] } }]).messages.length, 1);
  assert(!redact('api_key=supersecret sk-abcdefghijklmno').includes('supersecret'));
  assert.throws(() => extraction({ raw_memory: 'claim', rollout_summary: '', evidence: [] }, input), /evidence/);
  assert.throws(() => consolidation({ summary: 'x', entries: [{ title: 'x', body: 'x', sources: ['invented'] }], skills: [] }, new Set(['real'])), /source/);
});

test('clear while source revalidation is pending cannot resurrect extracted memory', async t => {
  const f = fixture(t), list = f.args.persistence.list;
  let reads = 0;
  f.args.persistence.list = async () => { const rows = await list(); if (++reads === 2) f.store.clear(); return rows; };
  await assert.rejects(runPipeline(f.args), /lease lost/);
  assert.equal(f.store.candidates(30, 32).length, 0);
});

test('expired memories leave the handbook without re-extracting the same source revision', async t => {
  const f = fixture(t);
  await runPipeline(f.args);
  f.store.db.prepare('UPDATE memories SET used=?,generated=?').run(1, 1);
  const calls = f.calls.length;
  await runPipeline(f.args);
  assert.equal(f.calls.length, calls);
  assert.equal(f.store.get('snapshot').entries.length, 0);
  assert.equal(f.store.candidates(365, 32).length, 0);
});

test('plugin uses independent effort, injects summary, retrieves sources, and honors switches', async t => {
  const f = fixture(t), handlers = new Map(), tools = new Map(), commands = new Map(), sections = [];
  const calls = [];
  const session = { id: 'current', header: { agentPreset: 'dscode' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture', reasoningEffort: 'ultra' } }) };
  const ctx = {
    sessions: { list: () => [session] }, sessionPersistence: f.args.persistence,
    on: (event, callback) => handlers.set(event, callback),
    effect: callback => handlers.set('dispose', callback()),
    systemPrompt: { section: s => sections.push(s) }, tools: { register: tool => tools.set(tool.name, tool) }, commands: { register: c => commands.set(c.name, c) },
    llm: { async *stream(options) {
      calls.push(options);
      const input = JSON.parse(options.messages[0].content[0].text);
      const value = await f.args.generate('', input, {}, options.reasoningEffort);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  };
  apply(ctx, { root: f.root });
  try {
    const command = rawInput => commands.get('memories').handler({ agent: { session }, rawInput });
    await command('run');
    for (let i = 0; i < 100 && !f.store.get('snapshot')?.summary; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(calls.map(c => c.reasoningEffort), ['low', 'high']);
    assert(calls.every(c => c.tools === undefined && c.sessionId === undefined));
    assert.match(sections[0].text({ scope: { session } }), /pnpm/);
    const result = await tools.get('memory_search').execute({ query: 'pnpm' }, { agent: { session } });
    assert.equal(result.evidence[0].session, 'old-session');
    assert.deepEqual(result.evidence[0].sequences, [0, 1]);
    await command('off');
    assert.equal(sections[0].text({ scope: { session } }), '');
    assert.equal((await tools.get('memory_search').execute({ query: 'pnpm' }, { agent: { session } })).disabled, true);
    await command('global-off');
    assert.equal(f.store.get('generate'), false);
  } finally { await handlers.get('dispose')(); }
});
