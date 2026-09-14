import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectReviewDiff, parseReviewCommand, reviewSpec, gitWorkspace, isGitWorkspaceSync } from '../plugins/code-review/git.mjs';
import { apply, independentReview } from '../plugins/code-review/index.mjs';
import { patchReview } from '../scripts/patch-review.mjs';

const exec = promisify(execFile);
async function git(cwd, ...args) { return (await exec('git', args, { cwd })).stdout; }

test('review scopes include tracked and untracked changes, and narrow by path', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-'));
  try {
    await git(cwd, 'init', '-q');
    await git(cwd, 'config', 'user.email', 'fixture@example.test');
    await git(cwd, 'config', 'user.name', 'Fixture');
    await writeFile(join(cwd, 'tracked.txt'), 'before\n');
    await git(cwd, 'add', 'tracked.txt');
    await git(cwd, 'commit', '-qm', 'initial');
    await writeFile(join(cwd, 'tracked.txt'), 'after\n');
    await writeFile(join(cwd, 'new.txt'), 'new file\n');
    await writeFile(join(cwd, '.env.local'), 'PRIVATE_EXAMPLE=do-not-send\n');
    const working = await collectReviewDiff(cwd);
    assert.match(working.diff, /\+after/);
    assert.match(working.diff, /new file mode/);
    assert.match(working.diff, /\+new file/);
    assert.deepEqual(working.omitted, ['.env.local']);
    assert.doesNotMatch(working.diff, /do-not-send/);
    assert.doesNotMatch((await collectReviewDiff(cwd, { path: 'tracked.txt' })).diff, /new\.txt/);
    assert.equal((await collectReviewDiff(cwd, { scope: 'staged' })).diff, '');
    await git(cwd, 'add', 'tracked.txt');
    assert.match((await collectReviewDiff(cwd, { scope: 'staged' })).diff, /\+after/);
    await git(cwd, 'commit', '-qm', 'update');
    assert.match((await collectReviewDiff(cwd, { scope: 'commit', ref: 'HEAD' })).diff, /\+after/);
    assert.match((await collectReviewDiff(cwd, { scope: 'base', ref: 'HEAD~1' })).diff, /\+after/);
    assert.doesNotMatch((await collectReviewDiff(cwd, { scope: 'working' })).diff, /tracked\.txt/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('review command rejects unsafe scope and paths', () => {
  assert.deepEqual(parseReviewCommand(''), { scope: 'working', ref: '', path: '' });
  assert.deepEqual(parseReviewCommand('--base main --path src/a.js'), { scope: 'base', ref: 'main', path: 'src/a.js' });
  for (const value of ['--base', '--commit -x', '--path ../secret', '--staged --base main', '--path /tmp/file']) assert.throws(() => parseReviewCommand(value));
  assert.throws(() => reviewSpec('working', '--bad'));
  assert.throws(() => reviewSpec('base', 'main..evil'));
});

test('independent review uses a separate tool-free model request and caches unchanged diff', async () => {
  const calls = [];
  const agent = { options: {}, session: {
    header: { cwd: '/fixture' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test', reasoningEffort: 'ultra' } }),
    snapshotEvents: () => [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the bug.' }] } }],
  } };
  const ctx = { llm: { async *stream(request) {
    calls.push(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No actionable findings in the supplied diff.' } };
    yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 10 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  const collect = async () => ({ scope: 'working', label: 'uncommitted changes', diff: 'diff --git a/a b/a\n+new\n' });
  const first = await independentReview(ctx, agent, {}, undefined, collect);
  assert.equal(first.status, 'reviewed');
  assert.equal(first.usage.inputTokens, 40);
  assert.equal(calls[0].reasoningEffort, 'high');
  assert.equal(calls[0].purpose, 'review');
  assert.equal(calls[0].maxTokens, 8192);
  assert.equal(calls[0].tools, undefined);
  assert.match(JSON.stringify(calls[0].messages), /Fix the bug/);
  const second = await independentReview(ctx, agent, {}, undefined, collect);
  assert.equal(second.cached, true);
  assert.equal(calls.length, 1);
  const none = await independentReview(ctx, agent, {}, undefined, async () => ({ label: 'staged', diff: '' }));
  assert.equal(none.status, 'no_changes');
  assert.equal(calls.length, 1);
});

test('slash review reports findings while partial diffs cannot look clean', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-command-'));
  try {
    await git(cwd, 'init', '-q');
    await writeFile(join(cwd, 'new.txt'), 'hello\n');
    await writeFile(join(cwd, 'asset.bin'), Buffer.from([0, 1, 2]));
    const commands = new Map(), tools = new Map();
    const agent = { status: 'idle', options: {}, session: {
      header: { cwd }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => [],
    } };
    const ctx = {
      commands: { register: value => commands.set(value.name, value) },
      tools: { register: value => tools.set(value.name, value) },
      systemPrompt: { section() {} },
      llm: { async *stream() {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No actionable findings in the supplied diff.' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } },
    };
    apply(ctx);
    const slash = await commands.get('review').handler({ agent, rawInput: '', signal: new AbortController().signal });
    assert.equal(slash.kind, 'success');
    assert.match(slash.text, /Review incomplete: 1 file/);
    const tool = await tools.get('review').execute({}, { agent, signal: new AbortController().signal });
    assert.equal(tool.status, 'partial');
    assert.equal(tool.cached, true);
    agent.status = 'running';
    assert.equal((await commands.get('review').handler({ agent, rawInput: '' })).kind, 'error');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('cancelling a stalled reviewer ends the request instead of reporting a clean result', async () => {
  const controller = new AbortController();
  const agent = { options: {}, session: { header: { cwd: '/fixture' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => [] } };
  const ctx = { llm: { async *stream() { await new Promise(() => {}); yield { type: 'finish', reason: { kind: 'stop' } }; } } };
  const pending = independentReview(ctx, agent, {}, controller.signal, async () => ({ label: 'working', diff: 'diff --git a/a b/a\n+x\n' }));
  setTimeout(() => controller.abort(new Error('cancelled')), 5);
  await assert.rejects(pending, /cancelled/);
});

test('slash review and model tool share the review registration; TUI patch routes command', () => {
  const commands = new Map(), tools = new Map(), sections = [];
  apply({ commands: { register: value => commands.set(value.name, value) }, tools: { register: value => tools.set(value.name, value) }, systemPrompt: { section: value => sections.push(value) }, llm: {} });
  assert(commands.has('review'));
  assert(tools.has('review'));
  assert.match(tools.get('review').description, /before your final answer/);
  assert.match(sections[0].text({ scope: { session: { header: { origin: 'user', agentPreset: 'dscode' } } } }), /After you finish code changes/);
  assert.equal(sections[0].text({ scope: { session: { header: { origin: 'subagent', agentPreset: 'dscode' } } } }), '');
  assert.equal(sections[0].text({}), '');
  const before = 'if (text === "/review" || text.startsWith("/review ")) {\n\t\t\t\treviewChanges(text.slice(7));\n\t\t\t\treturn;\n\t\t\t}';
  const after = patchReview(before);
  assert.match(after, /dispatch\(text\)/);
  assert.equal(patchReview(after), after);
  assert.throws(() => patchReview('unknown upstream'), /Unsupported/);
});

test('review outside a Git repository reports no_repository without a model call and drops the guidance', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-nogit-'));
  try {
    assert.equal(await gitWorkspace(cwd), null);
    assert.equal((await collectReviewDiff(cwd)).repository, null);
    let calls = 0;
    const agent = { options: {}, session: { header: { cwd }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => [] } };
    const result = await independentReview({ llm: { async *stream() { calls++; } } }, agent, {});
    assert.equal(result.status, 'no_repository');
    assert.match(result.report, /not inside a Git repository/);
    assert.equal(calls, 0, 'no reviewer request outside a repository');
    const sections = [];
    apply({ commands: { register() {} }, tools: { register() {} }, systemPrompt: { section: value => sections.push(value) }, llm: {} });
    assert.equal(sections[0].text({ scope: { session: { header: { origin: 'user', agentPreset: 'dscode', cwd } } } }), '');
    assert.match(sections[0].text({ scope: { session: { header: { origin: 'user', agentPreset: 'dscode', cwd: process.cwd() } } } }), /After you finish code changes/);
    assert.equal(isGitWorkspaceSync(join(cwd, 'missing')), false);
    assert.equal(isGitWorkspaceSync(undefined), true);
    let ran = 0;
    assert.equal(isGitWorkspaceSync('/cached/fixture', () => { ran++; return ''; }, 1000), true);
    assert.equal(isGitWorkspaceSync('/cached/fixture', () => { ran++; return ''; }, 2000), true);
    assert.equal(ran, 1, 'the sync check is cached per workspace');
    assert.equal(isGitWorkspaceSync('/cached/fixture', () => { ran++; throw Object.assign(new Error('boom'), { code: 'EACCES' }); }, 100000), false, 'once the cache expires, any git failure drops the guidance');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('review retries once after a non-stop finish, surfaces the provider reason, and marks truncated reports partial', async () => {
  const agent = () => ({ options: {}, session: { header: { cwd: '/fixture' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => [] } });
  const collect = async () => ({ scope: 'working', label: 'uncommitted changes', diff: 'diff --git a/a b/a\n+new\n' });
  const stream = (...outcomes) => { let n = 0; return { llm: { async *stream() {
    const outcome = outcomes[Math.min(n++, outcomes.length - 1)];
    if (outcome.text) { yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: outcome.text } }; }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } };
    if (outcome.finish) yield { type: 'finish', reason: outcome.finish };
  } }, logger: { warn() {} }, calls: () => n }; };
  const overloaded = { finish: { kind: 'error', failure: { message: 'model stopped: insufficient_system_resource', code: 'INSUFFICIENT_SYSTEM_RESOURCE' } } };
  const recovered = stream(overloaded, { text: 'No actionable findings in the supplied diff.', finish: { kind: 'stop' } });
  const ok = await independentReview(recovered, agent(), {}, undefined, collect);
  assert.equal(ok.status, 'reviewed');
  assert.equal(recovered.calls(), 2, 'one automatic retry');
  const stuck = stream(overloaded);
  await assert.rejects(independentReview(stuck, agent(), {}, undefined, collect), /INSUFFICIENT_SYSTEM_RESOURCE.*do not treat it as a clean review/);
  assert.equal(stuck.calls(), 2, 'no endless retries');
  const noFinish = stream({ text: 'partial…' });
  await assert.rejects(independentReview(noFinish, agent(), {}, undefined, collect), /ended without a result/);
  const truncated = stream({ text: 'Finding: null check missing in a.', finish: { kind: 'max-tokens' } });
  const cut = await independentReview(truncated, agent(), {}, undefined, collect);
  assert.equal(cut.status, 'partial');
  assert.match(cut.report, /Finding: null check missing[\s\S]*hit its output limit/);
  assert.equal(truncated.calls(), 1, 'a truncated but usable report is not retried');
  await assert.rejects(independentReview(stream({ finish: { kind: 'max-tokens' } }), agent(), {}, undefined, collect), /ran out of output tokens/);
});

test('review covers a merge commit and the commits a task made when nothing is left uncommitted', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-merge-'));
  try {
    await git(cwd, 'init', '-q', '-b', 'main');
    await git(cwd, 'config', 'user.email', 'fixture@example.test');
    await git(cwd, 'config', 'user.name', 'Fixture');
    await writeFile(join(cwd, 'app.txt'), 'base\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'base');
    // Reflog times are whole seconds: start the task in a later second than the base commit and commit later still.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const since = Date.now();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await git(cwd, 'checkout', '-qb', 'feature');
    await writeFile(join(cwd, 'app.txt'), 'feature change\n');
    await writeFile(join(cwd, 'notes.txt'), 'notes\n');
    await git(cwd, 'add', '.'); await git(cwd, 'commit', '-qm', 'feature');
    await git(cwd, 'checkout', '-q', 'main');
    await git(cwd, 'merge', '-q', '--no-ff', 'feature', '-m', 'merge feature');
    assert.equal((await collectReviewDiff(cwd)).diff, '', 'without a task start the clean tree has nothing to review');
    const task = await collectReviewDiff(cwd, { since });
    assert.match(task.label, /^commits made since this task started \([0-9a-f]{12}\.\.HEAD\)$/);
    assert.match(task.diff, /\+feature change/);
    assert.match(task.diff, /\+notes/);
    assert.doesNotMatch((await collectReviewDiff(cwd, { since, path: 'app.txt' })).diff, /notes/);
    assert.equal((await collectReviewDiff(cwd, { since: Date.now() })).diff, '', 'a task that has not moved HEAD reviews nothing');
    assert.equal((await collectReviewDiff(cwd, { since: 0 })).diff, '', 'a start older than the reflog is not guessed');
    const merge = await collectReviewDiff(cwd, { scope: 'commit', ref: 'HEAD' });
    assert.match(merge.diff, /\+feature change/, 'a clean merge commit is reviewed against its first parent');
    await writeFile(join(cwd, 'app.txt'), 'uncommitted\n');
    assert.match((await collectReviewDiff(cwd, { since })).diff, /\+uncommitted/);
    assert.doesNotMatch((await collectReviewDiff(cwd, { since })).label, /commits made/, 'uncommitted work keeps the working scope');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('the review tool passes the task start, never a caller-supplied one, to the diff collector', async () => {
  const seen = [];
  const agent = { options: {}, session: { id: 's', header: { cwd: '/tmp' }, requestHeader: () => undefined,
    snapshotEvents: () => [{ type: 'user/message', time: 123456, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'task' }] } }] } };
  const collect = async (_cwd, options) => { seen.push(options); return { label: 'uncommitted changes', diff: '', repository: '/tmp' }; };
  const result = await independentReview({}, agent, { scope: 'working', path: 'src', since: 1 }, undefined, collect);
  assert.equal(result.status, 'no_changes');
  assert.deepEqual(seen, [{ scope: 'working', ref: undefined, path: 'src', since: 123456 }]);
});
