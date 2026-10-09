/* global chrome */
import { SharedTabs } from './protocol.mjs';

let state;
let pending = false;
let message = 'Not sharing.';

async function stop(reason = 'Sharing stopped.') {
  const current = state;
  state = undefined;
  message = reason;
  if (current) {
    clearInterval(current.timer);
    current.cancelConnect?.();
    current.socket?.close();
    await current.tabs.stop();
  }
  // Detaching may finish after the user pairs a different tab. That new
  // connection owns the badge; an older stop must not hide active sharing.
  if (!state) await chrome.action.setBadgeText({ text: '' });
}

async function pair(url, tabId) {
  if (state || pending) throw Error('Stop sharing before pairing another session.');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.hash || endpoint.pathname !== '/extension' ||
      !/^\?token=[a-f0-9]{64}$/.test(endpoint.search)) throw Error('Paste the local pairing link from DSCODE.');
  pending = true;
  message = 'Pairing with DSCODE.';
  const current = { tabs: new SharedTabs({
    tabs: chrome.tabs, debugger: chrome.debugger,
    version: () => ({ protocolVersion: '1.3', product: `Chrome/${navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'unknown'}`,
      revision: '', userAgent: navigator.userAgent, jsVersion: '' }),
  }, event => { if (current.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify(event)); }) };
  state = current;
  try {
    await current.tabs.share(tabId);
    if (state !== current) throw Error('Pairing was cancelled.');
    current.socket = new WebSocket(endpoint.href);
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        current.cancelConnect = undefined;
        current.socket.onopen = current.socket.onerror = current.socket.onclose = null;
        if (error) reject(error); else resolve();
      };
      const timer = setTimeout(() => finish(Error('Could not connect to DSCODE. Generate a new pairing link.')), 10000);
      current.cancelConnect = () => finish(Error('Pairing was cancelled.'));
      current.socket.onopen = () => finish();
      current.socket.onerror = current.socket.onclose = () => finish(Error('Could not connect to DSCODE.'));
    });
    if (state !== current) throw Error('Pairing was cancelled.');
    current.socket.onclose = () => { if (state === current) void stop('DSCODE disconnected. Pair again to share.'); };
    current.socket.onerror = () => { if (state === current) void stop('Connection failed. Pair again to share.'); };
    current.socket.onmessage = async event => {
      let command;
      try { command = JSON.parse(event.data); } catch { await stop('Invalid connection message.'); return; }
      if (!Number.isSafeInteger(command.id) || typeof command.method !== 'string') { await stop('Invalid connection command.'); return; }
      let response;
      try { response = { result: await current.tabs.command(command) }; }
      catch (error) { response = { error: { code: -32000, message: error.message } }; }
      if (state === current && current.socket.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}), ...response }));
    };
    current.socket.send(JSON.stringify({ type: 'ready' }));
    current.timer = setInterval(() => { if (current.socket.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: 'keepalive' })); }, 20000);
    message = 'Sharing with DSCODE.';
    await chrome.action.setBadgeText({ text: 'ON' });
    await chrome.action.setBadgeBackgroundColor({ color: '#bd4520' });
  } catch (error) { if (state === current) await stop(error.message); throw error; }
  finally { pending = false; }
}

chrome.runtime.onMessage.addListener((request, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  (async () => {
    if (request.action === 'pair') await pair(request.url, request.tabId);
    else if (request.action === 'share') {
      if (!state || pending) throw Error('Pair with DSCODE first.');
      await state.tabs.share(request.tabId);
    } else if (request.action === 'stop') await stop();
    else if (request.action !== 'status') throw Error('Unknown action.');
    return { message, pending, shared: [...(state?.tabs.tabs.values() ?? [])].map(t => ({ title: t.title, url: t.url })), connected: !!state && !pending };
  })().then(respond, error => respond({ error: error.message }));
  return true;
});
chrome.debugger.onEvent.addListener((source, method, params) => state?.tabs.debuggerEvent(source, method, params));
chrome.debugger.onDetach.addListener((source, reason) => {
  if (!state?.tabs.tabs.has(source.tabId)) return;
  if (reason === 'target_closed') state.tabs.remove(source.tabId);
  else void stop('Browser debugging was cancelled. Pair again to share.');
});
chrome.tabs.onUpdated.addListener((id, change) => state?.tabs.update(id, change));
chrome.tabs.onRemoved.addListener(id => state?.tabs.remove(id));
