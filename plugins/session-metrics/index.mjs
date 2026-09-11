import { randomUUID } from 'node:crypto';
import { appendMetric } from './store.mjs';
import { estimateCost, PRICE_VERSION } from './pricing.mjs';
import { setMetricSource } from './view.mjs';
export const name = 'dscode-session-metrics';
export const inject = ['llm', 'agents', 'tokenMeter', 'sessionProjections'];
export function apply(ctx) {
  const snapshots = new WeakMap();
  ctx.effect(() => setMetricSource(id => {
    const agent = ctx.agents.get(id);
    if (!agent) return undefined;
    const session = agent.session;
    const cached = snapshots.get(session);
    if (cached?.seq === session.seq) return cached.value;
    const state = ctx.sessionProjections.stateOf(session, 'contextPressure');
    const measurement = ctx.tokenMeter.measure(session);
    const value = { events: session.snapshotEvents(), used: measurement.totalTokens, capacity: state?.contextWindow };
    snapshots.set(session, { seq: session.seq, value });
    return value;
  }));
  const home = process.env.DSH_HOME;
  const record = (id, entry) => { try { appendMetric(home, id, entry); } catch { ctx.logger.warn('Session cost telemetry could not be saved.'); } };
  ctx.on('llm/stream', async function* (options, next) {
    if (!options.sessionId || !home) { yield* next(); return; }
    const id = randomUUID(), time = Date.now();
    const recipients = new Set([options.sessionId]);
    let child = ctx.agents.get(options.sessionId);
    while (child?.session.header.origin === 'subagent' && child.session.header.parentSession && !recipients.has(child.session.header.parentSession)) {
      recipients.add(child.session.header.parentSession);
      child = ctx.agents.get(child.session.header.parentSession);
    }
    const save = entry => { for (const recipient of recipients) record(recipient, { ...entry, sessionId: options.sessionId }); };
    save( { kind: 'start', id, time, provider: options.provider, model: options.model, purpose: options.purpose ?? 'agent' });
    let usage;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage;
        yield chunk;
      }
    } finally {
      save({ kind: 'end', id, time, usage: usage ?? null, cost: estimateCost(options.provider, options.model, usage, time), priceVersion: PRICE_VERSION });
    }
  });
}
