// Only the guardian writes the queue. Its private socket is scoped to one trigger.
import { createConnection, createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadTriggerDefinitions } from './config.mjs';

export async function openSourceIngress({ home, project, definition, store }) {
  const directory = mkdtempSync('/tmp/dscode-source-');
  chmodSync(directory, 0o700);
  const path = join(directory, 'emit.sock');
  const token = randomBytes(32).toString('hex');
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5000, () => socket.destroy());
    let buffer = '', bytes = 0, done = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (done) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 140000) { done = true; socket.end(JSON.stringify({ error: 'event request too large' }) + '\n'); return; }
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      done = true;
      let response;
      try {
        const request = JSON.parse(buffer.slice(0, newline));
        if (request.token !== token || request.triggerId !== definition.id) throw new Error('source ingress scope mismatch');
        const current = loadTriggerDefinitions({ home, workspace: project }).definitions.find(d => d.id === definition.id);
        const saved = store.source(definition.id, project);
        if (!current?.enabled || current.workspace !== definition.workspace || JSON.stringify(current.source) !== JSON.stringify(definition.source) || saved?.desired !== 'running') throw new Error('source is stopped or its definition changed');
        const job = store.acceptEvent({ definition: current, project, payload: request.payload, eventId: request.eventId });
        response = { jobId: job.id, state: job.state, eventId: store.eventIdentity(job.id) };
      } catch (error) { response = { error: error.message }; }
      socket.end(JSON.stringify(response) + '\n');
    });
  });
  server.maxConnections = 16;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
  } catch (error) { server.close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  return { path, token, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  } };
}

export function emitToSource({ triggerId, eventId, payload, env = process.env }) {
  if (!eventId) throw new Error('script sources must supply a stable --event-id');
  return new Promise((resolve, reject) => {
    const socket = createConnection(env.DSCODE_SOURCE_SOCKET);
    let response = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('source ingress timed out; retry with the same eventId')); }, 5000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.end(JSON.stringify({ token: env.DSCODE_SOURCE_TOKEN, triggerId, eventId, payload }) + '\n'));
    socket.on('data', chunk => { response += chunk; if (response.length > 8192) socket.destroy(new Error('invalid source response')); });
    socket.once('error', reject);
    socket.once('close', () => clearTimeout(timer));
    socket.once('end', () => {
      try { const result = JSON.parse(response); if (result.error) throw new Error(result.error); resolve(result); }
      catch (error) { reject(error); }
    });
  });
}
