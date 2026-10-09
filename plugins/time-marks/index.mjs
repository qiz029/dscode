/**
 * Clock marks in the model's own context: every message a step admits, and
 * every turn that closed before it, carries one reading of the host clock. A
 * mark is its own plugin-sourced message rather than an edit of the prompt, so
 * message bodies, session cards and title selection read exactly what they
 * read before. Like the time-context reading it is durable: it spends model
 * context from then on, replays on resume, and the terminal hides it by
 * producer.
 *
 * @module dscode-time-marks
 */
import z from '@deepseek-ai/schemastery';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { arrivalMark, resolveTimeZone, turnEndMark } from './marks.mjs';
import { producerKind } from '../message-source/kind.mjs';
export const name = 'dscode-time-marks';
export const Config = z.object({
  /** Fallback display zone; empty uses the host zone. */
  timeZone: z.string().default(''),
});
/** Marks carried by one request at most, so a delivery burst cannot flood a step. */
const MARK_LIMIT = 8;

/** Recover bounded turn endings that no durable clock message has reported. */
export function pendingTimeMarks(events) {
  const pending = [];
  let covered = -1, crossedEnd = false;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === 'user/message' && producerKind(event.data.source) === name) {
      // New clocks carry explicit IDs. Older clocks are trusted plugin output;
      // their rendered turn lines are the available durable evidence.
      const turns = event.data.source.closedTurns ?? (event.data.content ?? []).flatMap(block =>
        block.type === 'text' ? [...block.text.matchAll(/^Time mark: .+ — turn (\d+) ended(?:,|\.)/gm)].map(match => +match[1]) : []);
      if (Array.isArray(turns)) for (const turn of turns) if (Number.isSafeInteger(turn)) covered = Math.max(covered, turn);
    }
    if (event.type === 'turn/end') {
      if (event.data.turn <= covered) crossedEnd = true;
      else if (pending.length < MARK_LIMIT) pending.push({ turn: event.data.turn, endedAt: event.time });
    }
    if (event.type === 'turn/start') {
      const ended = pending.find(item => item.turn === event.data.turn);
      if (ended) ended.startedAt = event.time;
    }
    if ((crossedEnd || pending.length === MARK_LIMIT) && pending.every(item => item.startedAt !== undefined)) break;
  }
  return pending.reverse();
}
/**
 * Per-agent mark state: closed turns still waiting for a step to carry them,
 * and the opening time of the turn each one closed.
 */
export function apply(ctx, config = {}) {
  return install(ctx, config, () => true);
}

export function applyDesktop(ctx, config = {}) {
  return install(ctx, config, agent => ctx.agentPresets.composedPreset(agent.ctx) === 'dscode');
}

function install(ctx, config, accepts) {
  const marks = new WeakMap();
  const stateFor = agent => {
    let state = marks.get(agent);
    if (state === undefined) marks.set(agent, state = { turns: pendingTimeMarks(agent.session?.snapshotEvents?.() ?? []), starts: new Map() });
    return state;
  };
  const timeZone = resolveTimeZone(config.timeZone);
  let closed = false;
  ctx.effect(() => () => { closed = true; });
  ctx.on('agent/pre-step', async (payload, next) => {
    if (closed || !accepts(payload.agent)) return next();
    const state = stateFor(payload.agent);
    // Keep inbox provenance before downstream handlers add runtime context or
    // filter the batch. Some native additions (e.g. skill-catalog) have no form.
    const arrivals = new Set(payload.messages.map(message => message.id));
    // The first step of a turn is the only moment its opening is observable.
    if (payload.step === 1) state.starts.set(payload.turn, Date.now());
    const decision = await next();
    if (closed || decision.kind !== 'enter') return decision;
    const at = Date.now();
    const lines = [], closedTurns = [];
    for (const message of decision.messages) {
      if (!arrivals.has(message.id)) continue;
      // Marks are injected context, never an inbox arrival; skipping our own
      // producer keeps a future delivery path from marking itself.
      if (producerKind(message.source) === name) continue;
      const line = arrivalMark(message, at, timeZone);
      if (line !== null && lines.length < MARK_LIMIT) lines.push(line);
    }
    // An arrival burst that fills the limit leaves the remaining turn marks
    // queued: the next step carries them instead of losing them here.
    while (lines.length < MARK_LIMIT && state.turns.length > 0) {
      const ended = state.turns.shift();
      lines.push(turnEndMark(ended.turn, ended.endedAt, ended.startedAt, timeZone));
      closedTurns.push(ended.turn);
    }
    if (lines.length === 0) return decision;
    return {
      ...decision,
      // Ahead of the admitted batch: clocks must not take the prompt's place.
      // The Host may independently append its runtime context after the input.
      messages: [createUserMessage({
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: name, form: 'snapshot', closedTurns },
      }), ...decision.messages],
    };
  }, { prepend: true });
  ctx.on('agent/turn-stopping', payload => {
    if (closed || !accepts(payload.agent)) return;
    const state = stateFor(payload.agent);
    state.turns.push({ turn: payload.turn, endedAt: Date.now(), startedAt: state.starts.get(payload.turn) });
    state.starts.delete(payload.turn);
    if (state.turns.length > MARK_LIMIT) state.turns.length = MARK_LIMIT;
  });
}
