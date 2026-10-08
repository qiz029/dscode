import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { emailStore } from '../plugins/email/store.mjs';

export const inject = ['agents', 'agentPresets', 'permissionPresets', 'llm', 'tools', 'approval'];
export function apply(ctx) { void run(ctx).catch(error => {
  console.error(error.stack);
  if (process.env.DSCODE_EMAIL_ELECTRON) process.send({ type: 'dscode-email-failed' });
  else ctx.get('appExit')(1);
}); }
async function run(ctx) {
  await ctx.get('loader').await();
  const home = process.env.DSH_HOME, phase = process.env.DSCODE_EMAIL_PHASE, queue = [], results = [], approvals = [];
  const control = mode => writeFileSync(join(home, 'smtp-fixture.json'), JSON.stringify({ mode }));
  const traces = () => readFileSync(join(home, 'smtp-trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const submitted = () => traces().filter(row => row.message);
  const nativeTransport = nodemailer.createTransport;
  let transports = 0, outcome = 'allowed-once';
  // Test-only endpoint substitution, after checking the production restrictions.
  nodemailer.createTransport = options => {
    assert.equal(options.host, 'smtp.gmail.com'); assert.equal(options.port, 465); assert.equal(options.secure, true);
    assert.equal(options.tls.rejectUnauthorized, true); assert.equal(options.disableFileAccess, true); assert.equal(options.disableUrlAccess, true);
    assert.equal(options.auth.user, 'sender@example.test'); assert.equal(options.auth.pass, 'fixture-smtp-password');
    transports++;
    return nativeTransport({ ...options, host: '127.0.0.1', port: Number(process.env.DSCODE_SMTP_PORT) });
  };
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream() {
      if (queue.length) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: randomUUID(), name: 'send_email', arguments: JSON.stringify(queue.shift()) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local SMTP fixture finished.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-smtp-fixture'], new Adapter());
  const setup = async (scope, agent) => { await ctx.agentPresets.mount(scope, 'dscode');
    installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }); };
  const handle = phase === 'generate' ? await ctx.agents.create({ sessionId: 'desktop-smtp', meta: { cwd: process.cwd(), agentPreset: 'dscode' },
    agentOptions: { provider: 'desktop-smtp-fixture', model: 'fixture' }, setup }) : await ctx.agents.resume({ resumeSessionId: 'desktop-smtp', setup });
  const agent = handle.agent;
  ctx.permissionPresets.set(agent.session, 'workspace-write');
  assert.equal(ctx.approval.effectivePolicy(agent.session), 'ask');
  ctx.on('tools/result', (exec, result) => { if (exec.agent.id === agent.id && exec.name === 'send_email') results.push(result); });
  ctx.on('approval/request', (request, next) => {
    if (request.agent.id !== agent.id || request.toolName !== 'send_email') return next();
    assert.match(request.reason, /reviewer.*receiver@example.test/); approvals.push(outcome); return Promise.resolve(outcome);
  }, { prepend: true });
  const tool = (name, args) => ctx.tools.execute({ name, arguments: args, agent, callId: randomUUID(), signal: AbortSignal.timeout(10000) });
  const mail = { to: 'reviewer', resolved_to: 'receiver@example.test', subject: 'Desktop SMTP fixture', body: 'Local protocol check.\n.line', idempotency_key: 'accepted-once' };
  const send = async args => {
    const count = results.length; queue.push(args);
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Exercise the isolated local SMTP fixture.' }] }));
    await agent.whenIdle(); assert.equal(results.length, count + 1); return results.at(-1);
  };
  const receipt = async key => (await tool('email_send_status', { idempotency_key: key })).value;
  try {
    if (phase === 'generate') {
      assert(!(await tool('set_email_alias', { alias: 'reviewer', address: 'receiver@example.test' })).isError);
      const unconfigured = await send({ ...mail, idempotency_key: 'unconfigured' });
      assert.match(unconfigured.value.error, /Email inbox → Mailbox connection/);
      assert.match(unconfigured.value.error, /OAuth supports receiving only/);
      assert.equal((await receipt('unconfigured')).status, 'not_found'); assert.equal(transports, 0);
      emailStore(join(process.env.DSCODE_EMAIL_DIR, 'imap')).write('connection.json', { config: { host: 'imap.gmail.com', account: 'sender@example.test', password: 'fixture-smtp-password' } });
      outcome = 'rejected'; assert((await send({ ...mail, idempotency_key: 'rejected' })).isError);
      assert.equal((await receipt('rejected')).status, 'not_found'); assert.equal(transports, 0);
      outcome = 'allowed-once'; assert.equal((await send(mail)).value.status, 'accepted');
      assert.equal((await send(mail)).value.status, 'accepted'); assert.equal(transports, 1);
      const parsed = await simpleParser(submitted()[0].message);
      assert.equal(parsed.subject, '[ToAgent] Desktop SMTP fixture'); assert.equal(parsed.text.trim(), mail.body);
      assert.equal(parsed.from.value[0].address, 'sender@example.test'); assert.equal(parsed.to.value[0].address, mail.resolved_to);
      control('disconnect');
      assert.equal((await send({ ...mail, idempotency_key: 'uncertain-once' })).value.status, 'uncertain');
      assert.equal((await send({ ...mail, idempotency_key: 'uncertain-once' })).value.status, 'uncertain');
      assert.equal(transports, 2); assert.equal(submitted().length, 2);
    } else {
      assert(agent.session.snapshotEvents().some(event => event.type === 'approval/decided' && event.data.outcome === 'rejected'));
      assert.equal((await receipt(mail.idempotency_key)).status, 'accepted'); assert.equal((await receipt('uncertain-once')).status, 'uncertain');
      assert.equal((await send(mail)).value.status, 'accepted');
      assert.equal((await send({ ...mail, idempotency_key: 'uncertain-once' })).value.status, 'uncertain');
      assert.equal(transports, 0); assert.equal(submitted().length, 2);
      const mismatch = await send({ ...mail, body: 'Different content' }); assert.match(mismatch.value.error, /different email/); assert.equal(transports, 0);
      if (phase === 'unload') {
        control('hold'); const pending = send({ ...mail, idempotency_key: 'unload-drain' });
        for (let i = 0; i < 500 && submitted().length < 3; i++) await delay(20);
        assert.equal(submitted().length, 3);
        let disposed = false;
        const drain = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-email').fiber.dispose().then(() => { disposed = true; });
        await delay(50); assert.equal(disposed, false, 'Unload lost an in-flight SMTP outcome');
        control('accept'); await drain; await pending;
        assert.equal(ctx.tools.schemas(agent).some(tool => tool.name === 'send_email'), false);
        const path = join(process.env.DSCODE_EMAIL_DIR, 'outbox', createHash('sha256').update('unload-drain').digest('hex') + '.json');
        assert.equal(JSON.parse(readFileSync(path)).receipt.status, 'accepted');
      }
    }
    assert(approvals.length > 0, 'Native approval was bypassed');
    assert(!JSON.stringify(results).includes('fixture-smtp-password'));
    await ctx.get('sessions').flush(agent.session);
    console.log('DESKTOP_EMAIL_PASSED ' + JSON.stringify({ phase, nativeApproval: true, realNodemailer: true, loopbackEndpointSubstitution: true,
      durableAcceptedAndUncertain: true, duplicateRequestsDoNotResend: true,
      ...(phase === 'generate' ? { nativeRejectionNoTransport: true, plainTextMimeVerified: true } : { restartReceiptsPreserved: true, changedPayloadRejected: true }),
      ...(phase === 'unload' ? { inFlightOutcomeDrained: true } : {}) }));
  } finally { nodemailer.createTransport = nativeTransport; await handle.dispose(); }
  if (process.env.DSCODE_EMAIL_ELECTRON) process.send({ type: 'dscode-email-shutdown' });
  else ctx.get('appExit')(0);
}
