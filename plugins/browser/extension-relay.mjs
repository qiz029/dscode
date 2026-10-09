import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

export const extensionId = 'ehdpecpkmekimhklnpeagobiimnbadfh';

/** Single-use, loopback-only bridge. Losing either peer revokes the pairing. */
export async function createExtensionRelay() {
  const extensionToken = randomBytes(32).toString('hex');
  const clientToken = randomBytes(32).toString('hex');
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  let extension;
  let client;
  let closed = false;
  let ready = false;
  let timer;
  const listeners = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const socket of [client, extension]) socket?.terminate();
    sockets.close();
    server.close();
    for (const listener of listeners) listener();
  };
  server.on('upgrade', (req, socket, head) => {
    const origin = `127.0.0.1:${server.address()?.port}`;
    const isExtension = req.url === `/extension?token=${extensionToken}`;
    const isClient = req.url === `/cdp?token=${clientToken}`;
    if (closed || req.headers.host !== origin ||
        (isExtension ? !!extension || req.headers.origin !== `chrome-extension://${extensionId}` :
          isClient ? !!client || !ready || req.headers.origin !== undefined : true)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => {
      if (isExtension) extension = ws;
      else { client = ws; clearTimeout(timer); }
      ws.on('error', close);
      ws.on('close', close);
      ws.on('message', (data, binary) => {
        if (binary) return close();
        let value;
        try { value = JSON.parse(data.toString()); } catch { return close(); }
        if (isExtension && value?.type === 'ready') { ready = true; return; }
        if (isExtension && value?.type === 'keepalive') return;
        const peer = isExtension ? client : extension;
        if (peer?.readyState === WebSocket.OPEN) peer.send(data.toString());
      });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  timer = setTimeout(close, 5 * 60 * 1000);
  timer.unref();
  const base = `ws://127.0.0.1:${server.address().port}`;
  return {
    pairingUrl: `${base}/extension?token=${extensionToken}`,
    endpoint: `${base}/cdp?token=${clientToken}`,
    get ready() { return ready && !closed; },
    get closed() { return closed; },
    onClose(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close,
  };
}
