import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { discover, request } from '../plugins/session-bridge/client.mjs';
export const name = 'session-bridge-probe';
export const inject = ['agents', 'agentPresets', 'llm', 'sessions'];
export function apply(ctx) { void probe(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); }
async function probe(ctx) {
  await ctx.get('loader').await();
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  let running = 0, maximum = 0, calls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      if (options.purpose) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Bridge fixture' } };
        yield { type: 'finish', reason: { kind: 'stop' } }; return;
      }
      let active = true;
      running++; maximum = Math.max(maximum, running);
      try {
        if (++calls === 1) { started.resolve(); await release.promise; }
        options.signal?.throwIfAborted();
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `Fixture response ${calls}` } };
        // The terminal frame ends the model operation. Iterator cleanup may
        // settle after the driver has legitimately opened the next request.
        running--; active = false;
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally { if (active) running--; }
    }
  }
  ctx.llm.registerAdapter(['bridge-fixture'], new Adapter());
  const setup = async (agentCtx, agent) => {
    await ctx.agentPresets.mount(agentCtx, 'dscode');
    installModelSelection(agentCtx, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  };
  const handle = await ctx.agents.create({ sessionId: 'bridge-probe-session', meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: 'bridge-fixture', model: 'fixture' }, setup });
  const agent = handle.agent;
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Initial TUI input' }], source: { kind: 'user' } }));
  let startTimer;
  await Promise.race([started.promise, new Promise((_, reject) => { startTimer = setTimeout(() => reject(Error('Fixture model did not start')), 5000); })]).finally(() => clearTimeout(startTimer));
  const invoke = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'bin/dscode.mjs'), ...args, '--home', process.env.DSH_HOME], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('exit', code => { if (code) reject(Error(stderr)); else { try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); } } });
  });
  const replies = await Promise.all([
    invoke(['send', agent.id, '--source', 'script-a', '--request-id', 'first', '--title', '外部构建任务', 'First external message']),
    invoke(['send', agent.id, '--source', 'editor-b', '--request-id', 'second', '--steer', 'Second external message']),
  ]);
  assert(replies.every(r => r.accepted));
  assert.equal(ctx.agents.get(agent.id), agent);
  assert.equal(ctx.agents.list().filter(a => a.id === agent.id).length, 1);
  const read = await invoke(['read', agent.id]);
  assert.equal(read.status, 'running');
  assert.equal(read.title, '外部构建任务');
  assert.equal(read.inbox.nextTurn.length, 1); assert.equal(read.inbox.nextStep.length, 1);
  const duplicate = await invoke(['send', agent.id, '--source', 'script-a', '--request-id', 'first', '--title', '外部构建任务', 'First external message']);
  assert.equal(duplicate.duplicate, true);
  release.resolve(); await agent.whenIdle();
  assert.equal(maximum, 1, 'Concurrent model drivers for one session');
  const relays = agent.session.snapshotEvents().filter(e => e.type === 'user/message' && e.data.source.kind === 'dscode-session-bridge');
  assert.equal(relays.length, 2);
  assert(relays.every(e => e.data.source.form === 'relay'));
  assert(relays.some(e => e.data.content[0].text.includes('script-a')));
  await ctx.sessions.flush(agent.session);
  // Prove deduplication survives disposal and reconstruction of the real Agent.
  await handle.dispose();
  const resumed = await ctx.agents.resume({ resumeSessionId: 'bridge-probe-session', setup });
  const endpoint = (await discover(process.env.DSH_HOME)).find(s => s.id === resumed.agent.id);
  assert(endpoint);
  assert.equal(endpoint.title, '外部构建任务');
  const retried = await request(endpoint.socket, { method: 'send', sessionId: resumed.agent.id, source: 'script-a', requestId: 'first', title: '外部构建任务', text: 'First external message' });
  assert.equal(retried.duplicate, true);
  console.log('SESSION_BRIDGE_PROBE_PASSED: two client processes -> one live Agent; queue/steer; nonblocking read; durable retry dedup; single driver; resume');
  ctx.get('appExit')(0);
}
