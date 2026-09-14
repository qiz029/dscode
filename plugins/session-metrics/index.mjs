import { randomUUID } from 'node:crypto';
import { appendMetric } from './store.mjs';
import { estimateCost, priceVersionFor } from './pricing.mjs';
import { setMetricSource } from './view.mjs';
import { BALANCE_PROVIDERS, refreshBalance } from './balance.mjs';
import { providerSpec } from '../providers/catalog.mjs';
import { createWindowRate } from './rate.mjs';
import { currentCharge } from './attribution.mjs';

// Chunks that carry generated output; the first one marks time to first token.
const OUTPUT_CHUNKS = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta']);
export const name = 'dscode-session-metrics';
export const inject = ['llm', 'agents', 'tokenMeter', 'sessionProjections'];
export function apply(ctx) {
  const snapshots = new WeakMap();
  const liveRate = createWindowRate();
  ctx.effect(() => setMetricSource(id => {
    const agent = ctx.agents.get(id);
    if (!agent) return undefined;
    const session = agent.session;
    const cached = snapshots.get(session);
    if (cached?.seq === session.seq) return { ...cached.value, currentTps: liveRate.get(session) };
    const state = ctx.sessionProjections.stateOf(session, 'contextPressure');
    const measurement = ctx.tokenMeter.measure(session);
    const value = { events: session.snapshotEvents(), used: measurement.totalTokens, capacity: state?.contextWindow };
    snapshots.set(session, { seq: session.seq, value });
    return { ...value, currentTps: liveRate.get(session) };
  }));
  const home = process.env.DSH_HOME;
  // Remaining balance is best-effort decoration: resolve the key lazily (never
  // inject the credentials service, so a missing one cannot fail startup), keep
  // the request on a five-minute cache, and never let it reach the render path.
  const credentials = ctx.get?.('credentials');
  const refresh = () => Promise.all(BALANCE_PROVIDERS.map(async provider => {
    try {
      const ref = providerSpec(provider).credentialRef;
      const resolved = await credentials?.resolve?.(ref);
      const key = typeof resolved === 'string' ? resolved : resolved?.value;
      await refreshBalance({ provider, key: key ?? process.env[ref] });
    } catch {
      /* balance stays unknown */
    }
  }));
  refresh();
  const balanceTimer = setInterval(refresh, 5 * 60 * 1000);
  if (typeof balanceTimer.unref === 'function') balanceTimer.unref();
  ctx.effect(() => () => clearInterval(balanceTimer));
  const record = (id, entry) => { try { appendMetric(home, id, entry); } catch { ctx.logger.warn('Session cost telemetry could not be saved.'); } };
  ctx.on('llm/stream', async function* (options, next) {
    // Plugin calls made for a session carry no sessionId on the wire; they are charged through the async context.
    const charge = options.sessionId ? undefined : currentCharge();
    const sessionId = options.sessionId ?? charge?.sessionId;
    if (!sessionId || !home) { yield* next(); return; }
    const id = randomUUID(), time = Date.now();
    const purpose = options.purpose ?? charge?.purpose ?? 'agent';
    const recipients = new Set([sessionId]);
    let child = ctx.agents.get(sessionId);
    while (child?.session.header.origin === 'subagent' && child.session.header.parentSession && !recipients.has(child.session.header.parentSession)) {
      recipients.add(child.session.header.parentSession);
      child = ctx.agents.get(child.session.header.parentSession);
    }
    const save = entry => { for (const recipient of recipients) record(recipient, { ...entry, sessionId }); };
    save({ kind: 'start', id, time, provider: options.provider, model: options.model, purpose });
    let usage, firstTokenTime;
    const liveSession = purpose === 'agent' ? ctx.agents.get(sessionId)?.session : undefined;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = chunk.usage;
        else if (firstTokenTime === undefined && OUTPUT_CHUNKS.has(chunk.type)) firstTokenTime = Date.now();
        if (liveSession) liveRate.add(liveSession, chunk);
        yield chunk;
      }
    } finally {
      if (liveSession) liveRate.calibrate(liveSession, usage?.outputTokens);
      // `time` stays the start (it prices the call); `endTime` and `firstTokenTime` time it.
      save({ kind: 'end', id, time, endTime: Date.now(), ...(firstTokenTime === undefined ? {} : { firstTokenTime }), usage: usage ?? null, cost: estimateCost(options.provider, options.model, usage, time), priceVersion: priceVersionFor(options.provider) });
    }
  });
}
