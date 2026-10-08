import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { producerKind } from '../plugins/message-source/kind.mjs';
import * as timeMarks from '../plugins/time-marks/desktop-host.mjs';

export const inject = ['llm', 'agents', 'agentPresets', 'sessions', 'sessionTitle', 'connection', 'webServer'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    console.error(error.stack);
    if (process.env.DSCODE_TIME_MARKS_ELECTRON) process.send({ type: 'dscode-time-marks-failed' });
    else ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_TIME_MARKS_PHASE, ui = !!process.env.DSCODE_TIME_MARKS_UI;
  const calls = [], handles = [];
  const isMark = message => producerKind(message.source) === 'dscode-time-marks';
  const marks = agent => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && isMark(event.data));
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      calls.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `Clock fixture reply ${calls.length}.` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-clock-fixture'], new Adapter());
  const make = async (id, preset, resume = false) => {
    const handle = await ctx.agents[resume ? 'resume' : 'create']({ sessionId: id, resumeSessionId: id,
      meta: { cwd: process.cwd(), agentPreset: preset }, agentOptions: { provider: 'desktop-clock-fixture', model: preset },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, preset);
        installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
      },
    }); handles.push(handle); return handle.agent;
  };
  const send = async (agent, text, source = { kind: 'user' }) => {
    const message = createUserMessage({ source, content: [{ type: 'text', text }] });
    agent.followup(message); await agent.whenIdle();
    const events = agent.session.snapshotEvents();
    assert(events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text?.startsWith('Clock fixture reply'))));
    assert.deepEqual(events.find(event => event.type === 'user/message' && event.data.id === message.id).data.content, message.content);
    const request = calls.at(-1);
    const inputIndex = request.messages.findIndex(item => item.id === message.id);
    assert(inputIndex >= 0, 'The admitted input must reach the model');
    assert.deepEqual(request.messages[inputIndex].content, message.content);
    assert(!request.messages.slice(inputIndex + 1).some(isMark), 'Clock context must precede the admitted input');
    return request;
  };
  let receipt, main;
  try {
    main = await make('desktop-clock-current', 'dscode', phase !== 'generate');
    ctx.sessionTitle.rename(main.session, 'Desktop clock fixture');
    const standard = await make(`desktop-clock-standard-${phase}`, 'standard');
    ctx.sessionTitle.rename(standard.session, 'Standard clock control');
    const before = marks(main).map(event => event.data.id);
    if (phase === 'generate') {
      const first = await send(main, 'Show a brief reply for the Desktop clock fixture.');
      assert.equal(first.messages.filter(isMark).length, 1);
      assert.match(marks(main)[0].data.content[0].text, /\+00:00\[UTC\] — user message arrived/);
      assert.equal(marks(main)[0].data.content[0].text.split('\n').length, 1, 'Host context and skill catalogs must not be marked as arrivals');
      await send(main, 'Continue the queued clock fixture.', { kind: 'dscode-session-bridge', form: 'relay', label: 'fixture peer', mode: 'queue', composedAt: Date.now() - 5000 });
      const latest = marks(main).at(-1).data;
      assert.match(latest.content[0].text, /queue relay from fixture peer arrived, waited/);
      assert.match(latest.content[0].text, /turn 1 ended, ran/);
      assert.deepEqual(latest.source.closedTurns, [1]);
      assert.equal(marks(main).length, 2);
    } else if (phase === 'resume') {
      assert.equal(before.length, 2);
      await send(main, 'Resume the Desktop clock fixture.');
      assert.deepEqual(marks(main).slice(0, 2).map(event => event.data.id), before);
      assert.equal(marks(main).length, 3);
      assert.match(marks(main).at(-1).data.content[0].text, /turn 2 ended, ran/);
      assert.deepEqual(marks(main).at(-1).data.source.closedTurns, [2]);
    } else {
      const entry = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-time-marks');
      assert(entry?.fiber); await entry.fiber.dispose();
      await send(main, 'Continue while clock marks are unloaded.');
      assert.equal(marks(main).length, before.length);
      const reloaded = ctx.plugin(timeMarks, { timeZone: 'UTC' }); await reloaded;
      await send(main, 'Continue after clock marks are restored.');
      assert.equal(marks(main).length, before.length + 1);
      assert.deepEqual(marks(main).at(-1).data.source.closedTurns, [3, 4]);
      await reloaded.dispose();
    }
    const nativeRequest = await send(standard, 'Show a brief native Standard reply.');
    assert(!nativeRequest.messages.some(isMark)); assert.equal(marks(standard).length, 0);
    await ctx.sessions.flush(main.session);
    receipt = { phase, modelClockContext: true, standardExcluded: true, userBodiesPreserved: true,
      ...(phase === 'generate' ? { relayComposeWait: true, previousTurnDuration: true }
        : phase === 'resume' ? { durableMarksPreserved: true, pendingEndingRestored: true } : { unloadStopsInjection: true, reloadRecoversMissedEndings: true }) };
    if (ui) {
      console.log('DESKTOP_TIME_MARKS_PASSED ' + JSON.stringify(receipt));
      console.log('DESKTOP_TIME_MARKS_UI_READY ' + JSON.stringify({ home: process.env.DSH_HOME, sessionId: main.id,
        url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`) }));
      return;
    }
  } finally { if (!ui) for (const handle of handles.reverse()) await handle.dispose(); }
  console.log('DESKTOP_TIME_MARKS_PASSED ' + JSON.stringify(receipt));
  if (process.env.DSCODE_TIME_MARKS_ELECTRON) process.send({ type: 'dscode-time-marks-shutdown' });
  else ctx.get('appExit')(0);
}
