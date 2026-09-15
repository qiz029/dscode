// Live OpenRouter probe for the supported labs. Spends a few cents on real requests:
// a tool call, its replay with reasoning, a repeated prefix for cache hits, a title
// call, one rejected model and one web search. Reads OPENROUTER_API_KEY from the
// environment or the repository .env; never prints it.
//   node scripts/openrouter-probe.mjs [model ...]
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OpenRouterAdapter } from '../plugins/openrouter/adapter.mjs';
import { ensureOpenRouterModels } from '../plugins/openrouter/models.mjs';
import { OpenRouterSearchProvider } from '../plugins/openrouter/search.mjs';
import { resolveOptions } from '../plugins/openrouter/index.mjs';

const root = join(import.meta.dirname, '..');
if (!process.env.OPENROUTER_API_KEY && existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error('Set OPENROUTER_API_KEY in the environment or the repository .env.'); process.exit(2); }

// Qwen 3.8 27B runs outside Alibaba, so an account that enforces zero data retention can reach it.
const MODELS = process.argv.slice(2).length ? process.argv.slice(2) : ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.6', 'qwen/qwen3.8-27b'];
const connection = resolveOptions({});
const adapter = new OpenRouterAdapter({ options: () => connection, resolveApiKey: async () => key, ensureModels: () => ensureOpenRouterModels({}) });
// A prefix long enough for providers that cache only past a minimum prompt size.
const RULES = Array.from({ length: 60 }, (_, index) => `Rule ${index + 1}: answer precisely, keep replies short, and use the provided tools when a question needs live data.`).join('\n');
const TOOLS = [{ name: 'get_time', description: 'Return the current time for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];

async function call(options) {
  const blocks = new Map();
  let usage, finish;
  for await (const chunk of adapter.stream({ provider: 'openrouter', ...options })) {
    if (chunk.type === 'block-end') blocks.set(chunk.index, chunk.block);
    else if (chunk.type === 'usage') usage = chunk.usage;
    else if (chunk.type === 'finish') finish = chunk;
  }
  const content = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
  return { content, usage, reason: finish?.reason, replayState: finish?.replayState };
}

const text = content => content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
const results = [];
for (const model of MODELS) {
  const row = { model };
  const sessionId = `dscode-probe-${Date.now()}-${model.replace(/\W+/g, '-')}`;
  try {
    const info = await adapter.resolveModel('openrouter', model);
    row.effort = info.reasoning?.defaultEffort ?? '-';
    const base = { model, sessionId, tools: TOOLS, ...(info.reasoning?.defaultEffort ? { reasoningEffort: info.reasoning.defaultEffort } : {}) };
    const system = { role: 'system', content: [{ type: 'text', text: RULES }] };
    const question = { role: 'user', content: [{ type: 'text', text: 'What time is it in Tokyo? Use the tool.' }] };
    const first = await call({ ...base, messages: [system, question] });
    const toolCall = first.content.find(block => block.type === 'tool-call');
    row.provider = first.replayState?.response?.provider ?? '-';
    row.toolCall = first.reason?.kind === 'tool-calls' && toolCall !== undefined;
    row.reasoning = first.content.some(block => block.type === 'reasoning');
    if (!row.toolCall) throw new Error(`no tool call: ${JSON.stringify(first.reason)}`);
    const assistant = { role: 'assistant', source: { kind: 'model', provider: 'openrouter', model, replayState: first.replayState }, content: first.content };
    const result = { role: 'user', source: { kind: 'tool', callId: toolCall.id }, content: [{ type: 'tool-result', toolCallId: toolCall.id, content: [{ type: 'text', text: '2026-09-14T21:04:00+09:00' }] }] };
    const second = await call({ ...base, messages: [system, question, assistant, result] });
    row.replay = second.reason?.kind === 'stop' && /21|9/.test(text(second.content));
    const third = await call({ ...base, messages: [system, question, assistant, result] });
    row.cacheRead = third.usage?.cacheReadTokens ?? 0;
    row.billed = [first, second, third].every(response => Number.isFinite(response.replayState?.response?.cost));
    row.cost = [first, second, third].reduce((sum, response) => sum + (response.replayState?.response?.cost ?? 0), 0);
    const title = await call({ model, sessionId, purpose: 'session-title', maxTokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: 'Title this: fix the flaky login test in CI' }] }] });
    row.title = title.reason?.kind === 'stop' && text(title.content).length > 0;
    row.cost += title.replayState?.response?.cost ?? 0;
  } catch (error) {
    row.error = `${error.code ?? error.name}: ${String(error.message).slice(0, 160)}`;
  }
  results.push(row);
}

const rejected = await call({ model: 'dscode/no-such-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }).then(() => 'accepted', error => error.code);
let search;
try {
  const provider = new OpenRouterSearchProvider(() => ({ baseURL: connection.baseURL, model: connection.searchModel, resolveApiKey: async () => key }));
  search = `${(await provider.search({ query: 'OpenRouter web search plugin documentation', maxResults: 3 })).sources.length} sources`;
} catch (error) { search = `${error.code}: ${error.message}`; }

console.table(results.map(row => ({ ...row, cost: row.cost === undefined ? undefined : `$${row.cost.toFixed(5)}` })));
console.log(`Unknown model rejected as: ${rejected}`);
console.log(`Web search: ${search}`);
const failed = results.filter(row => row.error || !row.toolCall || !row.replay || !row.billed || !row.title);
process.exit(failed.length > 0 || rejected === 'accepted' ? 1 : 0);
