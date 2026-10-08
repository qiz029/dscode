import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { DesktopEmail } from './desktop-service.mjs';
import { createEmailContacts } from './contacts.mjs';
import { createEmailSender } from './smtp.mjs';
import { registerEmailTools } from '../email-tools/index.mjs';

export const inject = ['agents', 'agentPresets', 'sessions'];
export async function apply(ctx) {
  const service = new DesktopEmail({ home: resolveDshHome() });
  const contacts = createEmailContacts({ directory: service.inbox.directory });
  const sender = createEmailSender({ directory: service.inbox.directory,
    configurationHint: 'Open Email inbox → Mailbox connection and connect Gmail IMAP with an application password before sending. Gmail OAuth supports receiving only.' });
  const scopes = new Map(), sends = new Set();
  const mount = async agent => {
    if (service.closed || scopes.has(agent) || ctx.agentPresets.composedPreset(agent.ctx) !== 'dscode') return;
    const fiber = agent.ctx.inject(['tools', 'systemPrompt'], scope => {
      if (service.closed) return;
      registerEmailTools(scope, { contacts, sender: { status: key => sender.status(key), send: (...args) => {
        if (service.closed) throw Error('Desktop email is unavailable.');
        const task = sender.send(...args); sends.add(task);
        return task.finally(() => sends.delete(task));
      } } });
    });
    scopes.set(agent, fiber); agent.ctx.effect(() => () => scopes.delete(agent));
    await fiber; if (service.closed) await fiber.dispose();
  };
  ctx.provide('dscodeEmail', service);
  ctx.effect(() => async () => {
    await service.dispose();
    await Promise.all([...scopes.values()].map(fiber => fiber.dispose()));
    // SMTP acceptance can be uncertain after cancellation. Preserve its receipt.
    await Promise.allSettled([...sends]);
  }, 'dscode email drain');
  ctx.on('agent/created', ({ agent }) => mount(agent));
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({ path: '/api/dscode-email', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        const parsed = clientRequestSchema.safeParse(body);
        if (!parsed.success || parsed.data.method !== 'dscode-email') return new Response('Invalid email request', { status: 400 });
        const { rpcId, payload } = parsed.data;
        let result;
        try { result = { ok: true, value: await service.request(payload, ctx, request.signal) }; }
        catch (error) { result = { ok: false, error: { code: 'dscode-email',
          message: payload?.action === 'configure-gmail' ? 'Could not import the Google Desktop client JSON. Check the file and current connection.' : error.message, details: {} } }; }
        return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
      },
    }), 'dscode email rpc');
  }).then(undefined, () => ctx.logger.error('Desktop email transport failed.'));
  await Promise.all(ctx.agents.list().map(mount));
  service.start();
}
