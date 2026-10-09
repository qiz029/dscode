import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { computerSkill } from '../plugins/computer-use/desktop-skill.mjs';
import * as computerUse from '../plugins/computer-use/desktop-host.mjs';

export const inject = ['llm', 'agents', 'agentPresets', 'commands', 'tools', 'skills', 'permissionPresets', 'sessions'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    console.error(error.stack);
    if (process.env.DSCODE_COMPUTER_USE_ELECTRON) process.send({ type: 'dscode-computer-use-failed' });
    else ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_COMPUTER_USE_PHASE, handles = [];
  let cursor = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream() {
      const load = cursor++ === 0;
      const block = load ? { type: 'tool-call', id: 'computer-skill-load', name: 'skill', arguments: JSON.stringify({ name: computerSkill.name }) }
        : { type: 'text', text: 'COMPUTER_SKILL_READY' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: load ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-computer-fixture'], new Adapter());
  const make = async (id, preset, resume = false) => {
    const handle = await ctx.agents[resume ? 'resume' : 'create']({ sessionId: id, resumeSessionId: id,
      meta: { cwd: process.cwd(), agentPreset: preset }, agentOptions: { provider: 'desktop-computer-fixture', model: 'fixture' },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, preset);
        installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
      },
    });
    handles.push(handle); return handle.agent;
  };
  const invoke = (agent, name, args = {}) => ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: AbortSignal.timeout(15000) });
  const has = (agent, name) => ctx.tools.schemas(agent).some(tool => tool.name === name);
  let receipt;
  try {
    const agent = await make('desktop-computer-current', 'dscode', phase === 'resume');
    const standard = await make(`desktop-computer-standard-${phase}`, 'standard');
    const health = await ctx.get('computerUse').health(AbortSignal.timeout(15000));
    assert(health.ready, JSON.stringify(health)); assert.equal(health.helperVersion, '0.3.3');
    assert.equal(health.helperSha256, '55325e0008d755bf2b1d408bcfd5cdb80842ec2a0fa5312da6961eb65d7d6dd3');
    assert(!has(standard, 'computer_use_activate')); assert(!has(standard, 'computer_observe'));
    const skills = await ctx.skills.list({ scope: standard, cwd: process.cwd() });
    assert(!skills.some(skill => skill.name === computerSkill.name));
    const status = await ctx.commands.execute(agent, '/computer', [], AbortSignal.timeout(15000));
    assert.equal(status.result.kind, 'success', status.result.text);
    if (phase === 'activate') {
      assert(has(agent, 'computer_use_activate')); assert(!has(agent, 'computer_observe'));
      assert((await invoke(agent, 'computer_use_activate')).isError);
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Load the DSCODE Computer Use skill for this local fixture.' }] }));
      await agent.whenIdle();
      assert(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError === false), 'Native skill tool did not succeed');
      await ctx.sessions.flush(agent.session);
    }
    assert(has(agent, 'computer_observe')); assert(!has(agent, 'computer_use_activate'));
    const apps = await invoke(agent, 'computer_list_apps'); assert(!apps.isError, JSON.stringify(apps)); assert(Array.isArray(apps.value));
    // Denial must happen before reading application content. No app grants are configured.
    ctx.permissionPresets.set(agent.session, 'danger-full-access');
    const denied = await invoke(agent, 'computer_observe', { app: { bundleId: 'com.apple.finder' } });
    assert(denied.isError, 'Unconfigured app access must not bypass disabled approvals');
    assert.match(JSON.stringify(denied), /approval|permission|lease/i);
    if (phase === 'resume') {
      const entry = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-desktop-computer-use');
      assert(entry?.fiber); await entry.fiber.dispose();
      assert(!has(agent, 'computer_observe')); assert(!has(agent, 'computer_use_activate'));
      assert.equal(ctx.get('computerUse'), undefined);
      const reloaded = ctx.plugin(computerUse, { observationTtlMs: 30000 }); await reloaded;
      assert(has(agent, 'computer_observe')); assert(!has(standard, 'computer_observe'));
      await reloaded.dispose(); assert(!has(agent, 'computer_observe'));
    }
    receipt = { phase, helperVersion: health.helperVersion, helperSha256: health.helperSha256,
      accessibility: health.accessibility, screenRecording: health.screenRecording,
      progressiveSkill: true, standardExcluded: true, appDiscovery: true, missingGrantDenied: true,
      ...(phase === 'resume' ? { restoredFromNativeHistory: true, unloadAndReload: true } : {}),
      applicationObservation: false, inputActions: false, screenshotCapture: false };
  } finally { for (const handle of handles.reverse()) await handle.dispose(); }
  console.log('DESKTOP_COMPUTER_USE_PASSED ' + JSON.stringify(receipt));
  if (process.env.DSCODE_COMPUTER_USE_ELECTRON) process.send({ type: 'dscode-computer-use-shutdown' });
  else ctx.get('appExit')(0);
}
