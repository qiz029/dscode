import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const GMAIL_SCOPES = ['gmail.readonly', 'gmail.labels', 'gmail.settings.basic'].map(scope => 'https://www.googleapis.com/auth/' + scope);
export function readGoogleClient(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')).installed; } catch { /* Report no content or secrets. */ }
  if (!value || typeof value.client_id !== 'string' || !value.client_id.endsWith('.apps.googleusercontent.com')) throw Error('Set DSCODE_GMAIL_CLIENT_FILE to a Google Desktop OAuth client JSON file.');
  return { client_id: value.client_id, ...(typeof value.client_secret === 'string' ? { client_secret: value.client_secret } : {}) };
}

export async function tokenRequest(params, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(), redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error(response.status === 400 ? 'Google authorization expired or was rejected. Reconnect Gmail.' : 'Google token request failed. Retry later.');
  const token = await response.json();
  if (typeof token.access_token !== 'string' || !token.access_token || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw Error('Google returned an invalid access token.');
  if (token.scope && !GMAIL_SCOPES.every(scope => token.scope.split(' ').includes(scope))) throw Error('Grant all three Gmail permissions, then reconnect.');
  return { access_token: token.access_token, expiresAt: Date.now() + token.expires_in * 1000,
    ...(typeof token.refresh_token === 'string' ? { refresh_token: token.refresh_token } : {}) };
}

export const openGoogleBrowser = url => new Promise((resolve, reject) => {
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 10000 }, error => error ? reject(Error('Could not open the browser for Google login.')) : resolve());
});

export async function authorizeGoogle(client, { fetchImpl = fetch, openBrowser = openGoogleBrowser, signal, timeoutMs = 180000 } = {}) {
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let resolveCode, rejectCode;
  const codeResult = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  codeResult.catch(() => {});
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (req.method !== 'GET' || url.pathname !== '/oauth/callback' || url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid callback.'); return; }
    if (url.searchParams.has('error')) { res.end('Google authorization was declined. Return to DSCODE.'); rejectCode(Error('Google authorization was declined.')); return; }
    const code = url.searchParams.get('code');
    if (!code) { res.writeHead(400).end('Missing code.'); return; }
    res.end('Authorization received. Return to DSCODE to see connection status.');
    resolveCode(code);
  });
  controller.signal.addEventListener('abort', () => rejectCode(Error('Google login cancelled or timed out.')), { once: true });
  try {
    if (signal?.aborted) throw Error('Google login cancelled.');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirect = 'http://127.0.0.1:' + server.address().port + '/oauth/callback';
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
      response_type: 'code', scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account',
      state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    await openBrowser(url.href);
    const code = await codeResult;
    const token = await tokenRequest({ ...client, code, redirect_uri: redirect, code_verifier: verifier, grant_type: 'authorization_code' }, { fetchImpl, signal: controller.signal });
    if (!token.refresh_token) throw Error('Google did not grant offline access. Reconnect Gmail.');
    return token;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    server.close(); server.closeAllConnections();
  }
}
