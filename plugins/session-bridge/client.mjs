import { createConnection } from 'node:net';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { socketDirectory } from './paths.mjs';

export const CLIENT_COMMANDS = ['sessions', 'send', 'reply', 'read', 'watch', 'mailbox', 'watch-mailbox', 'cancel', 'new-task'];
export async function* exchange(path, request, { signal } = {}) {
  const socket = createConnection({ path });
  socket.setEncoding('utf8');
  socket.setTimeout(10000, () => socket.destroy(Error('DSCODE endpoint timed out')));
  const abort = () => socket.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    socket.write(JSON.stringify(request) + '\n');
    let buffer = '';
    for await (const chunk of socket) {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) throw Error('DSCODE response exceeds limit');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (value.error) throw Object.assign(Error(value.error), { code: value.code });
        if (value.type === 'ready') socket.setTimeout(0);
        yield value;
      }
    }
    if (buffer.trim()) throw Error('Incomplete DSCODE response; retry with the same requestId/cursor');
  } finally { signal?.removeEventListener('abort', abort); socket.destroy(); }
}
export async function request(path, payload) {
  for await (const value of exchange(path, payload)) return value.result;
  throw Error('DSCODE connection closed before acknowledgement; retry with the same requestId');
}
export async function discover(home) {
  let directory;
  try { directory = socketDirectory(home); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const endpoints = readdirSync(directory).filter(n => /^\d+-[a-f0-9]{8}\.sock$/.test(n));
  const results = await Promise.all(endpoints.map(async name => {
    const path = join(directory, name);
    try { return (await request(path, { method: 'list' })).map(session => ({ ...session, socket: path })); }
    catch (error) { if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) return []; throw error; }
  }));
  return results.flat();
}
export function resolveSession(sessions, id) {
  const exact = sessions.filter(s => s.id === id);
  const matches = exact.length ? exact : sessions.filter(s => s.id.startsWith(id));
  if (matches.length !== 1) throw Error(matches.length ? 'Ambiguous session; use its complete ID' : 'No active session found. Run dscode sessions or open the session in dscode first.');
  return matches[0];
}
export function parseClientArgs(argv) {
  const [command, ...args] = argv;
  const result = { command, mode: 'queue', source: 'cli', after: command.includes('mailbox') ? 0 : -1, limit: 100, requestId: randomUUID() };
  if (!CLIENT_COMMANDS.includes(command)) throw Error('Unknown session command');
  if (command !== 'sessions') { result.sessionId = args.shift(); if (!result.sessionId || result.sessionId.startsWith('-')) throw Error(`Usage: dscode ${command} SESSION_ID`); }
  const text = []; let modeSet = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--') { text.push(...args); break; }
    if (['--steer', '--defer'].includes(arg) && ['send', 'reply'].includes(command)) {
      if (modeSet) throw Error('Choose only one of --steer and --defer');
      modeSet = true; result.mode = arg === '--steer' ? 'steer' : 'defer'; continue;
    }
    const names = { '--source': 'source', '--title': 'title', '--kind': 'kind', '--reply-to': 'inReplyTo', '--request-id': 'requestId', '--after': 'after', '--limit': 'limit', '--home': 'home' };
    if (names[arg]) {
      const allowed = arg === '--home' || command === 'send' && ['--source', '--title', '--request-id', '--kind'].includes(arg) || command === 'reply' && ['--reply-to', '--request-id'].includes(arg) || ['read', 'watch', 'mailbox', 'watch-mailbox'].includes(command) && arg === '--after' || ['read', 'mailbox'].includes(command) && arg === '--limit';
      if (!allowed || !args.length) throw Error(`Invalid ${arg} option`);
      const value = args.shift(); result[names[arg]] = ['--after', '--limit'].includes(arg) ? Number(value) : value;
    } else if (arg.startsWith('-')) throw Error(`Unknown option ${arg}`);
    else text.push(arg);
  }
  if (['send', 'reply'].includes(command)) { result.text = text.join(' '); if (!result.text.trim()) throw Error('Send requires message text'); }
  else if (command === 'cancel' && text.length === 1) result.messageId = text[0];
  else if (text.length) throw Error('Unexpected arguments');
  if (command === 'reply' && !result.inReplyTo) throw Error('Reply requires --reply-to REQUEST_MESSAGE_ID');
  if (command === 'cancel' && !result.messageId) throw Error('Cancel requires MESSAGE_ID');
  if (result.kind && !['request', 'notify'].includes(result.kind)) throw Error('Kind must be request or notify');
  return result;
}
export async function runClient(argv, defaultHome) {
  const options = parseClientArgs(argv);
  const sessions = await discover(options.home ?? defaultHome);
  if (options.command === 'sessions') { console.log(JSON.stringify(sessions, null, 2)); return; }
  const session = resolveSession(sessions, options.sessionId);
  const payload = { method: options.command, sessionId: session.id, after: options.after, limit: options.limit,
    text: options.text, title: options.title, mode: options.mode, source: options.source, requestId: options.requestId,
    kind: options.kind, inReplyTo: options.inReplyTo, messageId: options.messageId };
  if (!['watch', 'watch-mailbox'].includes(options.command)) {
    // Print the identity before dispatch so even a lost ACK can be retried.
    if (['send', 'reply'].includes(options.command)) process.stderr.write(`requestId: ${options.requestId}\n`);
    console.log(JSON.stringify(await request(session.socket, payload), null, 2)); return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort(); process.once('SIGINT', abort);
  let closed = false;
  try {
    for await (const value of exchange(session.socket, payload, { signal: controller.signal })) {
      await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()));
      if (value.type === 'closed') closed = true;
    }
    if (!closed && !controller.signal.aborted) throw Error('Stream disconnected. Reconnect with --after set to the last received event seq.');
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { process.off('SIGINT', abort); }
}
