import { join } from 'node:path';
import { homedir } from 'node:os';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionCards } from './manager.mjs';
import { TOPIC_PROMPT } from './content.mjs';
import { chargeTo } from '../session-metrics/attribution.mjs';
import { effortFor } from '../providers/effort.mjs';
export const name = 'dscode-session-cards';
export const inject = ['sessions', 'llm'];
export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME ?? process.env.DSCODE_HOME ?? join(homedir(), '.local/share/dscode-hub');
  const cards = new SessionCards({ root: join(home, 'session-cards'), config, generate: async (input, route, signal, sessionId) => {
    const assembler = new BlockAssembler(); let finished = false, usage;
    // Cards need little reasoning whatever the session runs at: low, or the nearest level the model offers.
    const { reasoningEffort: _sessionEffort, ...base } = route ?? {};
    const reasoningEffort = await effortFor(ctx.llm, base, 'low', signal);
    await chargeTo(sessionId, 'session-card', async () => {
      for await (const chunk of ctx.llm.stream({ ...base, ...(reasoningEffort ? { reasoningEffort } : {}), system: TOPIC_PROMPT,
        messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input) }], source: { kind: 'plugin', plugin: name } })],
        maxTokens: 2000, signal })) {
        signal.throwIfAborted(); assembler.push(chunk);
        if (chunk.type === 'finish') finished = true;
        if (chunk.type === 'usage') usage = chunk.usage;
      }
    });
    if (!finished || assembler.finish.kind !== 'stop') throw Error('Incomplete topic response');
    const blocks = assembler.blocks();
    if (blocks.some(b => !['text', 'reasoning'].includes(b.type))) throw Error('Unexpected topic tool call');
    const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return { value: JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')), usage };
  } });
  ctx.provide('sessionCards', cards);
  ctx.on('session/created', session => cards.track(session));
  ctx.on('session/event', (session, event) => cards.observe(session, event));
  ctx.on('session/disposed', session => cards.remove(session));
  ctx.effect(() => () => cards.close(), 'dscode-session-cards.close');
  for (const session of ctx.sessions.list()) cards.track(session);
}
