import test from 'node:test';
import assert from 'node:assert/strict';
import { DECISIONS_PATH, buildBody, decisionsUrl, readAnswers, requestDecisions, validateQuestions } from '../plugins/jev/client.mjs';
import { DEFAULT_THRESHOLDS, approvalQuestions, approvalState, approvalVerdict } from '../plugins/jev/approval.mjs';
import { apply, resolveOptions } from '../plugins/jev/index.mjs';

const noul = { q: { type: 'noul', instructions: 'Is it urgent?' } };
const answers = overrides => ({
  verdict: { type: 'choice', choice: 'allow', confidence: 0.94, probabilities: { allow: 0.94 }, ...overrides.verdict },
  destructive: { type: 'score', score: 0.4, ...overrides.destructive },
  authorized: { type: 'noul', noul: 0.1, ...overrides.authorized },
  credential_risk: { type: 'noul', noul: 0.02, ...overrides.credential_risk },
});

test('the decisions endpoint is built from the configured origin', () => {
  assert.equal(decisionsUrl(), `https://openrouter.ai${DECISIONS_PATH}`);
  assert.equal(decisionsUrl('https://gateway.example/v1/'), `https://gateway.example/v1${DECISIONS_PATH}`);
  assert.throws(() => decisionsUrl('not a url'), /endpoint must be a URL/);
  assert.throws(() => resolveOptions({ endpoint: 'not a url' }), /endpoint must be a URL/);
});

test('a malformed question set is rejected before any request is sent', () => {
  const choice = extra => ({ type: 'choice', instructions: 'Pick one', criteria: { a: 'first' }, ...extra });
  const score = levels => ({ type: 'score', instructions: 'How bad?', criteria: Array.from({ length: levels }, (_, index) => `level ${index}`) });
  assert.deepEqual(Object.keys(validateQuestions(noul)), ['q']);
  for (const bad of [
    null, [], 'x',
    { q: { type: 'text', instructions: 'x' } },
    { q: { type: 'noul' } },
    { q: { type: 'choice', instructions: 'x' } },
    { q: choice({ criteria: {} }) },
    { q: choice({ criteria: Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`o${index}`, 'x'])) }) },
    { q: { type: 'score', instructions: 'x', criteria: ['only one'] } },
    { q: score(11) },
  ]) assert.throws(() => validateQuestions(bad));
  assert.throws(() => buildBody({ state: undefined, questions: noul }), /state is required/);
  assert.throws(() => readAnswers({}), /missing answers/);
});

test('one POST carries the state and every question, and the answers come back parsed', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ id: 'gen-1', model: 'typesafe/jev-1.13', provider: 'TypeSafe', answers: { q: { type: 'noul', noul: 0.81 } }, usage: { input_tokens: 42, output_tokens: 0, cost: 0.0000018 } }) };
  };
  const result = await requestDecisions({ apiKey: 'sk-test', state: { tool: 'bash' }, questions: noul, sessionId: 'session-1', fetchImpl });
  assert.equal(seen.url, `https://openrouter.ai${DECISIONS_PATH}`);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(seen.body, { model: '~typesafe/jev-latest', state: { tool: 'bash' }, questions: noul, session_id: 'session-1' });
  assert.equal(result.answers.q.noul, 0.81);
  assert.equal(result.usage.input_tokens, 42);
});

test('transport failures surface as errors so the caller can fall back', async () => {
  const failing = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(requestDecisions({ apiKey: 'sk-test', state: 'x', questions: noul, fetchImpl: failing }), /HTTP 503/);
  await assert.rejects(requestDecisions({ apiKey: '', state: 'x', questions: noul, fetchImpl: failing }), /no API key/);
  const hanging = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  await assert.rejects(requestDecisions({ apiKey: 'sk-test', state: 'x', questions: noul, timeoutMs: 20, fetchImpl: hanging }), /timed out/);
});

test('allowing stays gated behind confidence and a low risk profile', () => {
  const confidentAllow = approvalVerdict(answers({}));
  assert.equal(confidentAllow.decision, 'allow');
  assert.equal(confidentAllow.confidence, 0.94);
  assert.equal(approvalVerdict(answers({ verdict: { choice: 'allow', confidence: DEFAULT_THRESHOLDS.autoAllow - 0.01 } })).decision, 'human');
  assert.equal(approvalVerdict(answers({ verdict: { choice: 'ask', confidence: 0.99 } })).decision, 'human');
  assert.equal(approvalVerdict(answers({ credential_risk: { noul: 0.9 } })).decision, 'human', 'credential handling always asks');
  assert.equal(approvalVerdict(answers({ destructive: { score: 2.4 } })).decision, 'human', 'hard-to-undo work always asks');
  assert.equal(approvalVerdict({ destructive: { score: 0 } }), undefined, 'a missing verdict is not a decision');
  assert.deepEqual(Object.keys(approvalQuestions()).sort(), ['authorized', 'credential_risk', 'destructive', 'verdict']);
});

test('a decisive deny is honoured, and a risk score can corroborate a slightly lower one', () => {
  const decisive = approvalVerdict(answers({ verdict: { choice: 'deny', confidence: 0.98, probabilities: { deny: 0.97 } } }));
  assert.equal(decisive.decision, 'deny');
  assert.equal(decisive.denyProbability, 0.97);
  const corroborated = approvalVerdict(answers({ verdict: { choice: 'deny', confidence: 0.92, probabilities: { deny: 0.55 } }, credential_risk: { noul: 0.94 } }));
  assert.equal(corroborated.decision, 'deny', 'a confident deny plus a crossed risk ceiling rejects without asking');
  const corroboratedDestructive = approvalVerdict(answers({ verdict: { choice: 'deny', confidence: 0.91, probabilities: { deny: 0.5 } }, destructive: { score: 2.99 } }));
  assert.equal(corroboratedDestructive.decision, 'deny');
});

test('a silent rejection needs corroboration, and an authorizing instruction vetoes it', () => {
  const borderline = approvalVerdict(answers({ verdict: { choice: 'deny', confidence: 0.9, probabilities: { deny: 0.88 } }, destructive: { score: 1.97 } }));
  assert.equal(borderline.decision, 'human', 'a borderline deny asks instead of blocking silently');
  const vetoed = approvalVerdict(answers({ verdict: { choice: 'deny', confidence: 0.99, probabilities: { deny: 0.98 } }, authorized: { noul: 0.8 } }));
  assert.equal(vetoed.decision, 'human');
  assert.match(vetoed.reason, /appears to authorize it/);
  const vetoBoundary = approvalVerdict(answers({ verdict: { choice: 'deny', confidence: 0.99, probabilities: { deny: 0.98 } }, authorized: { noul: DEFAULT_THRESHOLDS.authorizedVeto - 0.01 } }));
  assert.equal(vetoBoundary.decision, 'deny', 'below the veto the deny stands');
});

test('the approval state carries the pending call and the retained instruction, bounded', () => {
  const state = approvalState({ action: { tool: 'bash', arguments: { command: 'rm -rf build' } }, context: { userMessages: [{ content: [{ text: 'Clean the build directory.' }] }] } });
  assert.match(state.pendingToolCall, /rm -rf build/);
  assert.equal(state.userInstructions, 'Clean the build directory.');
  const huge = approvalState({ action: 'x'.repeat(20000), context: {} });
  assert(huge.pendingToolCall.length < 8100);
  assert.match(huge.pendingToolCall, /truncated/);
});

test('the plugin stays inert without a key and fails closed when the call fails', async () => {
  const provided = {};
  const credentials = { resolve: async () => ({ value: 'sk-live' }) };
  const ctx = { get: key => (key === 'credentials' ? credentials : undefined), provide: (key, value) => { provided[key] = value; }, logger: { warn: () => {} } };
  apply(ctx, {});
  const service = provided.jev;
  assert.equal(service.enabled(), true);
  assert.equal(await service.configured(), true);
  const noKey = { ...ctx, get: key => (key === 'credentials' ? { resolve: async () => undefined } : undefined), provide: () => {} };
  const bare = apply(noKey, {});
  assert.equal(await bare.configured(), false);
  assert.equal(await bare.approval({ action: {}, context: {} }), undefined);

  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ model: 'typesafe/jev-1.13', answers: answers({}), usage: { input_tokens: 12, output_tokens: 0 } }) });
  try {
    const verdict = await service.approval({ action: { tool: 'bash', arguments: { command: 'git status' } }, context: { userMessages: [{ content: [{ text: 'Check the tree.' }] }] } });
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.source, 'jev');
    assert.equal(verdict.usage.input_tokens, 12);
  } finally { globalThis.fetch = original; }

  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    assert.equal(await service.approval({ action: {}, context: {} }), undefined, 'a transport failure must not produce a verdict');
  } finally { globalThis.fetch = original; }
  assert.equal(apply(ctx, { enabled: false }).approval ? await apply(ctx, { enabled: false }).approval({ action: {}, context: {} }) : undefined, undefined, 'a disabled plugin never decides');
});

test('an authorizing instruction defers Jev risk guards to the reviewer model', () => {
  const authorized = { authorized: { noul: 0.8 } };
  for (const overrides of [
    { ...authorized, credential_risk: { noul: 0.9 } },
    { ...authorized, destructive: { score: 2.4 } },
    { ...authorized, verdict: { choice: 'ask', confidence: 0.99 } },
    { ...authorized, verdict: { choice: 'allow', confidence: 0.5 } },
  ]) assert.equal(approvalVerdict(answers(overrides)).decision, 'defer', JSON.stringify(overrides));
  // Below the veto score the same guards still ask the human.
  assert.equal(approvalVerdict(answers({ authorized: { noul: DEFAULT_THRESHOLDS.authorizedVeto - 0.01 }, credential_risk: { noul: 0.9 } })).decision, 'human');
  // A confident deny is not one of the allow-direction guards: it still reaches the human.
  assert.equal(approvalVerdict(answers({ ...authorized, verdict: { choice: 'deny', confidence: 0.99, probabilities: { deny: 0.98 } } })).decision, 'human');
});
