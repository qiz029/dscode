import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { auditStore } from '../plugins/auto-review/audit.mjs';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';

export async function probeDscode(ctx) {
  const cwd = join(process.env.DSH_HOME, 'persistent-probe');
  mkdirSync(join(cwd, 'nested'), { recursive: true });
  const setup = async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, 'dscode');
    installModelSelection(agentCtx, { get current() { const config = agent.session.requestHeader()?.config ?? agent.options; return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }; }, assembled: undefined });
  };
  const seen = [];
  let nextTool;
  const childShells = new Set();
  class Adapter extends LlmAdapter {
    async *stream(options) {
      if (JSON.stringify(options.messages[0]).includes('independent permission reviewer')) {
        const request = JSON.parse(options.messages.at(-1).content[0].text);
        assert.equal(request.action.tool, 'shell_retry');
        assert.equal(request.action.cwd, join(cwd, 'nested'));
        assert(request.action.environment.includes('fresh shell'));
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify({ decision: 'deny', reason: 'Deterministic retry denial' }) } };
        yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      seen.push(options);
      if (options.sessionId && options.sessionId !== sessionId && !options.purpose && !childShells.has(options.sessionId)) {
        childShells.add(options.sessionId);
        nextTool = { name: 'bash', args: { command: 'printf "CHILD_ENV=%s" "${DSCODE_FIXTURE_VAR-unset}"' } };
      }
      if (nextTool) {
        const tool = nextTool; nextTool = undefined;
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `dscode-${randomUUID()}`, name: tool.name, arguments: JSON.stringify(tool.args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'DSCODE_PERSISTED_ULTRA' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }, { id: 'ultra', name: 'Ultra' }], defaultEffort: 'max' }, context: { contextWindow: 100000 } }; }
  }
  ctx.llm.registerAdapter(['dscode-fixture'], new Adapter());
  const sessionId = `dscode-probe-${randomUUID()}`;
  const handle = await ctx.agents.create({ sessionId, meta: { cwd, agentPreset: 'dscode' }, agentOptions: { provider: 'dscode-fixture', model: 'fixture', reasoningEffort: 'ultra' }, setup });
  const agent = handle.agent;
  const tools = ctx.tools.schemas(agent).map(t => t.name);
  assert(tools.some(name => name.startsWith('mcp__chrome__')), 'First DSCODE agent did not mount Chrome MCP');
  for (const required of ['bash', 'shell_retry', 'skill', 'subagent', 'subagent_fork', 'create_goal']) assert(tools.includes(required), `Missing ${required}`);
  for (const removed of ['read', 'write', 'edit', 'grep', 'glob']) assert(!tools.includes(removed), `Unexpected standalone file tool ${removed}`);
  for (const command of ['compact', 'goal', 'shell']) assert(ctx.commands.find(agent, command), `Missing /${command}`);
  const run = async (name, args, signal = new AbortController().signal) => {
    const result = await ctx.tools.execute({ name, arguments: args, agent, callId: `probe-${randomUUID()}`, signal });
    return JSON.stringify(result);
  };
  const first = await run('bash', { command: "cd nested; export DSCODE_FIXTURE_VAR=survives; printf before > sample.txt" });
  assert(!first.includes('isError":true'), first);
  const second = await run('bash', { command: 'printf "%s\\n" "$PWD" "$DSCODE_FIXTURE_VAR"; cat sample.txt' });
  assert(second.includes('nested') && second.includes('survives') && second.includes('before'), second);
  const bang = await run('bash', { command: "node -e \"if (!Number.isFinite(3)) process.exit(1); console.log('BANG_OK')\"" });
  assert(bang.includes('BANG_OK') && !bang.includes('timed out'), bang);
  const patched = await run('bash', { command: "apply_patch <<'PATCH'\ndiff --git a/sample.txt b/sample.txt\n--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\nPATCH" });
  assert.equal(readFileSync(join(cwd, 'nested/sample.txt'), 'utf8'), 'after', patched);
  const fresh = await run('shell_retry', { command: 'printf "%s\\n" "$PWD" "${DSCODE_FIXTURE_VAR-unset}"', workdir: cwd, description: 'Verify fresh retry shell state' });
  assert(fresh.includes('unset'), fresh);
  const reset = await ctx.commands.execute(agent, '/shell reset', [], new AbortController().signal);
  assert.equal(reset.result.kind, 'success');
  const third = await run('bash', { command: 'printf "%s\\n" "$PWD" "${DSCODE_FIXTURE_VAR-unset}"' });
  assert(third.includes('unset') && !third.includes('/nested'), third);
  const abort = new AbortController();
  const running = run('bash', { command: 'export DSCODE_FIXTURE_VAR=cancelled; sleep 30' }, abort.signal);
  setTimeout(() => abort.abort(), 400);
  await running;
  const afterAbort = await run('bash', { command: 'printf "%s" "${DSCODE_FIXTURE_VAR-unset}"' });
  assert(afterAbort.includes('unset'), afterAbort);
  // The exact existing approval seam must reject a wider fresh-shell call before execution.
  let escalations = 0;
  const dispose = ctx.on('approval/request', (req, next) => {
    if (req.agent !== agent || req.toolName !== 'shell_retry') return next();
    escalations++;
    return Promise.resolve('rejected');
  }, { prepend: true });
  ctx.permissionPresets.apply(agent.session, 'ask');
  nextTool = { name: 'shell_retry', args: { command: 'touch MUST_NOT_EXIST', workdir: cwd, description: 'Verify denied escalation cannot execute', sandbox_permissions: 'danger-full-access', justification: 'Deterministic approval denial fixture' } };
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Test that the approval gate denies the fixture.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(escalations, 1, JSON.stringify(agent.session.snapshotEvents().filter(e => e.type === 'tool/result')));
  assert(!existsSync(join(cwd, 'MUST_NOT_EXIST')));
  dispose();
  ctx.permissionPresets.apply(agent.session, 'auto');
  nextTool = { name: 'shell_retry', args: { command: 'touch MUST_NOT_EXIST_AUTO', workdir: 'nested', description: 'Verify automatic review binds workdir', sandbox_permissions: 'danger-full-access', justification: 'Deterministic automatic review fixture' } };
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise automatic review on the retry fixture.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const audit = auditStore(join(process.env.DSH_HOME, 'auto-review')).read(sessionId);
  assert.equal(audit.at(-1)?.decision, 'deny');
  assert(!existsSync(join(cwd, 'nested/MUST_NOT_EXIST_AUTO')));
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Persist the ultra selection.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(agent.session.requestHeader().config.reasoningEffort, 'ultra');
  assert.equal(seen.at(-1).reasoningEffort, 'ultra');
  await run('bash', { command: 'export DSCODE_FIXTURE_VAR=parent_only' });
  nextTool = { name: 'subagent', args: { description: 'Verify isolated child shell', prompt: 'Run the isolated shell fixture and finish.', run_in_background: false } };
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Delegate the isolated child fixture.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert(childShells.size > 0, 'No real child agent ran');
  assert(seen.some(o => o.sessionId !== sessionId && JSON.stringify(o.messages).includes('CHILD_ENV=unset')), 'Child inherited parent shell state');
  assert(seen.filter(o => childShells.has(o.sessionId) && !o.purpose).every(o => o.reasoningEffort === 'ultra'), 'Child lost ultra selection');
  for (const [tool, effort] of [['subagent', 'low'], ['subagent_fork', 'high']]) {
    const before = seen.length;
    const result = await run(tool, { description: 'Verify child effort', prompt: 'Finish the local fixture.', reasoning_effort: effort, run_in_background: false });
    assert(!result.includes('"isError":true'), result);
    const calls = seen.slice(before).filter(o => childShells.has(o.sessionId) && !o.purpose);
    assert(calls.length > 0, 'Missing child call');
    assert(calls.every(o => o.reasoningEffort === effort), 'Child did not use requested effort');
    assert(calls.every(o => o.provider === 'dscode-fixture' && o.model === 'fixture'), 'Effort-only choice changed model');
    assert.equal(agent.session.requestHeader().config.reasoningEffort, 'ultra');
  }
  const beforeInvalid = childShells.size;
  const invalid = await run('subagent', { description: 'Reject invalid effort', prompt: 'Must not execute.', reasoning_effort: 'invalid-effort', run_in_background: false });
  assert(invalid.includes('isError') || invalid.includes('unsupported'), invalid);
  assert.equal(childShells.size, beforeInvalid);

  assert((await run('bash', { command: 'printf "%s" "$DSCODE_FIXTURE_VAR"' })).includes('parent_only'));
  const compacted = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal);
  assert.equal(compacted.result.kind, 'success', compacted.result.text);
  const chromeTools = await ctx.commands.execute(agent, '/mcp tools mcp-chrome', [], new AbortController().signal);
  assert.equal(chromeTools.result.kind, 'success', chromeTools.result.text);
  assert(chromeTools.result.text.includes('mcp__chrome__'), 'Chrome tools are missing from /mcp');
  for (const action of ['disable', 'enable', 'reconnect']) {
    const result = await ctx.commands.execute(agent, `/mcp ${action} mcp-chrome`, [], new AbortController().signal);
    assert.equal(result.result.kind, 'success', result.result.text);
    const count = ctx.tools.schemas(agent).filter(tool => tool.name.startsWith('mcp__chrome__')).length;
    assert.equal(count > 0, action !== 'disable', `/mcp ${action} did not update the Chrome tool catalog`);
  }
  assert.equal(agent.session.requestHeader().config.reasoningEffort, 'ultra');
  await ctx.sessions.flush(agent.session);
  await handle.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, setup });
  assert.equal(resumed.agent.session.header.agentPreset, 'dscode');
  assert.equal(resumed.agent.session.requestHeader().config.reasoningEffort, 'ultra');
  resumed.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue.' }], source: { kind: 'user' } }));
  await resumed.agent.whenIdle();
  assert.equal(seen.at(-1).reasoningEffort, 'ultra');
  await resumed.dispose();
  return { tools, persistentCwdAndEnv: 'passed', patchViaShell: 'passed', resetAndCancellation: 'passed', freshRetryAndApprovalDenial: 'passed', ultraSessionResume: 'passed', childShellIsolation: 'passed', childEffortSelection: 'spawn low, fork high, inheritance and invalid effort passed', manualCompaction: 'passed' };
}
