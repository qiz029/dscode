import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';

function stateIn(messages) {
  const state = {};
  for (const message of messages) {
    const visit = blocks => {
      for (const block of blocks) {
        if (block.type === 'text') for (const match of block.text.matchAll(/<state>(.*?)<\/state>/gs)) Object.assign(state, JSON.parse(match[1]));
        if (block.type === 'tool-result') visit(block.content);
      }
    };
    visit(message.content);
  }
  return state;
}

// A deliberately simple transport double, NOT an LLM or quality evaluator.
// It sees only the model-facing messages, never fixture gold answers.
export class OfflineAdapter extends LlmAdapter {
  constructor(contextWindow, { loseState = false } = {}) { super(); this.contextWindow = contextWindow; this.loseState = loseState; }
  async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: this.contextWindow } }; }
  async *stream(options) {
    const state = stateIn(options.messages);
    let text;
    if (options.purpose === 'compaction') text = this.loseState ? 'Earlier work has been summarized.' : `<state>${JSON.stringify(state)}</state>`;
    else {
      // The probe list is the last line of the prompt, so retry hints may be
      // inserted before it without changing what this double parses.
      const prompt = options.messages.at(-1).content[0].text;
      const probes = JSON.parse(prompt.trim().split('\n').at(-1));
      text = JSON.stringify({ answers: Object.fromEntries(probes.map(probe => [probe.id, state[probe.id] ?? 'UNKNOWN'])) });
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function deepseekAdapter({ model, contextWindow, apiKey, baseURL = 'https://api.deepseek.com', thinking = 'disabled' }) {
  if (!apiKey?.trim()) throw Error('DEEPSEEK_API_KEY is required for a live eval');
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw Error('Endpoint must be HTTPS (or loopback HTTP), with no credentials, query or fragment');
  const options = resolveAdapterOptions({ baseURL, thinking, models: [{ id: model, contextWindow }], retryPolicy: { mode: 'normal', maxRetries: 0 } });
  return new DeepSeekAdapter({
    options: () => options,
    resolveApiKey: async () => apiKey,
    resolveUserId: () => 'dscode-compaction-eval',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  });
}

export class BudgetAdapter extends LlmAdapter {
  constructor(inner, budget, timeoutMs) { super(); this.inner = inner; this.budget = budget; this.timeoutMs = timeoutMs; }
  resolveModel(...args) { return this.inner.resolveModel(...args); }
  // The native adapter remains responsible for message serialization and SSE.
  async *stream(options) {
    if (this.budget.used >= this.budget.limit) throw Error('eval-call-budget-exhausted');
    this.budget.used++;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(Error('eval-call-timeout')), this.timeoutMs);
    const signal = AbortSignal.any([options.signal ?? new AbortController().signal, deadline.signal]);
    const iterator = this.inner.stream({ ...options, signal })[Symbol.asyncIterator]();
    try {
      while (true) {
        // A provider may ignore AbortSignal while awaiting its next SSE event.
        // Race each iterator step against the deadline so the eval can advance.
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(signal.reason);
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        });
        let step;
        try { step = await Promise.race([iterator.next(), aborted]); }
        finally { signal.removeEventListener('abort', onAbort); }
        if (step.done) break;
        yield step.value;
      }
    } finally {
      clearTimeout(timer);
      // Do not await a misbehaving provider's return() after a timeout.
      if (signal.aborted) Promise.resolve(iterator.return?.()).catch(() => {});
      else await iterator.return?.();
    }
  }
}
