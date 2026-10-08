import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { assertUsableApiKey } from '@deepseek-ai/dsh-llm';

const keyRef = 'OPENROUTER_API_KEY';
const facts = value => ({ configured: value?.configured === true, writable: value?.writable === true, source: value?.source });

/** A fixed account surface; clients cannot choose arbitrary credential references. */
export async function providerAccountRequest(ctx, payload) {
  const credentials = ctx.get('credentials'), login = ctx.get('dscodeOpenCodeLogin');
  if (!credentials || !login) throw Error('DSCODE accounts are unavailable.');
  let notice;
  switch (payload?.action) {
    case 'status': break;
    case 'save-openrouter': {
      if ((await credentials.describe(keyRef)).writable !== true) throw Error('OpenRouter credentials are controlled by the launching environment.');
      if (typeof payload.key !== 'string' || payload.key.length > 4096) throw Error('Invalid API key.');
      const key = assertUsableApiKey(payload.key.trim(), 'DSCODE OpenRouter', keyRef);
      await credentials.set(keyRef, key);
      notice = 'OpenRouter key saved. Select a model under DSCODE OpenRouter.';
      break;
    }
    case 'remove-openrouter':
      if ((await credentials.describe(keyRef)).writable !== true) throw Error('OpenRouter credentials are controlled by the launching environment.');
      await credentials.unset(keyRef); notice = 'Saved OpenRouter key removed.'; break;
    case 'login-opencode': {
      const result = await login.login('en');
      if (!result.ok) throw Error(result.lines.join('\n'));
      notice = result.lines.join('\n');
      break;
    }
    case 'cancel-opencode': notice = login.cancel('en'); break;
    case 'logout-opencode': notice = await login.logout('en'); break;
    default: throw Error('Unknown DSCODE account action.');
  }
  return {
    openrouter: facts(await credentials.describe(keyRef)),
    grok: facts(await credentials.describe('GROK_CLI_TOKEN')),
    opencode: { ...facts(await credentials.describe('OPENCODE_OAUTH')), pending: login.attempt !== undefined, lines: await login.status('en') },
    ...(notice ? { notice } : {}),
  };
}

export function apply(ctx) {
  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({ path: '/api/dscode-accounts', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        const parsed = clientRequestSchema.safeParse(body);
        if (!parsed.success || parsed.data.method !== 'dscode-accounts') return new Response('Invalid account request', { status: 400 });
        const { rpcId, payload } = parsed.data;
        let result;
        try { result = { ok: true, value: await providerAccountRequest(ctx, payload) }; }
        catch (error) {
          const secret = typeof payload?.key === 'string' ? payload.key.trim() : '';
          const message = String(error.message ?? 'Account request failed.');
          result = { ok: false, error: { code: 'dscode-accounts', message: secret ? message.replaceAll(secret, '[redacted]') : message, details: {} } };
        }
        return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
      },
    }), 'dscode-accounts.rpc');
  }).then(undefined, error => { ctx.logger.error(`Account transport failed: ${error.message}`); });
}
