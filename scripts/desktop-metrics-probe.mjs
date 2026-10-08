import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { appendMetric } from '../plugins/session-metrics/store.mjs';
import * as metrics from '../plugins/session-metrics/desktop-host.mjs';

export const inject = ['agents', 'agentPresets', 'llm', 'sessions'];
export function apply(ctx) { void run(ctx).catch(error => {
  console.error(error.stack);
  if (process.env.DSCODE_METRICS_ELECTRON) process.send({ type: 'dscode-metrics-failed' }); else ctx.get('appExit')(1);
}); }
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_METRICS_PHASE, ui = !!process.env.DSCODE_METRICS_UI, home = process.env.DSH_HOME, handles = [];
  let modelCalls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream() {
      modelCalls++; writeFileSync(join(home, 'metrics-model-calls.json'), JSON.stringify({ modelCalls }));
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Usage fixture complete.' }; await delay(25);
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Usage fixture complete. This response and its usage are scripted.' } };
      yield { type: 'usage', usage: { inputTokens: 20, cacheReadTokens: 80, outputTokens: 10 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-metrics-fixture'], new Adapter());
  const make = async (id, preset, resume = false) => {
    const setup = async (scope, agent) => { await ctx.agentPresets.mount(scope, preset);
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }); };
    const handle = resume ? await ctx.agents.resume({ resumeSessionId: id, setup }) : await ctx.agents.create({ sessionId: id,
      meta: { cwd: process.cwd(), agentPreset: preset }, agentOptions: { provider: 'desktop-metrics-fixture', model: 'fixture' }, setup });
    handles.push(handle); return handle.agent;
  };
  const agent = await make('desktop-usage-current', 'dscode', phase !== 'generate');
  const standard = await make('desktop-usage-standard-' + phase, 'standard');
  const origin = `http://127.0.0.1:${ctx.get('webServer').port}`, connection = ctx.get('connection');
  const auth = await fetch(connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const request = (sessionId = agent.id, headers = { Cookie: cookie, Origin: origin }) => fetch(origin + '/api/dscode-metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-metrics', payload: { action: 'status', sessionId } }),
  });
  const status = async () => { const response = await request(); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value; };
  try {
    if (phase === 'generate') {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Desktop usage fixture' }] }));
      await agent.whenIdle(); await ctx.sessions.flush(agent.session);
      const time = agent.session.snapshotEvents().find(event => event.type === 'turn/start').time + 1;
      appendMetric(home, agent.id, { kind: 'start', id: 'synthetic-cost', time, provider: 'fixture', model: 'fixture', purpose: 'memory' });
      appendMetric(home, agent.id, { kind: 'end', id: 'synthetic-cost', time, cost: 0.012 });
      appendMetric(home, standard.id, { kind: 'end', id: 'foreign-cost', time, cost: 900 });
    }
    assert.equal((await request(agent.id, {})).status, 401);
    assert.equal((await request(agent.id, { Cookie: cookie, Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await (await request(standard.id)).json()).result.ok, false);
    assert.equal((await (await request('missing')).json()).result.ok, false);
    const seq = agent.session.seq, snapshot = await status(); await status();
    assert.equal(agent.session.seq, seq); assert.equal(modelCalls, phase === 'generate' ? 1 : 0);
    assert.equal(snapshot.cost, 0.012); assert.equal(snapshot.partial, true); assert.equal(snapshot.cachePercent, 80);
    assert.equal(snapshot.turns.length, 1); assert.equal(snapshot.turns[0].cost, 0.012);
    assert.equal(snapshot.calls, 2); assert.equal(snapshot.pending, 0);
    assert(!JSON.stringify(snapshot).includes('Desktop usage fixture')); assert(!snapshot.turns.some(turn => turn.cost === 900));
    if (phase === 'generate') writeFileSync(join(home, 'metrics-snapshot.json'), JSON.stringify(snapshot));
    else assert.equal(snapshot.cost, JSON.parse(readFileSync(join(home, 'metrics-snapshot.json'))).cost);
    if (phase === 'unload') {
      await [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-desktop-metrics').fiber.dispose();
      assert.equal((await request()).status, 404);
      const reload = ctx.plugin(metrics); await reload; assert.equal((await status()).cost, snapshot.cost); await reload.dispose();
    }
    console.log('DESKTOP_METRICS_PASSED ' + JSON.stringify({ phase, authenticatedRpc: true, originEnforced: true,
      presetAndSessionIsolation: true, metadataOnly: true, ledgerProjection: true, noReadSideEffects: true,
      ...(phase !== 'generate' ? { persistedCost: true } : {}), ...(phase === 'unload' ? { unloadReload: true } : {}) }));
    if (ui) { console.log('DESKTOP_METRICS_UI_READY ' + JSON.stringify({ home, sessionId: agent.id })); return; }
  } finally { if (!ui) for (const handle of handles.reverse()) await handle.dispose(); }
  if (process.env.DSCODE_METRICS_ELECTRON) process.send({ type: 'dscode-metrics-shutdown' }); else ctx.get('appExit')(0);
}
