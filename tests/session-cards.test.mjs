import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { SessionCards } from '../plugins/session-cards/manager.mjs';
import { userRequest, selectRequests, validateTopics, repositoryIdentity, detectProject } from '../plugins/session-cards/content.mjs';

const user = (seq, text) => ({ seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } });
function session(id, events) { return { id, header: { agentPreset: 'dscode', cwd: '/workspace' }, snapshotEvents: () => events, requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture', reasoningEffort: 'ultra' } }) }; }
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for background card');
}
function fixture(t, generate, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-cards-'));
  const cards = new SessionCards({ root, generate, config: { minMessages: 1, debounceMs: 0, cooldownMs: 0, ...config }, project: async () => ({ name: 'project', id: 'host/project' }) });
  t.after(async () => { await cards.close(); rmSync(root, { recursive: true, force: true }); });
  return { cards, root };
}

test('only direct user text enters bounded topic input, excluding agent conclusions and relays', () => {
  assert.equal(userRequest({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'All tests passed' }] } }), null);
  assert.equal(userRequest({ ...user(1, 'relay'), data: { source: { kind: 'plugin', plugin: 'dscode-session-bridge' }, content: [{ type: 'text', text: 'relay' }] } }), null);
  const requests = Array.from({ length: 40 }, (_, i) => ({ seq: i, text: 'x'.repeat(1000) }));
  const selected = selectRequests(requests, 32, 5000);
  assert.deepEqual(selected.map(m => m.seq), [35, 36, 37, 38, 39]);
  assert(!userRequest(user(1, 'api_key=supersecret')).text.includes('supersecret'));
});

test('topic schema contains descriptions and source sequences only, with newest first', () => {
  const messages = [userRequest(user(1, '做鲸鱼动画')), userRequest(user(3, '取消鲸鱼动画'))];
  assert.throws(() => validateTopics({ topics: [], conclusions: ['done'] }, messages, 5), /Invalid/);
  assert.throws(() => validateTopics({ topics: [{ text: '取消动画', sourceSeqs: [99] }] }, messages, 5), /sources/);
  assert.throws(() => validateTopics({ topics: [{ text: '取消动画', sourceSeqs: [3], result: '已完成' }] }, messages, 5), /description/);
  assert.deepEqual(validateTopics({ topics: [{ text: '取消鲸鱼动画方案', sourceSeqs: [1, 3] }] }, messages, 5), [{ text: '取消鲸鱼动画方案', sourceSeqs: [1, 3] }]);
  assert.throws(() => validateTopics({ topics: Array.from({ length: 6 }, () => ({ text: 'x', sourceSeqs: [1] })) }, messages, 5), /Invalid/);
});

test('card persists across resume and unchanged user requests cause no extra model calls', async t => {
  let calls = 0;
  const { cards, root } = fixture(t, async input => { calls++; return { value: { topics: [{ text: '实现会话入口', sourceSeqs: input.messages.map(m => m.seq) }] } }; });
  const events = [user(0, '实现会话入口')], s = session('one', events);
  cards.track(s); await until(() => cards.get(s).cardState.status === 'ready');
  const card = cards.get(s).card;
  assert.deepEqual(Object.keys(card), ['project', 'workspace', 'topics']);
  assert.equal(card.project.name, 'project'); assert.equal(card.workspace, '/workspace');
  assert(Object.isFrozen(card.topics));
  await cards.close();
  const resumed = new SessionCards({ root, generate: async () => { throw Error('must not generate'); }, project: async () => null });
  t.after(() => resumed.close());
  assert.equal(resumed.get(session('one', events)).cardState.status, 'ready');
  assert.equal(calls, 1);
});

test('new requests invalidate stale extraction, one worker serves multiple sessions', async t => {
  const gate = Promise.withResolvers(); let calls = 0, active = 0, max = 0;
  const { cards } = fixture(t, async input => {
    calls++; active++; max = Math.max(max, active);
    if (calls === 1) await gate.promise;
    active--;
    return { value: { topics: [{ text: input.messages.at(-1).text, sourceSeqs: [input.messages.at(-1).seq] }] } };
  });
  const events = [user(0, '增加动画')], a = session('a', events), b = session('b', [user(0, '实现标题')]);
  cards.track(a); await until(() => calls === 1);
  const cancellation = user(1, '取消动画方案'); events.push(cancellation); cards.observe(a, cancellation); cards.track(b);
  assert.equal(cards.get(a).cardState.status, 'pending');
  gate.resolve();
  await until(() => cards.get(a).cardState.status === 'ready' && cards.get(b).cardState.status === 'ready');
  assert.equal(max, 1); assert.equal(cards.get(a).card.topics[0].text, '取消动画方案');
  assert.deepEqual(cards.get(a).card.topics[0].sourceSeqs, [1]);
});

test('short sessions expose local identity without extracting until the configured threshold', async t => {
  let calls = 0;
  const { cards } = fixture(t, async () => { calls++; return { value: { topics: [{ text: '实现标题', sourceSeqs: [0, 1, 2] }] } }; }, { minMessages: 3 });
  const events = [user(0, '实现标题'), user(1, '支持外部发送')], s = session('threshold', events);
  cards.track(s);
  await until(() => cards.get(s).card.project !== null);
  assert.equal(cards.get(s).cardState.status, 'insufficient');
  assert.equal(cards.candidates().length, 0); assert.equal(calls, 0);
  events.push(user(2, '能在列表看到')); cards.observe(s, events[2]);
  await until(() => cards.get(s).cardState.status === 'ready');
  assert.equal(calls, 1);
});

test('failed extraction keeps prior descriptive card and applies retry backoff', async t => {
  let fail = false;
  const { cards } = fixture(t, async () => { if (fail) throw Error('offline'); return { value: { topics: [{ text: '实现标题', sourceSeqs: [0] }] } }; });
  const events = [user(0, '实现标题')], s = session('failure', events);
  cards.track(s); await until(() => cards.get(s).cardState.status === 'ready');
  fail = true; events.push(user(1, '新增入口')); cards.observe(s, events[1]);
  await until(() => cards.get(s).cardState.status === 'error');
  assert.equal(cards.get(s).card.topics[0].text, '实现标题');
  assert.equal(cards.get(s).cardState.coveredUserSeq, 0);
  assert.equal(cards.get(s).cardState.latestUserSeq, 1);
  assert(cards.states.get(s.id).nextAt > Date.now());
});

test('project identity unifies remote formats, strips credentials, and handles local worktrees', async t => {
  assert.deepEqual(repositoryIdentity('https://user:secret@github.com/owner/repo.git?token=secret', '/x/.git'), { name: 'repo', id: 'github.com/owner/repo' });
  assert.deepEqual(repositoryIdentity('git@github.com:owner/repo.git', '/x/.git'), { name: 'repo', id: 'github.com/owner/repo' });
  const root = mkdtempSync(join(tmpdir(), 'dscode-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(await detectProject(root), null);
  const main = join(root, 'main'), worktree = join(root, 'worktree');
  execFileSync('git', ['init', '-q', main]);
  execFileSync('git', ['-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'fixture']);
  execFileSync('git', ['-C', main, 'worktree', 'add', '--detach', worktree], { stdio: 'ignore' });
  assert.deepEqual(await detectProject(main), await detectProject(worktree));
});
