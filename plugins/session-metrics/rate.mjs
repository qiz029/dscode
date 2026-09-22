// Each valid completed request halves every older sample's weight.
const DECAY = 0.5;

/**
 * Normalized exponential average of per-request TPS, from final API usage.
 * New samples have weight 1; existing weights multiply by DECAY. Normalizing
 * the startup weights keeps newer requests more influential from sample two.
 * Idle time and unusable samples do not age the history.
 */
export function createSmoothedRate() {
  const sessions = new WeakMap();
  return {
    begin(session, route) {
      let state = sessions.get(session);
      if (!state || state.route !== route) {
        state = { route, weightedRate: 0, weight: 0 };
        sessions.set(session, state);
      }
      // A late completion from an older model must not contaminate the new one.
      return ({ start, end, outputTokens }) => {
        if (sessions.get(session) !== state || !Number.isFinite(start) || !Number.isFinite(end)
          || end <= start || !Number.isFinite(outputTokens) || outputTokens < 0) return;
        const rate = outputTokens / ((end - start) / 1000);
        if (!Number.isFinite(rate)) return;
        state.weightedRate = state.weightedRate * DECAY + rate;
        state.weight = state.weight * DECAY + 1;
      };
    },
    get(session) {
      const state = sessions.get(session);
      return state?.weight > 0 ? state.weightedRate / state.weight : null;
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
