const WINDOW_MS = 5000;
// A pause longer than this (tool execution, the wait for the first token) ends
// the current output burst: the next chunk starts a fresh window instead of
// averaging over the silence.
const GAP_MS = 1500;
const MIN_SPAN_MS = 500;

// Providers report exact output tokens only when a request settles. During
// streaming, estimate from UTF-8 bytes without rounding each small chunk.
export function estimatedDeltaTokens(chunk) {
  const text = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
    ? chunk.text
    : chunk.type === 'tool-call-delta' ? chunk.argumentsDelta : undefined;
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') / 4 : 0;
}

/**
 * Live output rate: tokens seen in the last five seconds divided by the time
 * that window actually spans, so the rate is right from the first second of a
 * burst. Settled usage calibrates the byte-based estimate per session.
 */
export function createWindowRate() {
  const samples = new WeakMap();
  const stateOf = session => {
    let state = samples.get(session);
    if (!state) { state = { values: [], head: 0, sum: 0, factor: 1, pending: 0 }; samples.set(session, state); }
    return state;
  };
  const prune = (state, now) => {
    while (state.head < state.values.length && state.values[state.head].time <= now - WINDOW_MS) {
      state.sum -= state.values[state.head++].tokens;
    }
    if (state.head > 128 && state.head * 2 > state.values.length) {
      state.values.splice(0, state.head);
      state.head = 0;
    }
  };
  return {
    add(session, chunk, now = Date.now()) {
      const tokens = estimatedDeltaTokens(chunk);
      if (!(tokens > 0)) return;
      const state = stateOf(session);
      const last = state.values.at(-1);
      if (last && now - last.time > GAP_MS) { state.values = []; state.head = 0; state.sum = 0; }
      state.values.push({ time: now, tokens });
      state.sum += tokens;
      state.pending += tokens;
      prune(state, now);
    },
    /** Feed the provider's settled output count for the request whose chunks were just added. */
    calibrate(session, outputTokens) {
      const state = samples.get(session);
      if (!state) return;
      const pending = state.pending;
      state.pending = 0;
      if (!(pending > 0) || !Number.isFinite(outputTokens) || outputTokens <= 0) return;
      const ratio = Math.min(2, Math.max(0.5, outputTokens / pending));
      state.factor = state.factor * 0.5 + ratio * 0.5;
    },
    get(session, now = Date.now()) {
      const state = samples.get(session);
      if (!state) return null;
      prune(state, now);
      if (state.head >= state.values.length) return 0;
      const span = Math.min(WINDOW_MS, Math.max(MIN_SPAN_MS, now - state.values[state.head].time));
      return Math.max(0, state.sum) * state.factor / (span / 1000);
    },
  };
}

// Output tokens per second of LLM call time: every settled assistant message's
// exact output tokens over the time from its step's request start to its
// settlement (first-token latency included, tool execution and user idle time
// excluded). Only the root agent's own messages count, so parallel children do
// not inflate the rate; an in-flight call contributes nothing until it settles.
export function sessionAverageTps(events) {
  const starts = new Map();
  let callMs = 0, outputTokens = 0, known = 0, unknown = false;
  for (const event of events) {
    // Build the key only for the two event types that use it: the array carries every event.
    if (event.type === 'step/start') starts.set(`${event.data?.turn}:${event.data?.step}`, event.time);
    else if (event.type === 'assistant/message') {
      const key = `${event.data?.turn}:${event.data?.step}`;
      const start = starts.get(key);
      starts.delete(key);
      const output = event.data?.usage?.outputTokens;
      if (start === undefined || !Number.isFinite(output) || output < 0) { unknown = true; continue; }
      callMs += Math.max(0, event.time - start);
      outputTokens += output;
      known++;
    }
  }
  return callMs > 0 && known > 0 && !unknown ? outputTokens / (callMs / 1000) : null;
}
