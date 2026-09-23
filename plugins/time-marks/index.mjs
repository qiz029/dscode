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
/**
 * Per-agent mark state: closed turns still waiting for a step to carry them,
 * and the opening time of the turn each one closed.
 */
const marks = new WeakMap();
const stateFor = agent => {
  let state = marks.get(agent);
  if (state === undefined) marks.set(agent, state = { turns: [], starts: new Map() });
  return state;
};
export function apply(ctx, config = {}) {
  const timeZone = resolveTimeZone(config.timeZone);
  ctx.on('agent/pre-step', async (payload, next) => {
    const state = stateFor(payload.agent);
    // The first step of a turn is the only moment its opening is observable.
    if (payload.step === 1) state.starts.set(payload.turn, Date.now());
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const at = Date.now();
    const lines = [];
    for (const message of payload.messages) {
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
    }
    if (lines.length === 0) return decision;
    return {
      ...decision,
      // Ahead of the batch, never behind it: whatever reads the request's last
      // user message (an echo fixture, a title or topic pass) must still find
      // the prompt there, not this mark.
      messages: [createUserMessage({
        content: [{ type: 'text', text: lines.join('\n') }],
        source: { kind: name, form: 'snapshot' },
      }), ...decision.messages],
    };
  }, { prepend: true });
  ctx.on('agent/turn-stopping', payload => {
    const state = stateFor(payload.agent);
    state.turns.push({ turn: payload.turn, endedAt: Date.now(), startedAt: state.starts.get(payload.turn) });
    state.starts.delete(payload.turn);
    if (state.turns.length > MARK_LIMIT) state.turns.length = MARK_LIMIT;
  });
}
