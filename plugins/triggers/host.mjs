// Host-side half of one trigger run: the clean session an event starts. Unlike
// `dscode exec`, which runs exactly one turn, this one keeps going while the
// goal is active — the round driver supplies the continuation — and stops on the
// goal's own end, a cap, the timeout, or a needed approval.
//
// It owns the agent, the goal and the transcript; the parent process owns the
// lock, the limits and the run record. The two swap files: `DSCODE_TRIGGER_OPTIONS`
// in, `<options>.result.json` out.
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { decideStop } from './run.mjs';
import { readRunSpec, writeRunResult } from './options.mjs';
import { writeRunTail } from './log.mjs';
import { sessionSpend } from '../session-metrics/view.mjs';
import { triggerOverlay } from './overlay.mjs';

export { triggerOverlay };

export const name = 'dscode-trigger-host';
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'llm', 'goals', 'appExit'];

export function apply(ctx) {
  void run(ctx).catch(error => { process.stderr.write(`dscode trigger run: ${error.message}\n`); ctx.get('appExit')(1); });
}

function splitRoute(value) {
  const at = value.indexOf('/');
  if (at <= 0 || at === value.length - 1) throw new Error(`model expects provider/model, got ${value}`);
  return [value.slice(0, at), value.slice(at + 1)];
}

async function run(ctx) {
  await ctx.get('loader').await();
  const optionsPath = process.env.DSCODE_TRIGGER_OPTIONS;
  if (!optionsPath) throw new Error('DSCODE_TRIGGER_OPTIONS is missing');
  const spec = readRunSpec(optionsPath);
  const resultPath = `${optionsPath}.result.json`;

  const selection = ctx.agentDefaultModel.currentSelection();
  const [provider, model] = spec.model ? splitRoute(spec.model) : [selection.provider, selection.model];
  const effort = spec.effort ?? selection.reasoningEffort;
  const agentOptions = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, spec.preset ?? 'dscode'); };

  const handle = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd: spec.workspace, agentPreset: spec.preset ?? 'dscode' },
    agentOptions,
    setup,
  });
  const agent = handle.agent;
  const session = agent.session;
  if (spec.permission) {
    ctx.permissionPresets.resolve(spec.permission);
    ctx.permissionPresets.set(session, spec.permission);
  }

  // The goal is created through the SERVICE, not the `create_goal` tool: the tool
  // requires a direct human turn, and an unattended run has none. The service is
  // the same path the human-facing /goal command uses.
  ctx.goals.create(agent, { objective: spec.goal.objective, maxGoalRounds: spec.goal.maxRounds });

  let finished = false;
  let approvalsRejected = false;
  let lastText = '';
  const limiter = spec.limits ?? {};

  const finish = (result, tail) => {
    if (finished) return;
    finished = true;
    if (tail !== undefined && tail.trim() !== '') {
      try { writeRunTail(process.env.DSH_HOME ?? '.', spec.triggerId, spec.runId, tail); } catch { /* the record still explains the run */ }
    }
    try {
      writeRunResult(resultPath, { ...result, sessionId: session.id });
    } catch (error) {
      process.stderr.write(`dscode trigger run: could not write the result file: ${error.message}\n`);
    }
    ctx.get('appExit')(result.exitCode);
  };

  /** Read durable goal state plus recorded spend, and stop if the run is over. */
  const evaluate = () => {
    if (finished) return;
    let goal;
    try { goal = ctx.goals.get(agent); } catch { goal = undefined; }
    let costUsd;
    try { costUsd = sessionSpend(session.id).cost; } catch { costUsd = undefined; }
    const decision = decideStop({ goal, costUsd, limits: limiter, approvalsRejected });
    if (!decision.stop) return;
    finish({
      outcome: decision.outcome,
      reason: decision.reason ?? null,
      exitCode: decision.exitCode,
      cost: Number.isFinite(costUsd) ? costUsd : null,
      rounds: Number.isFinite(goal?.roundsStarted) ? goal.roundsStarted : null,
    }, lastText);
  };

  ctx.on('session/event', (subject, event) => {
    if (subject.id !== session.id) return;
    if (event.type === 'assistant/message') {
      const text = (event.data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
      if (text !== '') lastText = text;
      return;
    }
    // The goal round driver continues after a turn; only the goal's own state
    // (or a cap) ends the run, so this is a check, not a completion signal.
    if (event.type === 'turn/end') evaluate();
  });
  ctx.on('session/disposed', source => {
    if (source.id !== session.id) return;
    finish({ outcome: 'failed', reason: 'model_error', exitCode: 1, cost: null, rounds: null }, lastText);
  });
  // No human is present: an approval request is refused, and the run is marked
  // as having needed one so the operator sees it in the record.
  ctx.on('approval/request', (request, next) => {
    if (request.agent?.id !== agent.id) return next();
    approvalsRejected = true;
    process.stderr.write(`approval needed for ${request.toolName}: rejected (a triggered run has no human to ask)\n`);
    return 'rejected';
  });

  if (Number.isFinite(limiter.timeoutSeconds) && limiter.timeoutSeconds > 0) {
    setTimeout(() => {
      const goal = (() => { try { return ctx.goals.get(agent); } catch { return undefined; } })();
      finish({
        outcome: 'timedout',
        reason: approvalsRejected ? 'approval_required' : 'timeout',
        exitCode: 124,
        cost: (() => { try { return sessionSpend(session.id).cost; } catch { return null; } })(),
        rounds: Number.isFinite(goal?.roundsStarted) ? goal.roundsStarted : null,
      }, lastText);
    }, limiter.timeoutSeconds * 1000).unref();
  }

  agent.followup(createUserMessage({ content: [{ type: 'text', text: spec.prompt }], source: { kind: 'user' } }));
}
