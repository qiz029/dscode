const WINDOW_MS = 5000;

// Providers report exact output tokens only when a request settles. During
// streaming, estimate from UTF-8 bytes without rounding each small chunk.
export function estimatedDeltaTokens(chunk) {
  const text = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
    ? chunk.text
    : chunk.type === 'tool-call-delta' ? chunk.argumentsDelta : undefined;
  return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') / 4 : 0;
}

export function createWindowRate() {
  const samples = new WeakMap();
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
      const state = samples.get(session) ?? { values: [], head: 0, sum: 0 };
      state.values.push({ time: now, tokens });
      state.sum += tokens;
      prune(state, now);
      samples.set(session, state);
    },
    get(session, now = Date.now()) {
      const state = samples.get(session);
      if (!state) return null;
      prune(state, now);
      return Math.max(0, state.sum) / (WINDOW_MS / 1000);
    },
  };
}

// Count only active turns: tool waits are part of the user's elapsed work,
// while time between user turns is not. Output tokens come from the root
// agent's settled messages, so parallel children do not inflate this rate.
export function sessionAverageTps(events, now = Date.now()) {
  const open = new Map();
  let activeMs = 0, outputTokens = 0, known = 0, unknown = false;
  for (const event of events) {
    if (event.type === 'turn/start') open.set(event.data.turn, event.time);
    else if (event.type === 'turn/end') {
      const start = open.get(event.data.turn);
      if (start !== undefined) activeMs += Math.max(0, event.time - start);
      open.delete(event.data.turn);
    } else if (event.type === 'assistant/message') {
      const output = event.data.usage?.outputTokens;
      if (Number.isFinite(output) && output >= 0) { outputTokens += output; known++; }
      else unknown = true;
    }
  }
  for (const start of open.values()) activeMs += Math.max(0, now - start);
  return activeMs > 0 && known > 0 && !unknown ? outputTokens / (activeMs / 1000) : null;
}
