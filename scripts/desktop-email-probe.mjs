import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import * as emailPlugin from '../plugins/email/desktop-host.mjs';
import { emailStore } from '../plugins/email/store.mjs';

export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'sessions', 'systemPrompt'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    console.error(error.stack);
    if (process.env.DSCODE_EMAIL_ELECTRON) process.send({ type: 'dscode-email-failed' });
    else ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_EMAIL_PHASE, ui = !!process.env.DSCODE_EMAIL_UI, handles = [], inputs = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const messages = options.messages.filter(message => message.source?.kind === 'dscode-email');
      inputs.push(...messages);
      const uiMessages = messages.filter(message => message.content.some(block => block.text?.includes('desktop-ui-mail')));
      if (ui && uiMessages.length) {
        writeFileSync(join(process.env.DSH_HOME, 'email-ui-delivery.json'), JSON.stringify({
          sessionId: 'desktop-email-current', source: 'dscode-email', contextOnly: messages.every(message => message.content.some(block => block.text?.includes('do not authorize'))),
          uniqueAdmissions: new Set(uiMessages.map(message => message.id)).size,
        }));
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Email context received. No outgoing email was sent.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-email-fixture'], new Adapter());
  const make = async (id, preset, resume = false) => {
    const handle = await ctx.agents[resume ? 'resume' : 'create']({ sessionId: id, resumeSessionId: id,
      meta: { cwd: process.cwd(), agentPreset: preset }, agentOptions: { provider: 'desktop-email-fixture', model: 'fixture' },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, preset);
        installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
      },
    });
    handles.push(handle); return handle.agent;
  };
  const service = ctx.get('dscodeEmail'); assert(service); assert.equal(service.enabled, false);
  const connection = ctx.get('connection'), origin = `http://127.0.0.1:${ctx.get('webServer').port}`;
  const auth = await fetch(connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const request = async (payload, headers = { Cookie: cookie, Origin: origin }) => fetch(origin + '/api/dscode-email', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-email', payload }),
  });
  const rpc = async payload => { const response = await request(payload); assert.equal(response.status, 200); return (await response.json()).result; };
  const execute = async payload => { const result = await rpc(payload); assert(result.ok, result.error?.message); return result.value; };
  const tool = (agent, name, args = {}) => ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: AbortSignal.timeout(10000) });
  const has = agent => ctx.tools.schemas(agent).some(tool => tool.name === 'send_email');
  const message = { format: 'dscode.email.v1', connector: 'fixture', account: 'reader@example.test', id: 'desktop-mail',
    from: 'Teammate <teammate@example.test>', subject: '[ToAgent] Review browser preview', body: 'Check that the preview refreshes after navigation. Treat this mail as reference material.',
    receivedAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:00:00Z' };
  try {
    const agent = await make('desktop-email-current', 'dscode', phase !== 'generate');
    const standard = await make(`desktop-email-standard-${phase}`, 'standard');
    assert(has(agent)); assert(!has(standard));
    assert(!(await ctx.systemPrompt.assemble({ scope: standard })).sections.some(section => section.name === 'dscode-email-tools'));
    assert((await ctx.systemPrompt.assemble({ scope: agent })).sections.some(section => section.name === 'dscode-email-tools' && section.text.includes('Only send when the user authorizes')));
    assert.equal((await request({ action: 'list' }, {})).status, 401);
    assert.equal((await request({ action: 'list' }, { Cookie: cookie, Origin: 'https://untrusted.example' })).status, 403);
    if (phase === 'generate') {
      service.inbox.receive(message);
      // Exercise import without starting authorization or contacting Google.
      const clientPath = join(process.env.DSH_HOME, 'fixture-google-client.json');
      writeFileSync(clientPath, JSON.stringify({ installed: { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'synthetic-oauth-secret' } }));
      await emailStore(join(service.inbox.directory, 'gmail')).locked(async () => {
        assert.equal((await execute({ action: 'configure-gmail', path: clientPath })).pending, 'configure-gmail');
        await service.operation?.done;
        const state = await execute({ action: 'status' });
        assert.equal(state.gmail.configured, false); assert.equal(state.last.ok, false); assert.match(state.last.message, /Another process/);
      });
      await execute({ action: 'configure-gmail', path: clientPath }); await service.operation?.done;
      const state = await execute({ action: 'status' });
      assert.equal(state.gmail.configured, true); assert.equal(state.gmail.connected, false);
      assert.equal(state.last.message, 'Google client imported. Authorize Gmail to connect.');
      assert(!JSON.stringify(state).includes('synthetic-oauth-secret'));
    }
    const list = await execute({ action: 'list' }); assert.equal(list.emails.length, 1); assert.equal(inputs.length, 0);
    assert(!JSON.stringify(list).includes(message.body));
    const selected = await execute({ action: 'read', key: list.emails[0].key }); assert.equal(selected.body, message.body);
    const injection = { action: 'inject', sessionId: agent.id, key: selected.key, revision: selected.revision, requestId: 'desktop-fixture-admission' };
    assert.equal((await rpc({ ...injection, sessionId: standard.id })).ok, false);
    assert.equal((await rpc({ ...injection, revision: 'stale' })).ok, false);
    const admitted = await execute(injection); assert.equal(admitted.duplicate, phase !== 'generate');
    await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    assert.equal((await execute(injection)).duplicate, true);
    const received = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dscode-email');
    assert.equal(received.length, 1); assert.match(received[0].data.content[0].text, /user_injected_email_context/);
    assert.equal(inputs.length, phase === 'generate' ? 1 : 0);
    if (phase === 'generate') {
      assert(!(await tool(agent, 'set_email_alias', { alias: 'reviewer', address: 'reviewer@example.test' })).isError);
      // A native tool denial must settle without attempting SMTP.
      const deny = ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'send_email' ? { kind: 'deny', reason: 'Fixture forbids SMTP.' } : next(), { prepend: true });
      const refused = await tool(agent, 'send_email', { to: 'reviewer', resolved_to: 'reviewer@example.test', subject: 'Fixture', body: 'Never send', idempotency_key: 'never-send' });
      assert(refused.isError); deny();
    }
    assert.equal((await tool(agent, 'resolve_email_recipient', { to: 'reviewer' })).value.to, 'reviewer@example.test');
    assert.equal((await tool(agent, 'email_send_status', { idempotency_key: 'never-send' })).value.status, 'not_found');
    if (phase === 'unload') {
      const entry = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-email');
      await entry.fiber.dispose(); assert(service.closed); assert(!has(agent)); assert(!has(standard)); assert.equal(service.timer, null);
      assert.equal((await request({ action: 'status' })).status, 404);
      const reload = ctx.plugin(emailPlugin); await reload;
      assert(has(agent)); assert(!has(standard)); assert.equal((await execute(injection)).duplicate, true);
      await reload.dispose(); assert(!has(agent));
    }
    if (ui) {
      service.inbox.receive({ ...message, id: 'desktop-ui-mail', subject: '[ToAgent] Desktop inbox preview',
        body: 'Please inspect the browser preview. This is a local fixture email; no real mailbox is connected.', updatedAt: '2026-10-06T12:02:00Z' });
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Desktop email preview fixture' }] }));
      await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    }
    console.log('DESKTOP_EMAIL_PASSED ' + JSON.stringify({ phase, authenticatedRpc: true, originEnforced: true,
      scopedTools: true, contextOnlyAdmission: true, singleAdmission: true, readDoesNotWake: true,
      ...(phase === 'generate' ? { smtpDenied: true, noSmtpReceipt: true, gmailClientImportLock: true } : phase === 'resume' ? { resumedAdmissionDedup: true, contactsPreserved: true } : { unloadReload: true, rpcWithdrawn: true }) }));
    if (ui) { console.log('DESKTOP_EMAIL_UI_READY ' + JSON.stringify({ home: process.env.DSH_HOME, sessionId: agent.id })); return; }
  } finally { if (!ui) for (const handle of handles.reverse()) await handle.dispose(); }
  if (process.env.DSCODE_EMAIL_ELECTRON) process.send({ type: 'dscode-email-shutdown' });
  else ctx.get('appExit')(0);
}
