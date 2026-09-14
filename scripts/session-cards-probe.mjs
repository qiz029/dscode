import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { TOPIC_PROMPT } from '../plugins/session-cards/content.mjs';
import { discover, request } from '../plugins/session-bridge/client.mjs';
import { readMetrics } from '../plugins/session-metrics/store.mjs';
export const name = 'session-cards-probe';
export const inject = ['agents', 'agentPresets', 'llm', 'sessionCards'];
export function apply(ctx) { void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function probe(ctx) {
  await ctx.get('loader').await();
  const calls = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: ['low', 'ultra'].map(id => ({ id, name: id })), defaultEffort: 'low' }, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      let text = 'Assistant conclusion: all tests passed.';
      if (options.system === TOPIC_PROMPT) {
        assert.equal(options.reasoningEffort, 'low'); assert.equal(options.tools, undefined); assert.equal(options.sessionId, undefined);
        const input = JSON.parse(options.messages[0].content[0].text); calls.push(input);
        assert(!JSON.stringify(input).includes('all tests passed'));
        assert(!JSON.stringify(input).includes('EXTERNAL_RELAY'));
        assert.equal(input.topicCount, 5);
        text = JSON.stringify({ topics: [{ text: '实现用于会话发现的项目、工作区和用户主题名片', sourceSeqs: input.messages.map(m => m.seq) }] });
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['card-fixture'], new Adapter());
  const setup = async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, 'dscode');
    installModelSelection(agentCtx, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  };
  const handle = await ctx.agents.create({ sessionId: 'card-probe', meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: 'card-fixture', model: 'fixture', reasoningEffort: 'ultra' }, setup });
  const agent = handle.agent;
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '实现会话发现，只需要项目、工作区和最近用户主题' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  for (let i = 0; i < 200 && ctx.sessionCards.get(agent.session).cardState.status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const rows = await discover(process.env.DSH_HOME), row = rows.find(s => s.id === agent.id);
  assert.equal(row.cardState.status, 'ready'); assert(row.card.project); assert.equal(row.card.workspace, process.cwd());
  assert.deepEqual(Object.keys(row.card), ['project', 'workspace', 'topics']);
  assert.equal(row.card.topics.length, 1);
  const charged = readMetrics(process.env.DSH_HOME, agent.id).rows.filter(r => r.kind === 'start' && r.purpose === 'session-card');
  assert(charged.length >= 1, 'session-card model calls must be charged to their session ledger'); assert(row.card.topics[0].sourceSeqs.length);
  const before = calls.length;
  await request(row.socket, { method: 'send', sessionId: agent.id, text: 'EXTERNAL_RELAY', requestId: 'relay' });
  await agent.whenIdle(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, before, 'External relays must not become user topics');
  const page = await request(row.socket, { method: 'read', sessionId: agent.id });
  assert.deepEqual(page.card, row.card);
  await handle.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: 'card-probe', setup });
  assert.equal(ctx.sessionCards.get(resumed.agent.session).cardState.status, 'ready');
  assert.equal(calls.length, before);
  console.log('SESSION_CARDS_PROBE_PASSED: native user input -> independent low effort -> descriptive card -> socket list/read -> resume; relay and assistant excluded');
  ctx.get('appExit')(0);
}
