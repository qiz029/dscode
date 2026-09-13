import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { authorizeGoogle, GMAIL_SCOPES, tokenRequest } from '../plugins/email/gmail-oauth.mjs';

const client = { client_id: 'fixture.apps.googleusercontent.com', client_secret: 'test-only' };
test('real loopback OAuth checks state and exchanges PKCE code without exposing tokens', async () => {
  let authorization, tokenBody;
  const token = await authorizeGoogle(client, {
    openBrowser: async raw => {
      authorization = new URL(raw);
      assert.equal(authorization.origin, 'https://accounts.google.com');
      assert.equal(authorization.searchParams.get('access_type'), 'offline');
      assert.equal(authorization.searchParams.get('scope'), GMAIL_SCOPES.join(' '));
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.search = new URLSearchParams({ state: 'wrong', code: 'test-code' }).toString();
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', authorization.searchParams.get('state'));
      const response = await fetch(callback);
      assert.equal(response.status, 200);
      assert(!(await response.text()).includes('test-code'));
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://oauth2.googleapis.com/token'); tokenBody = new URLSearchParams(options.body);
      assert.equal(tokenBody.get('code'), 'test-code');
      assert.equal(tokenBody.get('grant_type'), 'authorization_code');
      assert.equal(createHash('sha256').update(tokenBody.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, scope: GMAIL_SCOPES.join(' ') });
    },
  });
  assert.equal(token.refresh_token, 'fixture-refresh');
  await assert.rejects(fetch(authorization.searchParams.get('redirect_uri')), /fetch failed/);
});

test('cancelled/denied OAuth releases the listener and never exchanges a token', async () => {
  for (const mode of ['cancel', 'deny']) {
    const controller = new AbortController(); let callback;
    await assert.rejects(authorizeGoogle(client, { signal: controller.signal,
      openBrowser: async raw => {
        const url = new URL(raw); callback = url.searchParams.get('redirect_uri');
        if (mode === 'cancel') controller.abort();
        else await fetch(callback + '?' + new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied' }));
      }, fetchImpl: async () => assert.fail('cancel must not exchange a code'),
    }), /cancelled|declined/);
    await assert.rejects(fetch(callback), /fetch failed/);
  }
});

test('token errors are redacted and partial Gmail grants fail closed', async () => {
  await assert.rejects(tokenRequest(client, { fetchImpl: async () => Response.json({ error_description: 'private-token-must-not-leak' }, { status: 400 }) }), error => !error.message.includes('private-token') && /Reconnect/.test(error.message));
  await assert.rejects(tokenRequest(client, { fetchImpl: async () => Response.json({ access_token: 'test', expires_in: 3600, scope: GMAIL_SCOPES[0] }) }), /all three/);
});
