// One owned unattended run, independent of the process that hosts it. The caller
// owns admission/leases and persists the final run record; this module owns only
// its Agent, goal, listeners and deadline.
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { openTriggerSession } from './session.mjs';
import { decideStop } from './run.mjs';
import { writeRunTail } from './log.mjs';
import { sessionSpend } from '../session-metrics/view.mjs';
import { markUnattended } from './unattended.mjs';

function splitRoute(value) {
  const at = value.indexOf('/');
  if (at <= 0 || at === value.length - 1) throw Error(`model expects provider/model, got ${value}`);
  return [value.slice(0, at), value.slice(at + 1)];
}

/** Starts input after setup; done settles only after the owned Agent is drained. */
export async function startTriggerSession(ctx, { spec, home, spend = sessionSpend, signal, prepare }) {
  signal?.throwIfAborted();
  const selection = ctx.agentDefaultModel.currentSelection();
  const [provider, model] = spec.model ? splitRoute(spec.model) : [selection.provider, selection.model];
  const effort = spec.effort ?? selection.reasoningEffort;
  const agentOptions = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
  const setup = async (scope, agent) => {
    await ctx.agentPresets.mount(scope, spec.preset ?? 'dscode');
    await prepare?.(scope, agent);
  };
  const handle = await openTriggerSession(ctx, spec, { home, agentOptions, setup, signal });
  const agent = handle.agent, session = agent.session;
  const unmark = markUnattended(agent);
  const disposers = [];
  let timer, finished = false, approvalsRejected = false, lastText = '';
  const cleanup = () => { clearTimeout(timer); for (const dispose of disposers.splice(0)) dispose(); };
  try {
    signal?.throwIfAborted();
    if (spec.permission) {
      ctx.permissionPresets.resolve(spec.permission);
      ctx.permissionPresets.set(session, spec.permission);
    }
    const previous = ctx.goals.get(agent);
    if (previous) ctx.goals.clear(agent, { id: previous.id, revision: previous.revision });
    const initialCost = spend(session.id).cost;
    const runCost = () => {
      try {
        const total = spend(session.id).cost;
        return Number.isFinite(initialCost) && Number.isFinite(total) ? Math.max(0, total - initialCost) : undefined;
      } catch { return undefined; }
    };
    ctx.goals.create(agent, { objective: spec.goal.objective, maxGoalRounds: spec.goal.maxRounds });
    const completion = Promise.withResolvers();
    // Callers receive the promise after setup; avoid a premature rejection warning.
    void completion.promise.catch(() => {});
    const finish = result => {
      if (finished) return completion.promise;
      finished = true;
      cleanup();
      void (async () => {
        try {
          // Cancelling only this Agent stops queued goal continuations too.
          agent.cancel({ kind: 'user' });
          await agent.whenIdle();
          if (lastText.trim()) {
            try { writeRunTail(home, spec.triggerId, spec.runId, lastText); } catch { /* the caller still receives the result */ }
          }
          await ctx.sessions.flush(session);
          await handle.dispose();
          completion.resolve({ ...result, sessionId: session.id });
        } catch (error) {
          await handle.dispose().catch(() => {});
          completion.reject(error);
        } finally { unmark(); }
      })();
      return completion.promise;
    };
    const currentGoal = () => { try { return ctx.goals.get(agent); } catch { return undefined; } };
    const numbers = () => ({ cost: runCost() ?? null, rounds: currentGoal()?.roundsStarted ?? null });
    const observe = (event, callback) => disposers.push(ctx.on(event, callback));
    observe('session/event', (subject, event) => {
      if (subject.id !== session.id || finished) return;
      if (event.type === 'assistant/message') {
        const text = (event.data.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
        if (text) lastText = text;
      } else if (event.type === 'turn/end') {
        const decision = decideStop({ goal: currentGoal(), costUsd: runCost(), limits: spec.limits, approvalsRejected });
        if (decision.stop) void finish({ outcome: decision.outcome, reason: decision.reason ?? null, exitCode: decision.exitCode, ...numbers() });
      }
    });
    observe('session/disposed', subject => {
      if (subject.id === session.id) void finish({ outcome: 'failed', reason: 'model_error', exitCode: 1, ...numbers() });
    });
    const owns = candidate => {
      const seen = new Set();
      while (candidate && !seen.has(candidate.id)) {
        if (candidate.id === agent.id) return true;
        seen.add(candidate.id);
        const parent = candidate.session?.header.parentSession;
        candidate = parent ? ctx.agents.get(parent) : undefined;
      }
      return false;
    };
    observe('approval/request', (request, next) => {
      if (!owns(request.agent)) return next();
      approvalsRejected = true;
      return 'rejected';
    });
    const cancel = () => finish({ outcome: 'failed', reason: 'interrupted', exitCode: 130, ...numbers() });
    if (signal) {
      const abort = () => { void cancel(); };
      signal.addEventListener('abort', abort, { once: true });
      disposers.push(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    }
    const seconds = spec.limits?.timeoutSeconds;
    if (!finished && Number.isFinite(seconds) && seconds > 0) {
      timer = setTimeout(() => { void finish({ outcome: 'timedout', reason: approvalsRejected ? 'approval_required' : 'timeout', exitCode: 124, ...numbers() }); }, seconds * 1000);
      timer.unref();
    }
    if (!finished) agent.followup(createUserMessage({ content: [{ type: 'text', text: spec.prompt }], source: { kind: 'user' } }));
    return { agent, done: completion.promise, cancel };
  } catch (error) {
    cleanup();
    try { await handle.dispose(); } finally { unmark(); }
    throw error;
  }
}
