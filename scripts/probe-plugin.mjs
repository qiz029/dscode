// Runs inside the real composed Harness. No remote model request or UI action.
import assert from 'node:assert/strict';
import { readMetrics } from '../plugins/session-metrics/store.mjs';
import { summarize } from '../plugins/session-metrics/view.mjs';
import { probeDscode } from './dscode-probe.mjs';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serviceForAgent } from '@deepseek-ai/dsh-agent-presets';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { auditStore } from '../plugins/auto-review/audit.mjs';

export const name = 'tui-harness-probe';
export const inject = ['agents', 'agentPresets', 'tools', 'skills', 'sessions', 'commands', 'computerUse', 'llm', 'permissionPresets'];

// Deterministic adapter tests real Agent/tool/persistence plumbing without
// network inference or credentials. It is only mounted by the doctor overlay.
class FixtureAdapter extends LlmAdapter {
  cursor = 0;
  constructor(file) { super(); this.file = file; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }, context: { contextWindow: 100000 } }; }
  async *stream(options) {
    options.signal?.throwIfAborted();
    if (options.messages.at(-1)?.source?.plugin === 'dscode-doctor') {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture diagnosis: no confirmed runtime failure.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (JSON.stringify(options.messages[0]).includes('independent permission reviewer')) {
      assert.equal(options.tools, undefined, 'Reviewer must not receive tools');
      const request = JSON.parse(options.messages.at(-1).content[0].text);
      const scenario = request.action.arguments.scenario;
      assert(request.context.userMessages.length > 0, 'Reviewer must receive direct user context');
      const text = scenario === 'invalid' ? 'not JSON' : JSON.stringify({ decision: scenario === 'deny' ? 'deny' : 'allow', reason: `Fixture ${scenario}` });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const calls = [
      ['write', { file_path: this.file, content: 'harness smoke: before\n' }],
      ['read', { file_path: this.file }],
      ['edit', { file_path: this.file, old_string: 'before', new_string: 'after' }],
      ['read', { file_path: this.file }],
      ['skill', { name: 'computer-use' }],
      ['bash', { command: 'printf HARNESS_SHELL_OK', description: 'Verify the confined shell execution path' }],
      ['mcp__fixture__action', { scenario: 'allow' }],
      ['mcp__fixture__action', { scenario: 'deny' }],
      ['mcp__fixture__action', { scenario: 'invalid' }],
    ];
    const sequence = options.model === 'hook-block' ? [['bash', { command: 'printf HARNESS_HOOK_BLOCK', description: 'Test native hook denial' }]] : options.model === 'deny-loop' ? Array.from({ length: 4 }, () => ['mcp__fixture__action', { scenario: 'deny' }]) : calls;
    const next = options.purpose ? undefined : sequence[this.cursor++];
    const block = next
      ? { type: 'tool-call', id: `fixture-${this.cursor}`, name: next[0], arguments: JSON.stringify(next[1]) }
      : { type: 'text', text: options.purpose === 'compaction' ? 'Fixture: file edited from before to after; Computer Use skill loaded; continue verification.' : 'HARNESS_FIXTURE_COMPLETE' };
    yield { type: 'block-start', index: 0, blockType: block.type };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: next ? 'tool-calls' : 'stop' } };
  }
}

export function apply(ctx) {
  void probe(ctx).catch(error => {
    console.error(error.stack);
    ctx.get('appExit')(1);
  });
}

async function probe(ctx) {
  await ctx.get('loader').await();
  const sessionId = `harness-probe-${randomUUID()}`;
  const fixtureFile = join(process.env.DSH_HOME, `${sessionId}.txt`);
  ctx.llm.registerAdapter(['harness-fixture'], new FixtureAdapter(fixtureFile));
  const executed = [];
  let humanFallbacks = 0;
  ctx.tools.register(defineTool({
    name: 'mcp__fixture__action', description: 'Local approval integration fixture; no external effects.',
    parameters: { scenario: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async args => { executed.push(args.scenario); return args.scenario; },
  }));
  ctx.on('approval/request', (req, next) => {
    if (req.toolName !== 'mcp__fixture__action') return next();
    humanFallbacks++;
    return Promise.resolve('allowed-once');
  });
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard'); };
  const handle = await ctx.agents.create({
    sessionId, meta: { cwd: process.cwd(), agentPreset: 'standard' },
    agentOptions: { provider: 'harness-fixture', model: 'fixture' }, setup,
  });
  const agent = handle.agent;
  ctx.permissionPresets.apply(agent.session, 'auto');
  await agent.whenIdle();
  const tools = ctx.tools.schemas(agent).map(tool => tool.name);
  const commands = ctx.commands.list(agent).map(command => command.name);
  assert(tools.includes('skill'), 'Skill tool did not mount');
  assert(tools.includes('computer_use_activate'), 'Computer Use consumer did not mount');
  assert(commands.includes('compact'), 'Compact command did not mount');
  for (const name of ['status', 'doctor', 'mcp', 'skills', 'hooks']) {
    assert(commands.includes(name), `${name} command did not mount`);
    const execution = await ctx.commands.execute(agent, `/${name}`, [], new AbortController().signal);
    assert.equal(execution.result.kind, 'success', `${name}: ${execution.result.text}`);
    assert(execution.result.text.length > 0);
    if (name === 'doctor') assert.match(execution.result.text, /Fixture diagnosis: no confirmed runtime failure/);
  }
  for (const line of ['/skills conflicts', '/hooks reload']) {
    const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal);
    assert.equal(execution.result.kind, 'success', `${line}: ${execution.result.text}`);
  }

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the local harness fixture.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(readFileSync(fixtureFile, 'utf8'), 'harness smoke: after\n');
  const events = agent.session.snapshotEvents();
  const outcomes = events.filter(event => event.type === 'tool/result');
  assert.equal(outcomes.length, 9, 'Expected nine real tool calls through the Agent loop');
  assert(outcomes.slice(0, 6).every(event => event.data.message.content.every(block => block.isError !== true)), 'A baseline fixture tool failed');
  assert.deepEqual(executed, ['allow', 'invalid'], 'Denied action must never execute');
  assert.equal(humanFallbacks, 1, 'Only malformed reviewer output should reach the human answerer');
  const reviews = auditStore(join(process.env.DSH_HOME, 'auto-review')).read(sessionId);
  assert.deepEqual(reviews.map(e => e.decision), ['allow', 'deny', 'human']);
  assert(reviews.every(e => e.usage?.inputTokens === 100), 'Reviewer usage must be recorded separately');
  assert(outcomes.some(event => JSON.stringify(event.data).includes('HARNESS_SHELL_OK')), 'Shell did not execute');
  const activatedTools = ctx.tools.schemas(agent).map(tool => tool.name);
  assert(activatedTools.includes('computer_observe'), 'Loading skill did not expose Computer Use execution tools');
  const compact = serviceForAgent(ctx, agent, 'compaction');
  assert(compact, 'Agent-scoped compaction provider missing');
  await ctx.sessions.flush(agent.session);
  const eventCount = agent.session.seq;
  await handle.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: sessionId, setup });
  assert.equal(resumed.agent.session.id, sessionId);
  assert.equal(resumed.agent.session.header.agentPreset, 'standard');
  assert.equal(ctx.permissionPresets.current(resumed.agent.session), 'auto', 'Review mode must survive resume');
  assert.equal(auditStore(join(process.env.DSH_HOME, 'auto-review')).read(resumed.agent.session.id).length, 3, 'Review audit must survive resume');
  assert(resumed.agent.session.seq >= eventCount, 'Durable session lost events');
  assert(resumed.agent.session.snapshotEvents().some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('HARNESS_FIXTURE_COMPLETE')), 'Assistant response did not survive resume');
  assert(ctx.tools.schemas(resumed.agent).some(tool => tool.name === 'computer_observe'), 'Computer Use skill activation did not survive resume');
  await resumed.dispose();
  ctx.llm.registerAdapter(['harness-denial-fixture'], new FixtureAdapter(fixtureFile));
  const stopped = await ctx.agents.create({
    sessionId: `review-stop-${randomUUID()}`, meta: { cwd: process.cwd(), agentPreset: 'standard' },
    agentOptions: { provider: 'harness-denial-fixture', model: 'deny-loop' }, setup,
  });
  ctx.permissionPresets.apply(stopped.agent.session, 'auto');
  stopped.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise the local denial-stop fixture.' }], source: { kind: 'user' } }));
  await stopped.agent.whenIdle();
  const stopReviews = auditStore(join(process.env.DSH_HOME, 'auto-review')).read(stopped.agent.session.id);
  assert.equal(stopReviews.length, 3, 'Circuit breaker must stop before the fourth tool call');
  assert(stopReviews.every(r => r.decision === 'deny'));
  const turnEnd = stopped.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end');
  assert(JSON.stringify(turnEnd).includes('Auto review stopped'), 'Real agent turn was not cancelled by the denial breaker');
  await stopped.dispose();
  rmSync(fixtureFile);
  const hookHandle = await ctx.agents.create({
    sessionId: `hook-probe-${randomUUID()}`, meta: { cwd: process.cwd(), agentPreset: 'standard' },
    agentOptions: { provider: 'harness-hook-fixture', model: 'hook-block' }, setup,
  });
  ctx.llm.registerAdapter(['harness-hook-fixture'], new FixtureAdapter(fixtureFile));
  hookHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Test the hook gate.' }], source: { kind: 'user' } }));
  await hookHandle.agent.whenIdle();
  const hookEvents = hookHandle.agent.session.snapshotEvents();
  assert(hookEvents.some(e => e.type === 'hook/result'), 'Native hook result was not recorded');
  assert(hookEvents.filter(e => e.type === 'tool/result').some(e => JSON.stringify(e.data).includes('HARNESS_HOOK_DENIED')), 'Hook did not block bash with its reason');
  await hookHandle.dispose();
  const ledger = readMetrics(process.env.DSH_HOME, sessionId);
  assert(ledger.rows.some(r => r.kind === 'end' && r.usage?.inputTokens === 100), 'Reviewer usage missing from session cost ledger');
  assert(summarize(ledger.rows).calls >= 13, 'Main and review calls must each be recorded once');
  const dscode = await probeDscode(ctx);
  const report = {
    dscode,
    checkedAt: new Date().toISOString(),
    profileBoot: 'passed', presetActivation: 'passed',
    tuiCommands: 'status-doctor-mcp-skills-hooks passed; native hook denied bash', tools, commands, computerSkillActivation: 'passed',
    compactionProvider: 'mounted', sessionResume: 'passed',
    agentLoopFixture: 'passed', fileWriteReadEdit: 'passed', shellExecution: 'passed', persistedEvents: eventCount,
    autoReview: 'allow-deny-human-fallback-usage-resume-denial-stop passed (local fixture model)',
    computer: ctx.computerUse.status(),
    browserActions: 'not_exercised', modelExecution: 'not_exercised',
  };
  writeFileSync(process.env.DSH_TUI_PROBE_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log('HARNESS_PROBE_PASSED');
  ctx.get('appExit')(0);
}
