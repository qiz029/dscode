// Client half of the local carrier. `fetch` and `openStream` match
// dsh-client-connection's ClientTransportHooks, so a Cordis client can install
// them directly; `call` is the decoded unary form for scripts.
//
// A target is either a Unix socket path (the local Host) or `{url, token}` for
// a runtime served over TCP by `dscode server`.
import { Agent, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ndjson, STREAM_PATH } from './index.mjs';

export { VERSION } from './index.mjs';

// Unary calls reuse connections; streams hold theirs for their lifetime. Keepalive
// probes stop an idle stream from being dropped by NAT between the two machines.
const remoteAgent = new Agent({ keepAlive: true, keepAliveMsecs: 30_000 });

/** Whether a target names a runtime reached over TCP. */
export const isRemoteTarget = target => typeof target === 'object' && target !== null;

/** Display form of a target, without its token. */
export const describeTarget = target => isRemoteTarget(target) ? new URL(target.url).host : target;

/** node:http request options addressing one path on a target. */
export function requestOptions(target, path, method, headers = {}) {
  if (!isRemoteTarget(target)) return { socketPath: target, path, method, headers };
  const url = new URL(target.url);
  if (url.protocol !== 'http:') throw Error(`unsupported runtime address ${target.url}; expected http://host:port`);
  // WHATWG URLs retain IPv6 brackets; node:http expects the bare address.
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  return {
    host, port: Number(url.port || 80), path, method, agent: remoteAgent,
    headers: { ...headers, authorization: `Bearer ${target.token}` },
  };
}

/** The carrier target named by the environment the launcher gives a terminal client. */
export function targetFromEnv(env = process.env) {
  if (env.DSCODE_RUNTIME_URL) return { url: env.DSCODE_RUNTIME_URL, token: env.DSCODE_RUNTIME_TOKEN ?? '' };
  return env.DSCODE_RUNTIME_SOCKET || undefined;
}

/** Fetch-shaped unary transport over the Unix socket or TCP. */
export function socketFetch(target) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    if (init.signal?.aborted) { reject(init.signal.reason); return; }
    const url = new URL(String(input), 'http://localhost');
    const req = request(requestOptions(target, url.pathname + url.search, init.method ?? 'GET', Object.fromEntries(new Headers(init.headers))), res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    const abort = () => req.destroy(init.signal.reason);
    init.signal?.addEventListener('abort', abort, { once: true });
    req.once('close', () => init.signal?.removeEventListener('abort', abort));
    req.end(init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(init.body));
  });
}

/** Decoded unary call through the shared /api channel; Typert payloads carry one `args` object. */
export async function call(target, method, args, signal) {
  const payload = { args };
  const rpcId = randomUUID();
  const response = await socketFetch(target)(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { throw Error(`/api ${method} returned ${response.status}: ${raw.slice(0, 200)}`); }
  if (body?.type === 'server-response' && response.status === 401) throw Object.assign(Error(body.result.error.message), { code: body.result.error.code });
  if (body?.type !== 'server-response' || body.rpcId !== rpcId) throw Error(`unexpected /api response (${response.status})`);
  return body.result;
}

/** One DSCODE registry operation; resolves its value or throws its {code, message} failure. */
export async function callDscode(target, name, args = {}, signal) {
  const response = await socketFetch(target)(`/dscode/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }), signal });
  const result = await response.json();
  if (result?.ok === true) return result.value ?? undefined;
  throw Object.assign(Error(result?.error?.message ?? `DSCODE ${name} failed (${response.status})`), { name: 'RemoteFailure', code: result?.error?.code ?? 'dscode/internal' });
}

/** Open one DSCODE registry stream; uplink items reach the Host stream in order. */
export function openDscodeStream(target, name, args = {}, signal, uplink) {
  return openStream(target, `dscode/${name}`, { args }, signal, uplink);
}

/** Gateway stream opener: yields decoded items, throws the Remote failure on {error}. */
export async function* openStream(target, endpoint, payload, signal, uplink) {
  signal?.throwIfAborted();
  const options = requestOptions(target, STREAM_PATH, 'POST', { 'content-type': 'application/x-ndjson' });
  // A stream owns its connection for its lifetime, so it never enters the pool;
  // keepalive probes still guard an idle one against NAT timeouts.
  const req = request(isRemoteTarget(target) ? { ...options, agent: false } : options);
  if (isRemoteTarget(target)) req.on('socket', socket => socket.setKeepAlive(true, 30_000));
  const response = new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
  const abort = () => req.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  req.write(JSON.stringify({ endpoint, payload }) + '\n');
  const pump = (async () => {
    if (uplink) for await (const item of uplink) req.write(JSON.stringify(item) + '\n');
  })().catch(() => req.destroy());
  try {
    const res = await response;
    for await (const frame of ndjson(res.setEncoding('utf8'))) {
      if ('item' in frame) yield frame.item;
      else if (frame.error) throw Object.assign(Error(frame.error.message ?? frame.error.code ?? 'remote stream failed'), { remote: frame.error });
      else if (frame.end) return;
    }
    if (!signal?.aborted) throw Error('stream closed without an end frame');
  } finally {
    signal?.removeEventListener('abort', abort);
    // An uplink may never settle; closing the request ends its writes without waiting for it.
    req.destroy(); void pump;
  }
}

/** ClientTransportHooks for installConnection(ctx, { transport }). */
export function transportHooks(target) {
  return { fetch: socketFetch(target), openStream: (endpoint, payload, signal, uplink) => openStream(target, endpoint, payload, signal, uplink), ownsHost: true };
}
