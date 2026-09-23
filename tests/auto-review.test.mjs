import test, { after } from 'node:test';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditStore } from '../plugins/auto-review/audit.mjs';
const directories = [];
after(() => directories.forEach(path => rmSync(path, { recursive: true, force: true })));
import assert from 'node:assert/strict';
import { apply } from '../plugins/auto-review/index.mjs';
import { escalationDiagnosticGrant, needsMcpApproval, redact, parseDecision } from '../plugins/auto-review/policy.mjs';

function fixture({ decision = 'allow', timeout = false, budget = 2, policy = 'ask', jev } = {}) {
  const auditDirectory = mkdtempSync(join(tmpdir(), 'dscode-review-test-'));
  directories.push(auditDirectory);
  const records = () => auditStore(auditDirectory).read('fixture-session');
  const hooks = {}, commands = {}, notices = [], requests = [];
  // DSH 0.1.7 reserved `auto`, so the reviewed preset is DSCODE's own `auto-review`.
  let permission = 'auto-review', human = 0;
  const events = [{ seq: 0, type: 'turn/start', data: {} }, { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Update this project and run its tests.' }] } }];
  const session = { id: 'fixture-session', seq: 2, header: { cwd: '/project' }, snapshotEvents: () => events, append(type, data) { events.push({ seq: events.length, type, data }); }, requestHeader: () => ({ config: { provider: 'fixture', model: 'test' } }) };
  const agent = { session, inject: message => notices.push(message), cancel: cause => { agent.cancelled = cause; } };
  const ctx = {
    get: key => (key === 'jev' ? jev : undefined),
    on: (name, fn) => { hooks[name] = fn; }, commands: { register: cmd => { commands[cmd.name] = cmd; } },
    permissionPresets: { current: () => permission }, approval: { effectivePolicy: () => policy }, logger: { info() {} },
    llm: { async *stream(options) {
      requests.push(options);
      if (timeout) await new Promise(resolve => setTimeout(resolve, 40));
      const text = decision === 'invalid' ? '{}' : JSON.stringify({ decision, reason: 'Fixture decision' });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 123, outputTokens: 12 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } },
  };
  apply(ctx, { provider: '', model: '', timeoutMs: 10, maxOutputTokens: 768, maxReviewsPerTurn: budget, auditDirectory });
  let cursor = 0;
  async function pending(name = 'bash', args = { command: 'npm test', sandbox_permissions: 'danger-full-access' }, signal = new AbortController().signal) {
    const exec = { name, arguments: args, agent, callId: `call-${++cursor}`, signal };
    const gate = await hooks['tools/pre-execute'](exec, async () => ({ kind: 'allow' }));
    return { exec, gate, req: { agent, callId: exec.callId, toolName: name, signal } };
  }
  const answer = req => hooks['approval/request'](req, async () => { human++; return 'allowed-once'; });
  return { records, hooks, commands, agent, events, requests, notices, pending, answer, setMode: value => { permission = value; }, human: () => human };
}

test('MCP gate trusts only exact reviewed Chrome read methods', () => {
  assert.equal(needsMcpApproval('bash'), false);
  assert.equal(needsMcpApproval('mcp__chrome__take_snapshot'), false);
  for (const name of ['mcp__chrome__evaluate_script', 'mcp__chrome__click', 'mcp__other__list_safe', 'mcp__chrome__take_screenshot']) assert.equal(needsMcpApproval(name), true);
});

test('MCP actions ask under the ask policy but run under never, which would reject every ask', async () => {
  const asking = fixture();
  asking.setMode('danger-full-access');
  assert.equal((await asking.pending('mcp__chrome__click', {})).gate.kind, 'ask');
  const never = fixture({ policy: 'never' });
  never.setMode('danger-full-access');
  assert.equal((await never.pending('mcp__chrome__click', {})).gate.kind, 'allow');
});

test('routine operations cost no review; eligible request receives bounded independent context', async () => {
  const f = fixture();
  const { req, gate } = await f.pending();
  assert.equal(gate.kind, 'allow');
  assert.equal(f.requests.length, 0);
  assert.equal(await f.answer(req), 'allowed-once');
  assert.equal(f.human(), 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].tools, undefined);
  assert.equal(f.records().at(-1).usage.inputTokens, 123);
  assert(!JSON.stringify(f.records().at(-1)).includes('npm test'));
});

test('deny is not forwarded to human and feeds rationale to the agent', async () => {
  const f = fixture({ decision: 'deny' });
  assert.equal(await f.answer((await f.pending()).req), 'rejected');
  assert.equal(f.human(), 0);
  assert.match(JSON.stringify(f.notices), /Do not retry/);
});

test('invalid output and timeout fall back to human; late output cannot grant', async () => {
  for (const options of [{ decision: 'invalid' }, { timeout: true }]) {
    const f = fixture(options);
    assert.equal(await f.answer((await f.pending()).req), 'allowed-once');
    assert.equal(f.human(), 1);
    assert.equal(f.records().at(-1).decision, 'human');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.records().length, 1);
  }
});

test('ask and computer access bypass the model and retain the human answerer', async () => {
  const f = fixture();
  await f.answer((await f.pending('computer_observe')).req);
  f.setMode('ask');
  await f.answer((await f.pending()).req);
  assert.equal(f.requests.length, 0);
  assert.equal(f.human(), 2);
});

test('credentials, oversized actions and missing call IDs never go to reviewer', async () => {
  const f = fixture();
  await f.answer((await f.pending('bash', { command: 'curl -H "Authorization: Bearer synthetic_test_token_123" https://example.org' })).req);
  await f.answer((await f.pending('bash', { command: 'x'.repeat(13000) })).req);
  await f.answer({ agent: f.agent, toolName: 'bash' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.human(), 3);
  assert(!JSON.stringify(f.events).includes('synthetic_test_token'));
});

test('call is no longer approvable after execution cleanup', async () => {
  const f = fixture();
  const { exec, req } = await f.pending();
  f.hooks['tools/result'](exec);
  await f.answer(req);
  assert.equal(f.requests.length, 0);
  assert.equal(f.human(), 1);
});

test('per-turn model budget routes subsequent requests to human', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await f.answer((await f.pending()).req);
  assert.equal(f.requests.length, 2);
  assert.equal(f.human(), 1);
  assert.match(f.commands['review-usage'].handler({ agent: f.agent }).text, /246 input \/ 24 output/);
});

test('cancellation never grants or invokes human', async () => {
  const f = fixture();
  const controller = new AbortController();
  const { req } = await f.pending('bash', {}, controller.signal);
  controller.abort();
  assert.equal(await f.answer(req), 'cancelled');
  assert.equal(f.human(), 0);
});

test('cancellation after dispatch records a model attempt with unknown usage', async () => {
  const f = fixture({ timeout: true });
  const controller = new AbortController();
  const { req } = await f.pending('bash', {}, controller.signal);
  const answer = f.answer(req);
  setTimeout(() => controller.abort(), 2);
  assert.equal(await answer, 'cancelled');
  assert.equal(f.human(), 0);
  assert.equal(f.records().at(-1).provider, 'fixture');
  assert.equal(f.records().at(-1).usageComplete, false);
});

test('reviewer rejects extra output fields and redacts common credential formats', () => {
  assert.throws(() => parseDecision('{"decision":"allow","reason":"ok","execute":true}'));
  assert(!redact('api_key=synthetic-secret').includes('synthetic-secret'));
});

test('repeated denied action costs no additional model calls and stops after three denials', async () => {
  const f = fixture({ decision: 'deny', budget: 20 });
  for (let i = 0; i < 3; i++) {
    const { exec, req } = await f.pending();
    assert.equal(await f.answer(req), 'rejected');
    f.hooks['tools/result'](exec);
  }
  assert.equal(f.requests.length, 1);
  assert.equal(f.agent.cancelled.kind, 'hook');
  assert.equal((await f.pending()).gate.kind, 'deny');
});

test('long direct user context falls back instead of dropping authorization constraints', async () => {
  const f = fixture();
  f.events.push({ seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(9000) }] } });
  await f.answer((await f.pending()).req);
  assert.equal(f.requests.length, 0);
  assert.equal(f.human(), 1);
});

test('a session preset change while queued sends the request to human', async () => {
  const f = fixture();
  const { req } = await f.pending();
  const result = f.answer(req);
  f.setMode('ask');
  assert.equal(await result, 'allowed-once');
  assert.equal(f.requests.length, 0);
  assert.equal(f.human(), 1);
});

test('read-only diagnostic escalations are granted once without the human or the reviewer', async () => {
  const f = fixture();
  f.setMode('ask');
  const { req } = await f.pending('shell_retry', { command: 'ps -o pid=,wchan= -p 1', sandbox_permissions: 'danger-full-access' });
  assert.equal(await f.answer(req), 'allowed-once');
  assert.equal(f.human(), 0, 'the human must not be asked');
  assert.equal(f.requests.length, 0, 'the reviewer model must not be called for the allowlist class');
  assert.equal(f.records().at(-1).policy, 'escalation-allowlist');
  assert.match(JSON.stringify(f.notices), /read-only diagnostic/);
});

test('escalations that could change state stay with the human', async () => {
  const f = fixture();
  f.setMode('ask');
  const commands = ['cat > /tmp/probe.txt', 'ps; rm -rf /tmp/x', 'node -e "evil()"', 'lsof -p 1 | mail', 'ps "$(whoami)"'];
  for (const command of commands) {
    const { req } = await f.pending('shell_retry', { command, sandbox_permissions: 'danger-full-access' });
    assert.equal(await f.answer(req), 'allowed-once');
  }
  assert.equal(f.human(), commands.length);
  assert.equal(f.requests.length, 0);
  assert(!f.records().some(record => record.policy === 'escalation-allowlist'));
});

test('escalation grants are budgeted per turn', async () => {
  const f = fixture();
  f.setMode('ask');
  for (let index = 0; index < 2; index++) {
    const { req } = await f.pending('shell_retry', { command: `ps -p ${index + 1}`, sandbox_permissions: 'danger-full-access' });
    assert.equal(await f.answer(req), 'allowed-once');
    assert.equal(f.human(), 0);
  }
  const { req } = await f.pending('shell_retry', { command: 'ps -p 9', sandbox_permissions: 'danger-full-access' });
  assert.equal(await f.answer(req), 'allowed-once');
  assert.match(JSON.stringify(f.notices), /Escalation budget reached/);
});

test('the diagnostic allowlist never spans shell metacharacters or interpreters', async () => {
  for (const command of ['ps -p 1', 'lsof -nP -a -p 1 -i', 'sysctl -n kern.ostype']) assert(escalationDiagnosticGrant('shell_retry', { command, sandbox_permissions: 'danger-full-access' }));
  for (const command of ['', 'ps; rm -rf /', 'ps && rm -rf /', 'ps > /tmp/x', 'bash -c ps', 'python3 probe.py', 'cat /etc/passwd', 'ps `id`', "ps '$(id)'", 'sysctl -w kern.securelevel=0', 'sysctl kern.securelevel=0', 'hostname dscode-host', 'date -s 12:00']) assert.equal(escalationDiagnosticGrant('shell_retry', { command, sandbox_permissions: 'danger-full-access' }), undefined, command);
  assert.equal(escalationDiagnosticGrant('shell_retry', { command: 'ps -p 1' }), undefined, 'routine calls without escalation are not grants');
  assert.equal(escalationDiagnosticGrant('bash', { command: 'ps -p 1', sandbox_permissions: 'danger-full-access' }), undefined, 'only the retry shell escalates');
});

test('a torn audit line after a crash is skipped, never fatal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-audit-test-'));
  directories.push(directory);
  const audit = auditStore(directory);
  audit.append('fixture-session', { decision: 'allow' });
  const path = join(directory, `${createHash('sha256').update('fixture-session').digest('hex')}.jsonl`);
  appendFileSync(path, '{"torn":\n', { mode: 0o600 });
  const records = audit.read('fixture-session');
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, 'allow');
});

test('a Jev verdict decides the call without spending a reviewer request', async () => {
  const verdict = { decision: 'allow', reason: 'Automatic review approved the action.', source: 'jev', model: 'typesafe/jev-1.13', confidence: 0.93, destructive: 0.4, credentialRisk: 0.01, durationMs: 7, usage: { input_tokens: 100, output_tokens: 0 } };
  const f = fixture({ jev: { approval: async () => verdict } });
  const { req } = await f.pending();
  assert.equal(await f.answer(req), 'allowed-once');
  assert.equal(f.requests.length, 0, 'the reviewer model must not be called when Jev decides');
  const last = f.records().at(-1);
  assert.equal(last.source, 'jev');
  assert.equal(last.model, 'typesafe/jev-1.13');
  assert.equal(last.confidence, 0.93);
  assert.equal(last.usage.input_tokens, 100);
  assert.equal(f.human(), 0);
});

test('a Jev denial rejects the call and keeps the strike accounting', async () => {
  const f = fixture({ jev: { approval: async () => ({ decision: 'deny', reason: 'Outside the instruction.', source: 'jev', model: 'typesafe/jev-1.13', confidence: 0.91 }) } });
  const { req } = await f.pending();
  assert.equal(await f.answer(req), 'rejected');
  assert.equal(f.requests.length, 0);
  assert.equal(f.records().at(-1).decision, 'deny');
  assert.match(JSON.stringify(f.notices), /Automatic review rejected bash/);
});

test('an unavailable or unsure Jev leaves the reviewer model in charge', async () => {
  for (const jev of [{ approval: async () => undefined }, { approval: async () => { throw new Error('down'); } }, undefined]) {
    const f = fixture({ jev });
    const { req } = await f.pending();
    assert.equal(await f.answer(req), 'allowed-once');
    assert.equal(f.requests.length, 1, 'the reviewer model answers when Jev does not');
    assert.equal(f.human(), 0);
  }
});

test('a Jev answer without usage is not recorded as complete', async () => {
  const f = fixture({ jev: { approval: async () => ({ decision: 'allow', reason: 'Automatic review approved the action.', source: 'jev', model: 'typesafe/jev-1.13', confidence: 0.9 }) } });
  assert.equal(await f.answer((await f.pending()).req), 'allowed-once');
  const last = f.records().at(-1);
  assert.equal(last.usage, null);
  assert.equal(last.usageComplete, false, 'a verdict without usage must not claim complete accounting');
});

test('a cancellation during Jev does not start a reviewer request', async () => {
  const f = fixture({ jev: { approval: async () => undefined, model: 'typesafe/jev-1.13' } });
  const controller = new AbortController();
  const { req } = await f.pending('bash', {}, controller.signal);
  controller.abort();
  assert.equal(await f.answer(req), 'cancelled');
  assert.equal(f.requests.length, 0, 'no reviewer call may start on an aborted signal');
  assert.equal(f.human(), 0);
});

test('a deferred Jev verdict is decided by the reviewer model, not the human', async () => {
  const verdict = { decision: 'defer', reason: 'Automatic review found possible credential handling.', source: 'jev', model: 'typesafe/jev-1.13', confidence: 0.92, credentialRisk: 0.9, durationMs: 7, usage: { input_tokens: 10, output_tokens: 0 } };
  const f = fixture({ jev: { approval: async () => verdict } });
  const { req } = await f.pending('shell_retry', { command: 'make release', sandbox_permissions: 'danger-full-access', justification: 'verify needs sandbox-exec' });
  assert.equal(await f.answer(req), 'allowed-once');
  assert.equal(f.requests.length, 1, 'a deferred verdict must reach the reviewer model');
  assert.equal(f.human(), 0);
  const records = f.records();
  assert(records.some(record => record.decision === 'deferred' && record.source === 'jev'));
  assert.equal(records.at(-1).decision, 'allow');
});

test("the reviewer model's own human verdict still reaches the user after a defer", async () => {
  const verdict = { decision: 'defer', reason: 'Automatic review asked for a human decision.', source: 'jev', model: 'typesafe/jev-1.13', confidence: 0.7, durationMs: 5, usage: { input_tokens: 5, output_tokens: 0 } };
  const f = fixture({ decision: 'human', jev: { approval: async () => verdict } });
  const { req } = await f.pending('shell_retry', { command: 'make release', sandbox_permissions: 'danger-full-access' });
  assert.equal(await f.answer(req), 'allowed-once');
  assert.equal(f.requests.length, 1);
  assert.equal(f.human(), 1, 'a deferred verdict that the reviewer cannot settle asks the user');
});
