import z from '@deepseek-ai/schemastery';
import { BlockAssembler, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm';
import { REVIEW_POLICY, escalationDiagnosticGrant, needsMcpApproval, redact, fingerprint, contextFor, parseDecision } from './policy.mjs';
import { join, resolve } from 'node:path';
import { auditStore } from './audit.mjs';
import { effortFor } from '../providers/effort.mjs';

export const name = 'dscode-auto-review';
export const inject = ['approval', 'permissionPresets', 'tools', 'llm', 'commands'];
export const Config = z.object({
  provider: z.string().default(''), model: z.string().default(''),
  timeoutMs: z.number().min(100).max(120000).default(30000),
  // Reasoning tokens count against the cap: a reasoning model needs room before its verdict.
  maxOutputTokens: z.number().step(1).min(128).max(16384).default(4096),
  maxReviewsPerTurn: z.number().step(1).min(1).max(100).default(20),
  maxEscalationGrantsPerTurn: z.number().step(1).min(0).max(10).default(2),
  auditDirectory: z.string(),
});

export function apply(ctx, config) {
  if (Boolean(config.provider) !== Boolean(config.model)) throw new Error('Auto review requires both provider and model, or neither');
  if (!config.auditDirectory && !process.env.DSH_HOME) throw new Error('Auto review requires DSH_HOME or auditDirectory');
  const audit = auditStore(config.auditDirectory ?? join(process.env.DSH_HOME, 'auto-review'));
  const calls = new WeakMap();
  const budgets = new WeakMap();
  const mode = agent => ctx.permissionPresets.current(agent.session);
  // The preset this plugin reviews for. DSH 0.1.7 reserved `auto` for its own
  // integration, so the reviewed preset carries DSCODE's own name.
  const REVIEWED = 'auto-review';
  const stateFor = agent => {
    const events = agent.session.snapshotEvents();
    const turn = events.findLast(e => e.type === 'turn/start')?.seq;
    let state = budgets.get(agent);
    if (!state || state.turn !== turn) {
      state = { turn, reviews: 0, grants: 0, denials: 0, blocked: false, denied: new Map(), tail: Promise.resolve() };
      budgets.set(agent, state);
    }
    return state;
  };

  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent) {
      let map = calls.get(exec.agent);
      if (!map) calls.set(exec.agent, map = new Map());
      map.set(exec.callId, exec);
    }
    const decision = await next();
    if (decision.kind !== 'allow') return decision;
    if (exec.agent && stateFor(exec.agent).blocked) return { kind: 'deny', reason: 'Automatic review stopped this turn after repeated denials. Wait for user input.' };
    // Under the never policy an ask is rejected before any handler runs, so gating would disable MCP outright.
    if (needsMcpApproval(exec.name) && (!exec.agent || ctx.approval?.effectivePolicy?.(exec.agent.session) !== 'never')) return { kind: 'ask', reason: `Review MCP action ${exec.name} against the user's authorization` };
    return decision;
  }, { prepend: true });
  ctx.on('tools/result', exec => {
    calls.get(exec.agent)?.delete(exec.callId);
    if (exec.agent && budgets.get(exec.agent)?.blocked) exec.agent.cancel({ kind: 'hook', reason: 'Auto review stopped after three consecutive denials.' });
  });

  const announce = (agent, text) => agent.inject(createUserMessage({
    content: [{ type: 'text', text }], source: { kind: name },
  }));
  const record = (req, data) => {
    audit.append(req.agent.session.id, { sessionSeq: req.agent.session.seq, callId: req.callId ?? null, toolName: req.toolName, ...data });
    ctx.logger.info(`auto-review: ${req.toolName}: ${data.decision}; ${data.durationMs ?? 0}ms`);
  };

  async function review(req, next, state) {
    if (req.signal?.aborted) return 'cancelled';
    // A user can switch to ask while a prior review waits in the queue.
    if (mode(req.agent) !== REVIEWED) return ctx.approval?.effectivePolicy?.(req.agent.session) === 'never' ? 'rejected' : next();
    const exec = calls.get(req.agent)?.get(req.callId);
    const fallback = async (reason, details = {}) => {
      record(req, { decision: 'human', reason, ...details });
      announce(req.agent, `Automatic review needs human approval: ${reason}`);
      if (ctx.approval?.effectivePolicy?.(req.agent.session) === 'never') return 'rejected';
      const outcome = await next();
      if (outcome === 'allowed-once') state.denials = 0;
      return outcome;
    };
    if (state.blocked) return 'rejected';
    // One place applies a verdict, whether it came from Jev or from the reviewer
    // model, so the pending-action binding and the strike accounting cannot drift.
    const applyVerdict = (decision, details) => {
      if (req.signal?.aborted) {
        record(req, { decision: 'cancelled', reason: 'Caller cancelled review.', ...details });
        return 'cancelled';
      }
      if (mode(req.agent) !== REVIEWED) return fallback('Permission mode changed while review was pending.', details);
      if (decision.decision === 'human') return fallback(decision.reason, details);
      // Bind approval to the still-pending immutable invocation; no grant cache.
      if (calls.get(req.agent)?.get(req.callId) !== exec || fingerprint(action) !== actionHash) return fallback('Pending action changed during review.', details);
      record(req, { ...decision, ...details });
      if (decision.decision === 'deny') {
        state.denied.set(actionHash, userSeq);
        state.denials++;
        state.blocked = state.denials >= 3;
        announce(req.agent, `Automatic review rejected ${req.toolName}: ${decision.reason}. Do not retry the same outcome via another command or tool. Continue only with a materially safer alternative or ask the user.${state.blocked ? ' Stop this turn: three consecutive denials.' : ''}`);
        return 'rejected';
      }
      // Only an explicit allow runs: `defer` and any future verdict value fall back
      // to the human instead of being read as approval.
      if (decision.decision !== 'allow') return fallback(decision.reason ?? 'Unrecognized review verdict.', details);
      state.denials = 0;
      return 'allowed-once';
    };
    if (!exec || exec.name !== req.toolName) return fallback('Exact pending tool parameters are unavailable.');
    const workspace = req.agent.session.header.cwd;
    const action = { tool: exec.name, arguments: exec.arguments, cwd: exec.name === 'shell_retry' && exec.arguments.workdir ? resolve(workspace ?? process.cwd(), exec.arguments.workdir) : workspace, ...(exec.name === 'shell_retry' ? { environment: 'fresh shell; does not inherit persistent bash state' } : {}) };
    const actionHash = fingerprint(action);
    const userSeq = req.agent.session.snapshotEvents().findLast(e => e.type === 'user/message' && e.data.source?.kind === 'user')?.seq;
    if (state.denied.has(actionHash) && state.denied.get(actionHash) === userSeq) {
      state.denials++;
      state.blocked = state.denials >= 3;
      record(req, { decision: 'deny', reason: 'Identical action already denied with no new user instruction.', actionHash });
      return 'rejected';
    }
    const serialized = JSON.stringify(action);
    if (serialized.length > 12000 || redact(serialized) !== serialized) return fallback('Action contains possible credentials or exceeds the review input limit.', { actionHash });
    if (state.reviews >= config.maxReviewsPerTurn) return fallback('Per-turn automatic review budget reached.', { actionHash });
    const context = contextFor(req.agent.session, audit.read(req.agent.session.id));
    if (context.oversized) return fallback('Direct user instructions exceed the bounded review context; manual review required.', { actionHash });
    if (!context.userMessages.length) return fallback('No retained direct user instruction is available.', { actionHash });
    const target = config.provider ? config : req.agent.session.requestHeader()?.config ?? req.agent.options;
    if (!target.provider || !target.model) return fallback('No reviewer model route is configured.', { actionHash });
    state.reviews++;
    const started = Date.now();
    // Jev answers the same question far faster and cheaper than the reviewer model.
    // It returns undefined when it is unavailable, unsure or failing, which leaves
    // the reviewer path below untouched.
    const jev = ctx.get('jev');
    if (jev) {
      let verdict;
      try {
        verdict = await jev.approval({ action, context, sessionId: req.agent.session.id, signal: req.signal });
      } catch (error) {
        // A broken decisions backend must not change review behaviour.
        ctx.logger?.info?.(`auto-review: Jev unavailable: ${error.message}`);
        verdict = undefined;
      }
      if (verdict !== undefined) {
        const jevDetails = {
          actionHash, provider: 'openrouter', model: verdict.model, source: 'jev',
          choice: verdict.choice, confidence: verdict.confidence, denyProbability: verdict.denyProbability,
          authorized: verdict.authorized, destructive: verdict.destructive, credentialRisk: verdict.credentialRisk,
          durationMs: verdict.durationMs ?? (Date.now() - started),
          usage: verdict.usage ?? null, usageComplete: verdict.usage != null,
        };
        // Jev hands its risk guards over when the instruction authorizes the work;
        // the reviewer model below sees the pending arguments and decides, and its
        // own `human` verdict still reaches the user.
        if (verdict.decision !== 'defer') return applyVerdict({ decision: verdict.decision, reason: verdict.reason }, jevDetails);
        record(req, { decision: 'deferred', reason: verdict.reason, ...jevDetails });
      }
      // A caller that cancelled must not fall through to a reviewer request.
      if (req.signal?.aborted) {
        return applyVerdict({ decision: 'cancelled' }, {
          actionHash, provider: 'openrouter', model: jev.model ?? 'jev', source: 'jev',
          durationMs: Date.now() - started, usage: null, usageComplete: false,
        });
      }
    }
    const controller = new AbortController();
    const signal = req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('Reviewer timed out')), config.timeoutMs);
    const assembler = new BlockAssembler();
    let decision;
    let completed = false;
    try {
      // Independent request: no conversation system prompt, tools, API keys,
      // file reads, or main-agent reasoning are added to the reviewer context.
      const operation = (async () => {
        let terminal = false;
        // A verdict needs little deliberation: the lowest level near low the reviewer model offers.
        const effort = await effortFor(ctx.llm, target, 'low', signal);
        for await (const chunk of ctx.llm.stream({
          provider: target.provider, model: target.model, sessionId: req.agent.session.id,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
          messages: [createSystemMessage(REVIEW_POLICY, name), createUserMessage({
            content: [{ type: 'text', text: JSON.stringify({ action, context }) }],
            source: { kind: name },
          })],
          maxTokens: config.maxOutputTokens, signal,
        })) {
          signal.throwIfAborted();
          assembler.push(chunk);
          if (chunk.type === 'finish') terminal = true;
        }
        if (!terminal || assembler.finish.kind !== 'stop') throw new Error('Reviewer response was incomplete');
        const blocks = assembler.blocks();
        if (blocks.some(b => b.type !== 'text' && b.type !== 'reasoning')) throw new Error('Reviewer returned non-text content');
        completed = true;
        return parseDecision(blocks.filter(b => b.type === 'text').map(b => b.text).join(''));
      })();
      let abortListener;
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(signal.reason);
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', abortListener, { once: true });
      });
      try { decision = await Promise.race([operation, aborted]); }
      finally { signal.removeEventListener('abort', abortListener); }
      completed = true;
    } catch {
      if (req.signal?.aborted) {
        record(req, { decision: 'cancelled', reason: 'Caller cancelled review.', actionHash, provider: target.provider, model: target.model, usage: assembler.usage ?? null, usageComplete: false, durationMs: Date.now() - started });
        return 'cancelled';
      }
      decision = { decision: 'human', reason: controller.signal.aborted ? 'Reviewer timed out.' : 'Reviewer failed or returned invalid output.' };
    } finally { clearTimeout(timer); }
    const details = {
      actionHash, provider: target.provider, model: target.model,
      durationMs: Date.now() - started,
      usage: assembler.usage ?? null, usageComplete: completed && assembler.usage !== undefined,
    };
    return applyVerdict(decision, details);
  }

  ctx.on('approval/request', (req, next) => {
    // OS/application access and sensitive Computer Use confirmations remain human.
    if (req.toolName.startsWith('computer_')) return next();
    // Sandbox escalation: only a single, unquoted read-only diagnostic may leave the
    // sandbox without a human. The grant binds to the exact pending arguments, is
    // budgeted per turn, and is audited; anything else keeps asking the user.
    const escalating = calls.get(req.agent)?.get(req.callId);
    const grant = escalating === undefined ? undefined : escalationDiagnosticGrant(escalating.name, escalating.arguments);
    if (grant !== undefined && ctx.approval?.effectivePolicy?.(req.agent.session) !== 'never') {
      const state = stateFor(req.agent);
      const grantBudget = config.maxEscalationGrantsPerTurn ?? 2;
      if (state.grants < grantBudget) {
        state.grants++;
        record(req, { decision: 'allowed-once', policy: 'escalation-allowlist', reason: `Read-only diagnostic escalation: ${grant.argv[0]}`, actionHash: fingerprint({ tool: escalating.name, arguments: escalating.arguments }) });
        announce(req.agent, `Escalation granted once for the read-only diagnostic \`${grant.command}\`.`);
        return 'allowed-once';
      }
      announce(req.agent, `Escalation budget reached (${grantBudget} per turn); asking the user.`);
    }
    if (mode(req.agent) !== REVIEWED) return next();
    const state = stateFor(req.agent);
    // Serialize per agent so simultaneous calls cannot race the denial budget.
    const pending = state.tail.then(() => review(req, next, state));
    state.tail = pending.catch(() => {});
    return pending;
  }, { prepend: true });

  ctx.commands.register({ name: 'review-usage', description: 'Show automatic permission review usage for this session', handler: ({ agent }) => {
    const records = audit.read(agent.session.id);
    const measured = records.filter(r => r.usage);
    const total = key => measured.reduce((sum, r) => sum + (r.usage[key] ?? 0), 0);
    return { kind: 'success', text: `Auto review: ${records.length} decisions; ${records.filter(r => r.provider).length} model attempts; ${total('inputTokens')} input / ${total('outputTokens')} output tokens reported; ${records.filter(r => r.provider && !r.usageComplete).length} attempts with incomplete/unknown usage; ${records.reduce((s,r) => s + (r.durationMs ?? 0), 0)} ms. Last: ${records.at(-1)?.reason ?? '(none)'}` };
  } });
}
