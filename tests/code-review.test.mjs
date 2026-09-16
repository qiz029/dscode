import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectReviewDiff, parseReviewCommand, reviewSpec, untracked, gitWorkspace, isGitAvailableSync, isGitWorkspaceSync } from '../plugins/code-review/git.mjs';
import { baselineStore } from '../plugins/code-review/baseline.mjs';
import { apply, describeAttempt, independentReview, reviewRoute, REVIEW_LIMITS } from '../plugins/code-review/index.mjs';
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
  assert.equal(calls[0].reasoningEffort, 'minimal', 'the reviewer starts at the lightest level');
  assert.equal(calls[0].purpose, 'review');
  assert.equal(calls[0].maxTokens, 32768, 'review budget leaves room for reasoning plus the report');
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
      on() {},
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
  // Cancellation during startup must settle too, without depending on a wall-clock timer.
  queueMicrotask(() => controller.abort(new Error('cancelled')));
  await assert.rejects(pending, /cancelled/);
});

test('slash review and model tool share the review registration; TUI patch routes command', () => {
  const commands = new Map(), tools = new Map(), sections = [];
  apply({ on() {}, commands: { register: value => commands.set(value.name, value) }, tools: { register: value => tools.set(value.name, value) }, systemPrompt: { section: value => sections.push(value) }, llm: {} });
  assert(commands.has('review'));
  assert(tools.has('review'));
  assert.match(tools.get('review').description, /before your final answer/);
  assert.match(sections[0].text({ scope: { session: { header: { origin: 'user', agentPreset: 'dscode' } } } }), /After you finish code changes/);
  assert.equal(sections[0].text({ scope: { session: { header: { origin: 'subagent', agentPreset: 'dscode' } } } }), '');
  assert.equal(sections[0].text({}), '');
  const before = 'if (text === "/review" || text.startsWith("/review ")) {\n\t\t\t\tconst argument = text.slice(7).trim();\n\t\t\t\tif (argument === "") {\n\t\t\t\t\topenReviewPicker();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t\ttry {\n\t\t\t\t\treviewChanges(parseReviewArgument(argument));\n\t\t\t\t} catch (error) {\n\t\t\t\t\tnotify(error instanceof Error ? error.message : String(error), "warning");\n\t\t\t\t}\n\t\t\t\treturn;\n\t\t\t}';
  const after = patchReview(before);
  assert.match(after, /dispatch\(text\)/);
  assert.equal(patchReview(after), after);
  assert.throws(() => patchReview('unknown upstream'), /Unsupported/);
});

test('outside a Git repository the guidance points at the snapshot review, and review without a baseline store reports no_repository', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-nogit-'));
  try {
    assert.equal(await gitWorkspace(cwd), null);
    assert.equal((await collectReviewDiff(cwd)).repository, null);
    let calls = 0;
    const agent = { options: {}, session: { header: { cwd }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => [] } };
    const result = await independentReview({ llm: { async *stream() { calls++; } } }, agent, {});
    assert.equal(result.status, 'no_repository');
    assert.match(result.report, /not inside a Git repository/);
    assert.equal(calls, 0, 'no reviewer request without a baseline store');
    const sections = [];
    apply({ on() {}, commands: { register() {} }, tools: { register() {} }, systemPrompt: { section: value => sections.push(value) }, llm: {} });
    assert.match(sections[0].text({ scope: { session: { header: { origin: 'user', agentPreset: 'dscode', cwd } } } }), /not a Git repository[\s\S]*changed since the task started/);
    assert.equal(sections[0].text({ scope: { session: { header: { origin: 'subagent', agentPreset: 'dscode', cwd } } } }), '');
    assert.match(sections[0].text({ scope: { session: { header: { origin: 'user', agentPreset: 'dscode', cwd: process.cwd() } } } }), /commits made since the task started/);
    assert.equal(isGitAvailableSync(() => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); }), false, 'without git there is no snapshot to review');
    assert.equal(isGitAvailableSync(() => ''), true);
    assert.equal(isGitWorkspaceSync(join(cwd, 'missing')), false);
    assert.equal(isGitWorkspaceSync(undefined), true);
    let ran = 0;
    assert.equal(isGitWorkspaceSync('/cached/fixture', () => { ran++; return ''; }, 1000), true);
    assert.equal(isGitWorkspaceSync('/cached/fixture', () => { ran++; return ''; }, 2000), true);
    assert.equal(ran, 1, 'the sync check is cached per workspace');
    assert.equal(isGitWorkspaceSync('/cached/fixture', () => { ran++; throw Object.assign(new Error('boom'), { code: 'EACCES' }); }, 100000), false, 'once the cache expires, any git failure drops the guidance');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a workspace snapshot diffs the task baseline, leaving out ignored, sensitive and large files', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-snapshot-'));
  const root = await mkdtemp(join(tmpdir(), 'dscode-review-baselines-'));
  const limits = { files: 50, bytes: 1024 * 1024, fileBytes: 256 };
  try {
    await mkdir(join(cwd, 'node_modules'));
    await writeFile(join(cwd, 'app.py'), 'print("base")\n');
    await writeFile(join(cwd, 'node_modules', 'dep.js'), 'base\n');
    await writeFile(join(cwd, '.env'), 'TOKEN=base\n');
    const store = baselineStore(root, limits);
    const task = { session: 'session-1', seq: 4 };
    assert.equal((await store.collect(cwd, task)).baseline, 'missing', 'no baseline before the first tool call');
    const first = await store.capture(cwd, task);
    assert.match(first.tree, /^[0-9a-f]{40,64}$/);
    assert.equal(await store.capture(cwd, task), first, 'a task takes its baseline once');
    assert.equal((await store.collect(cwd, task)).diff, '', 'an untouched workspace has nothing to review');
    await writeFile(join(cwd, 'app.py'), 'print("changed")\n');
    await writeFile(join(cwd, 'notes.md'), 'new notes\n');
    await writeFile(join(cwd, 'node_modules', 'dep.js'), 'changed\n');
    await writeFile(join(cwd, '.env'), 'TOKEN=changed\n');
    await writeFile(join(cwd, 'data.bin'), 'x'.repeat(1024));
    const changed = await store.collect(cwd, task);
    assert.equal(changed.label, 'files changed since this task started (workspace snapshot)');
    assert.match(changed.diff, /\+print\("changed"\)/);
    assert.match(changed.diff, /\+new notes/);
    assert.doesNotMatch(changed.diff, /node_modules|\.env|TOKEN|data\.bin/);
    assert.doesNotMatch((await store.collect(cwd, task, { path: 'app.py' })).diff, /notes/);
    await assert.rejects(store.collect(cwd, task, { scope: 'staged' }), /needs a Git repository/);
    const resumed = baselineStore(root, limits);
    assert.match((await resumed.collect(cwd, task)).diff, /\+print\("changed"\)/, 'the baseline is a ref, so it survives a restart');
    await resumed.capture(cwd, { session: 'session-1', seq: 9 });
    assert.equal((await resumed.collect(cwd, task)).baseline, 'missing', 'a new task replaces the session baseline');
    assert.equal((await resumed.collect(cwd, { session: 'session-1', seq: 9 })).diff, '');
    assert.deepEqual(await baselineStore(root, { ...limits, files: 2 }).capture(cwd, { session: 'session-2', seq: 1 }), { skipped: 'more than 2 files' });
  } finally { await Promise.all([rm(cwd, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]); }
});

test('outside Git the first tool call of a task takes the baseline that the review tool diffs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-hook-'));
  const root = await mkdtemp(join(tmpdir(), 'dscode-review-baselines-'));
  try {
    await writeFile(join(cwd, 'main.c'), 'int main() { return 0; }\n');
    const hooks = {}, tools = new Map(), requests = [];
    const llm = { async *stream(options) {
      requests.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'No actionable findings in the supplied diff.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
    apply({ on: (name, fn) => { hooks[name] = fn; }, commands: { register() {} }, tools: { register: value => tools.set(value.name, value) }, systemPrompt: { section() {} }, llm }, { baselineRoot: root });
    const events = [{ seq: 3, type: 'user/message', time: Date.now(), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Make main fail' }] } }];
    const agent = { options: {}, session: { id: 'hook-session', header: { cwd, agentPreset: 'dscode', origin: 'user' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => events } };
    assert.equal((await hooks['tools/pre-execute']({ name: 'bash', agent }, async () => ({ kind: 'allow' }))).kind, 'allow');
    await writeFile(join(cwd, 'main.c'), 'int main() { return 1; }\n');
    const result = await tools.get('review').execute({}, { agent, signal: new AbortController().signal });
    assert.equal(result.status, 'reviewed');
    assert.match(result.scope, /workspace snapshot/);
    assert.match(JSON.stringify(requests[0].messages), /\+int main\(\) \{ return 1; \}/);
    const tooLarge = { collect: async () => ({ diff: '', omitted: [], label: 'files changed since this task started (workspace snapshot)', baseline: 'too_large', reason: 'more than 2 files' }) };
    const skipped = await independentReview({}, agent, {}, undefined, async () => ({ diff: '', label: 'uncommitted changes', repository: null }), tooLarge);
    assert.equal(skipped.status, 'no_baseline');
    assert.match(skipped.report, /too large to snapshot \(more than 2 files\)[\s\S]*Do not call review again/);
  } finally { await Promise.all([rm(cwd, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]); }
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
  const failed = await independentReview(stuck, agent(), {}, undefined, collect);
  assert.equal(failed.status, 'error');
  assert.match(failed.error, /INSUFFICIENT_SYSTEM_RESOURCE.*do not treat it as a clean review/);
  assert.equal(stuck.calls(), 2, 'no endless retries');
  const noFinish = stream({ text: 'partial…' });
  assert.match((await independentReview(noFinish, agent(), {}, undefined, collect)).error, /ended without a result/);
  const truncated = stream({ text: 'Finding: null check missing in a.', finish: { kind: 'max-tokens' } });
  const cut = await independentReview(truncated, agent(), {}, undefined, collect);
  assert.equal(cut.status, 'partial');
  assert.match(cut.report, /Finding: null check missing[\s\S]*hit its output limit/);
  assert.equal(truncated.calls(), 1, 'a truncated but usable report is not retried');
  process.env.DSCODE_REVIEW_RETRY_MS = '0';
  try {
    const burned = stream({ finish: { kind: 'max-tokens' } }, { text: 'No actionable findings in the supplied diff.', finish: { kind: 'stop' } });
    const recoveredReport = await independentReview(burned, agent(), {}, undefined, collect);
    assert.equal(recoveredReport.status, 'reviewed', 'an empty truncated attempt retries instead of reporting a dead review');
    assert.equal(burned.calls(), 2, 'one retry with a larger budget');
    const starved = stream({ finish: { kind: 'max-tokens' } });
    assert.match((await independentReview(starved, agent(), {}, undefined, collect)).error, /ran out of output tokens before writing the report/);
  } finally { delete process.env.DSCODE_REVIEW_RETRY_MS; }
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


test('automatic review converges across changed paths, persists on resume and resets for a new user task', async () => {
  const events = [{ type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the bug' }] } }];
  const makeAgent = () => ({ options: {}, session: { id: 'bounded', header: { cwd: '/fixture' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test', reasoningEffort: 'ultra' } }), snapshotEvents: () => events } });
  const requests = [];
  const ctx = { llm: { async *stream(request) {
    requests.push(request);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Confirmed defect: missing null check in a.' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } } };
  let version = 0;
  const collect = async (_cwd, options) => ({ label: options.path ?? 'working', diff: `diff --git a/a b/a\n+${version}\n` });
  const save = value => events.push({ type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify(value) }] }] } } });
  save(null); // Other tools can emit arbitrary JSON; it is not review state.
  let agent = makeAgent();
  const first = await independentReview(ctx, agent, {}, undefined, collect);
  save(first);
  assert.equal(first.reviewBudget.used, 1);
  assert.equal((await independentReview(ctx, agent, {}, undefined, collect)).cached, true);
  version++;
  const second = await independentReview(ctx, agent, { path: 'a' }, undefined, collect);
  save(second);
  const payload = JSON.parse(requests[1].messages[0].content[0].text);
  assert.equal(payload.mode, 'verification');
  assert.match(payload.previousReport, /missing null check/);
  assert.equal(second.reviewBudget.used, 2);
  version++;
  agent = makeAgent(); // Simulate resume: no WeakMap state.
  const blocked = await independentReview(ctx, agent, { path: 'another-path' }, undefined, collect);
  assert.equal(blocked.status, 'budget_exhausted');
  assert.match(blocked.report, /not a clean review/);
  assert.equal(requests.length, 2);
  // A deliberate user slash command is distinct from the model tool and does not reset its allowance.
  assert.equal((await independentReview(ctx, agent, {}, undefined, collect, undefined, { manual: true })).status, 'reviewed');
  version++;
  assert.equal((await independentReview(ctx, agent, {}, undefined, collect)).status, 'budget_exhausted');
  events.push({ type: 'user/message', seq: 9, time: 9, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix the bug' }] } });
  const next = await independentReview(ctx, agent, {}, undefined, collect);
  assert.equal(next.status, 'reviewed');
  assert.equal(next.reviewBudget.used, 1);
  assert.equal(JSON.parse(requests.at(-1).messages[0].content[0].text).mode, 'initial');
});

test('failed reviews consume passes and concurrent calls cannot multiply model work', async () => {
  const agent = { options: {}, session: { id: 'failed', header: { cwd: '/fixture' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => [] } };
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const ctx = { llm: { async *stream() { calls++; entered(); await gate; throw Error('provider unavailable'); } } };
  const collect = async () => ({ label: 'working', diff: '+changed' });
  const pending = independentReview(ctx, agent, {}, undefined, collect);
  await started;
  assert.equal((await independentReview(ctx, agent, {}, undefined, collect)).status, 'in_progress');
  release();
  const failure = await pending;
  assert.equal(failure.status, 'error');
  assert.equal(failure.reviewBudget.used, 1);
  assert.equal((await independentReview(ctx, agent, {}, undefined, collect)).reviewBudget.used, 2);
  assert.equal((await independentReview(ctx, agent, {}, undefined, collect)).status, 'budget_exhausted');
  assert.equal(calls, 2);
  assert.equal(REVIEW_LIMITS.timeoutMs, 90_000);
});


test('the review deadline bounds stalled model metadata and streams and returns an incomplete result', async t => {
  for (const phase of ['metadata', 'stream']) {
    const timer = new AbortController();
    let timeout;
    const mock = t.mock.method(AbortSignal, 'timeout', ms => { timeout = ms; return timer.signal; });
    try {
      const agent = { options: {}, session: { header: { cwd: '/fixture' }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }), snapshotEvents: () => [] } };
      const stall = () => { queueMicrotask(() => timer.abort(new DOMException('review deadline', 'TimeoutError'))); return new Promise(() => {}); };
      const ctx = { llm: {
        ...(phase === 'metadata' ? { resolveModelInfo: stall } : {}),
        async *stream() { await stall(); },
      } };
      const result = await independentReview(ctx, agent, {}, undefined, async () => ({ label: 'working', diff: '+changed' }));
      assert.equal(timeout, 90_000);
      assert.equal(result.status, 'error');
      assert.match(result.report, /Review incomplete.*review deadline/);
      assert.equal(result.reviewBudget.used, 1);
    } finally { mock.mock.restore(); }
  }
});

test('untracked files that turn unreadable during collection are omitted, not fatal', async () => {
  if (process.getuid?.() === 0) return; // chmod-based unreadability needs a non-root runner
  const cwd = await mkdtemp(join(tmpdir(), 'dscode-review-'));
  try {
    await git(cwd, 'init', '-q');
    await git(cwd, 'config', 'user.email', '[EMAIL]');
    await writeFile(join(cwd, 'readable.txt'), 'content\n');
    await writeFile(join(cwd, 'locked.txt'), 'secret\n');
    await chmod(join(cwd, 'locked.txt'), 0o000);
    try {
      const { text, omitted } = await untracked(cwd, '', undefined);
      assert.match(text, /readable\.txt/);
      assert.deepEqual(omitted, ['locked.txt']);
      assert.match(text, /unreadable or vanished/);
      assert.doesNotMatch(text, /secret/);
    } finally { await chmod(join(cwd, 'locked.txt'), 0o644); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('reviewRoute pins the reviewer model and effort like codex review_model', () => {
  const fallback = { provider: 'session', model: 'small' };
  assert.deepEqual(reviewRoute(fallback, {}), { route: fallback, effort: 'minimal' });
  assert.deepEqual(reviewRoute(fallback, { DSCODE_REVIEW_MODEL: 'deepseek-official/deepseek-flash' }), { route: { provider: 'deepseek-official', model: 'deepseek-flash' }, effort: 'minimal' });
  assert.deepEqual(reviewRoute(fallback, { DSCODE_REVIEW_MODEL: 'big-model' }).route, { provider: 'session', model: 'big-model' });
  assert.equal(reviewRoute(fallback, { DSCODE_REVIEW_MODEL: 'p/m', DSCODE_REVIEW_EFFORT: ' high ' }).effort, 'high');
  assert.equal(reviewRoute(undefined, { DSCODE_REVIEW_MODEL: 'p/m' }).route.model, 'm');
  assert.deepEqual(reviewRoute(fallback, { DSCODE_REVIEW_MODEL: '/' }).route, fallback, 'a malformed override keeps the session route');
});

test('describeAttempt reports the budget the reviewer had and how it spent it', () => {
  assert.equal(describeAttempt(8192, { usage: { reasoningTokens: 7253, outputTokens: 8098 } }, { kind: 'max-tokens' }),
    '8192 tokens allowed, stopped max-tokens, used 7253 reasoning, 8098 output');
  assert.equal(describeAttempt(32768, { usage: null }, undefined), '32768 tokens allowed, stopped without a finish');
});
