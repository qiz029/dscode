import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { auditStore } from '../plugins/auto-review/audit.mjs';
import * as review from '../plugins/auto-review/index.mjs';
import { REVIEW_POLICY } from '../plugins/auto-review/policy.mjs';
import { readMetrics } from '../plugins/session-metrics/store.mjs';
import { currentCharge } from '../plugins/session-metrics/attribution.mjs';
import { desktopMetricsRequest } from '../plugins/session-metrics/desktop-host.mjs';
import { createServer } from 'node:http';
import * as jev from '../plugins/jev/index.mjs';

export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'approval', 'permissionPresets', 'sessions', 'commands'];
export function apply(ctx) { void run(ctx).catch(error => {
  console.error(error.stack);
  if (process.env.DSCODE_REVIEW_ELECTRON) process.send({ type: 'dscode-review-failed' }); else ctx.get('appExit')(1);
}); }
async function run(ctx) {
  await ctx.get('loader').await();
  const home = process.env.DSH_HOME, phase = process.env.DSCODE_REVIEW_PHASE;
  const queue = [], results = [], reviewerRequests = [], humanRequests = [], executed = [];
  const audit = auditStore(join(home, 'auto-review'));
  let verdict = 'allow', humanOutcome = 'rejected', reviewerStarted;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      if (options.messages[0]?.content?.some(block => block.type === 'text' && block.text === REVIEW_POLICY)) {
        assert.equal(options.sessionId, undefined, 'Reviewer must not carry the root wire session identity');
        assert.equal(options.purpose, 'review');
        assert.deepEqual(currentCharge(), { sessionId: 'desktop-review', purpose: 'review' });
        assert.equal(desktopMetricsRequest(ctx, { action: 'status', sessionId: 'desktop-review' }).requestActive, false,
          'Auxiliary review must not mark the main model request active');
        reviewerRequests.push(options);
        assert.equal(options.tools?.length ?? 0, 0, 'Reviewer must not receive executable tools');
        if (verdict === 'wait') {
          reviewerStarted();
          await new Promise((resolve, reject) => {
            if (options.signal.aborted) reject(options.signal.reason);
            else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          });
        }
        const text = verdict === 'malformed' ? 'not a verdict' : JSON.stringify({ decision: verdict, reason: 'Scripted fixture verdict.' });
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      if (queue.length) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: 'desktop_review_fixture', arguments: JSON.stringify({ marker: queue.shift() }) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local approval fixture complete.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  // Custom routes deliberately bypass the optional external Jev backend.
  ctx.llm.registerAdapter(['custom-desktop-review-fixture'], new Adapter());
  const setup = async (scope, agent) => { await ctx.agentPresets.mount(scope, 'dscode');
    installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }); };
  const handle = phase === 'generate' ? await ctx.agents.create({ sessionId: 'desktop-review', meta: { cwd: process.cwd(), agentPreset: 'dscode' },
    agentOptions: { provider: 'custom-desktop-review-fixture', model: 'fixture' }, setup }) : await ctx.agents.resume({ resumeSessionId: 'desktop-review', setup });
  const agent = handle.agent;
  const reviewsBefore = readMetrics(home, agent.id).rows.filter(row => row.kind === 'start' && row.purpose === 'review').length;
  const verifyReviewMetrics = () => {
    const starts = readMetrics(home, agent.id).rows.filter(row => row.kind === 'start' && row.purpose === 'review');
    assert.equal(starts.length - reviewsBefore, reviewerRequests.length, 'Every reviewer attempt must remain charged to the owner');
    assert.equal(desktopMetricsRequest(ctx, { action: 'status', sessionId: agent.id }).currentTps, null,
      'Scripted main calls have no usage; review output must not supply their speed');
  };
  ctx.tools.register(defineTool({ name: 'desktop_review_fixture', description: 'Write an isolated approval fixture marker.',
    parameters: { marker: { type: 'string', required: true } },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: () => [] },
    execute: args => { executed.push(args.marker); writeFileSync(join(home, 'review-executed.json'), JSON.stringify(executed)); return { marker: args.marker }; },
  }));
  ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'desktop_review_fixture'
    ? { kind: 'ask', reason: `Write local fixture marker: ${exec.arguments.marker}. The marker is confined to the disposable test profile.` } : next());
  if (process.env.DSCODE_REVIEW_UI) {
    // Keep the normal packaged reviewer and remote answerer in their original
    // order. Only the renderer can answer these two human fallbacks.
    ctx.permissionPresets.set(agent.session, 'auto-review'); verdict = 'human';
    console.log('DESKTOP_REVIEW_UI_READY ' + JSON.stringify({ home, sessionId: agent.id }));
    for (const [marker, outcome] of [['Reject this fixture marker', 'rejected'], ['Allow this fixture marker', 'allowed-once']]) {
      queue.push(marker);
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: marker + '. This is an isolated Desktop approval interaction test.' }] }));
      await agent.whenIdle();
      assert.equal(agent.session.snapshotEvents().findLast(event => event.type === 'approval/decided')?.data.outcome, outcome);
      assert.equal(executed.includes(marker), outcome === 'allowed-once');
      console.log('DESKTOP_REVIEW_UI_STEP ' + JSON.stringify({ marker, outcome, executed: [...executed] }));
    }
    assert.equal(reviewerRequests.length, 2);
    assert.equal(audit.read(agent.id).filter(row => row.decision === 'human').length, 2);
    verifyReviewMetrics();
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'review-executed.json'), 'utf8')), ['Allow this fixture marker']);
    await ctx.sessions.flush(agent.session);
    console.log('DESKTOP_REVIEW_PASSED ' + JSON.stringify({ phase: 'renderer', nativeRemoteApproval: true,
      noSubstituteAnswerer: true, humanRejectedNoWrite: true, humanAllowedOneWrite: true, durableAudit: true,
      auxiliaryReviewAttribution: true, rootSpeedIsolated: true }));
    return;
  }
  // The production automatic reviewer gets first refusal. Only its human fallback reaches this fixture.
  ctx.on('approval/request', (req, next) => {
    if (req.agent !== agent || req.toolName !== 'desktop_review_fixture') return next();
    humanRequests.push(req); return Promise.resolve(humanOutcome);
  }, { prepend: true });
  ctx.on('tools/result', (exec, result) => { if (exec.agent === agent && exec.name === 'desktop_review_fixture') results.push(result); });
  // The Web remote answerer waits for a connected renderer. Put the isolated
  // human substitute ahead of it, then remount the unchanged production review
  // plugin so its prepended handler still runs before that substitute.
  await [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-auto-review').fiber.dispose();
  let reviewer = ctx.plugin(review, { timeoutMs: 30000, maxOutputTokens: 4096, maxReviewsPerTurn: 20 }); await reviewer;
  const start = marker => {
    queue.push(marker);
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `Exercise the local marker fixture: ${marker}.` }] }));
    return agent.whenIdle();
  };
  const perform = async (marker, expected, reviewCount, humanCount) => {
    const before = [executed.length, reviewerRequests.length, humanRequests.length, results.length];
    await start(marker);
    assert.equal(executed.length - before[0], expected ? 1 : 0, marker);
    assert.equal(reviewerRequests.length - before[1], reviewCount, marker + ' reviewer count');
    assert.equal(humanRequests.length - before[2], humanCount, marker + ' human count');
    assert.equal(results.length - before[3], 1, marker + ' result');
    assert.equal(results.at(-1).isError === true, !expected, marker + ' outcome');
  };
  try {
    if (phase !== 'generate') {
      const old = JSON.parse(readFileSync(join(home, 'review-audit.json'), 'utf8'));
      assert.deepEqual(audit.read(agent.id).slice(0, old.length), old);
      assert(audit.read(agent.id).some(row => row.source === 'jev' && row.usage?.input_tokens === 100), 'Historical Jev usage must survive restart');
      assert(audit.read(agent.id).some(row => row.source === 'jev' && row.usage?.input_tokens === '50'), 'Malformed history must remain readable without rewriting');
      assert(agent.session.snapshotEvents().some(event => event.type === 'approval/decided' && event.data.outcome === 'rejected'));
    }
    const initialMode = ctx.permissionPresets.current(agent.session);
    ctx.permissionPresets.set(agent.session, 'auto-review');
    verdict = 'allow'; await perform('allowed-' + phase, true, 1, 0);
    verdict = 'deny'; await perform('denied-' + phase, false, 1, 0);
    verdict = 'human'; await perform('human-' + phase, false, 1, 1);
    verdict = 'malformed'; await perform('malformed-' + phase, false, 1, 1);
    humanOutcome = 'allowed-once'; await perform('human-approved-' + phase, true, 1, 1); humanOutcome = 'rejected';
    verdict = 'wait';
    const started = new Promise(resolve => { reviewerStarted = resolve; });
    const pending = start('cancelled-' + phase); await started;
    agent.cancel({ kind: 'user', reason: 'Cancel the isolated review fixture.' }); await pending;
    assert(!executed.includes('cancelled-' + phase));
    assert.equal(audit.read(agent.id).at(-1).decision, 'cancelled');
    verdict = 'deny';
    const beforeRepeated = [reviewerRequests.length, humanRequests.length, executed.length, results.length];
    const repeated = 'repeated-denial-' + phase;
    queue.push(repeated, repeated, repeated); await start(repeated);
    assert.deepEqual(queue, [repeated], 'Third denial must stop the turn before the fourth model step'); queue.length = 0;
    assert.equal(reviewerRequests.length - beforeRepeated[0], 1, 'Repeated denied action must not call the model again');
    assert.equal(humanRequests.length, beforeRepeated[1]); assert.equal(executed.length, beforeRepeated[2]);
    assert.equal(results.length - beforeRepeated[3], 3);
    assert(audit.read(agent.id).slice(-2).every(row => row.reason === 'Identical action already denied with no new user instruction.'));
    verdict = 'allow'; await perform('new-user-turn-' + phase, true, 1, 0);
    ctx.permissionPresets.set(agent.session, 'danger-full-access');
    await perform('never-' + phase, false, 0, 0);
    ctx.permissionPresets.set(agent.session, 'workspace-write');
    verdict = 'allow'; await perform('ordinary-ask-' + phase, false, 0, 1);
    if (phase === 'unload') {
      ctx.permissionPresets.set(agent.session, 'auto-review');
      await reviewer.dispose();
      await perform('unloaded', false, 0, 1);
      reviewer = ctx.plugin(review, { timeoutMs: 30000, maxOutputTokens: 4096, maxReviewsPerTurn: 20 }); await reviewer;
      await perform('reloaded', true, 1, 0);
    }
    const records = audit.read(agent.id);
    for (const decision of ['allow', 'deny', 'human', 'cancelled']) assert(records.some(record => record.decision === decision));
    assert(records.some(record => record.decision === 'allow' && record.usageComplete && record.usage.outputTokens === 5));
    verifyReviewMetrics();
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'review-executed.json'), 'utf8')), executed);
    // Exercise the separate Decisions HTTP transport, which bypasses llm.stream.
    let requests = 0, unknown = false;
    const server = createServer((req, res) => {
      assert.equal(req.url, '/api/alpha/decisions'); assert.equal(req.method, 'POST');
      assert.equal(req.headers.authorization, 'Bearer local-jev-fixture');
      req.resume(); requests++;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ model: 'typesafe/jev-fixture', answers: {},
        usage: { input_tokens: 42, output_tokens: 0, ...(unknown ? {} : { cost: 0.000025 }) } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let decisions;
    try {
      await [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-jev').fiber.dispose();
      await ctx.get('credentials').set('OPENROUTER_API_KEY', 'local-jev-fixture');
      decisions = ctx.plugin(jev, { endpoint: `http://127.0.0.1:${server.address().port}` }); await decisions;
      const initialCost = desktopMetricsRequest(ctx, { action: 'status', sessionId: agent.id }).cost;
      for (const missing of [false, true]) {
        unknown = missing;
        assert.equal(await ctx.get('jev').approval({ sessionId: agent.id, action: { tool: 'fixture' }, context: { userMessages: [{ text: 'Check the local Decisions fixture.' }] } }), undefined);
        const rows = readMetrics(home, agent.id).rows, last = rows.at(-1);
        assert.equal(last.source, 'jev'); assert.equal(last.purpose, 'review'); assert.equal(last.kind, 'end');
        assert.deepEqual(last.usage, { inputTokens: 42, outputTokens: 0 });
        assert.equal(last.cost, missing ? null : 0.000025);
      }
      assert.equal(requests, 2);
      const projected = desktopMetricsRequest(ctx, { action: 'status', sessionId: agent.id });
      assert(Math.abs(projected.cost - initialCost - 0.000025) < 1e-12); assert.equal(projected.partial, true);
      assert.equal(projected.currentTps, null); assert.equal(projected.requestActive, false);
    } finally {
      await decisions?.dispose(); await ctx.get('credentials').unset('OPENROUTER_API_KEY');
      await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    }
    const usageCommand = async () => {
      const result = (await ctx.commands.execute(agent, '/review-usage', [], AbortSignal.timeout(10000)))?.result;
      assert.equal(result.kind, 'success');
      const tokens = result.text.match(/(\d+) input \/ (\d+) output/);
      const incomplete = result.text.match(/(\d+) attempts with incomplete\/unknown usage/);
      assert(tokens && incomplete); return { input: Number(tokens[1]), output: Number(tokens[2]), incomplete: Number(incomplete[1]) };
    };
    const beforeHistory = await usageCommand();
    // Synthetic historical rows retain the original Decisions API field names.
    const historical = { provider: 'openrouter', source: 'jev', model: 'fixture', decision: 'allow', usageComplete: true };
    audit.append(agent.id, { ...historical, usage: { input_tokens: 100, output_tokens: 0 } });
    audit.append(agent.id, { ...historical, usage: { input_tokens: '50', output_tokens: -1 } });
    assert.deepEqual(await usageCommand(), { input: beforeHistory.input + 100, output: beforeHistory.output, incomplete: beforeHistory.incomplete + 1 });
    if (phase === 'generate') writeFileSync(join(home, 'review-audit.json'), JSON.stringify(records));
    ctx.permissionPresets.set(agent.session, initialMode);
    await ctx.sessions.flush(agent.session);
    console.log('DESKTOP_REVIEW_PASSED ' + JSON.stringify({ phase, nativeToolAndApprovalChain: true,
      exactLocalSideEffects: true, allowAndDeny: true, humanAndMalformedFallback: true, cancellation: true,
      neverRejectsApproval: true, ordinaryModePreserved: true, durableAuditAndUsage: true,
      repeatedDenialStopsTurn: true, newUserTurnResetsDenials: true,
      auxiliaryReviewAttribution: true, rootSpeedIsolated: true,
      decisionsHttpLedger: true, missingDecisionsCostPartial: true,
      historicalJevUsageCommand: true,
      ...(phase !== 'generate' ? { auditAndApprovalSurviveRestart: true } : {}), ...(phase === 'unload' ? { unloadReload: true } : {}) }));
  } finally { await reviewer.dispose(); await handle.dispose(); }
  if (process.env.DSCODE_REVIEW_ELECTRON) process.send({ type: 'dscode-review-shutdown' }); else ctx.get('appExit')(0);
}
