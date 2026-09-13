import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createEmailInbox, normalizeEmail } from './inbox.mjs';
import { gmailStore } from './gmail-store.mjs';
import { readGoogleClient, authorizeGoogle, tokenRequest } from './gmail-oauth.mjs';

const LABEL = 'ToAgent';
const FILTER = { subject: '[ToAgent]' };
const isId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value);
const historyId = value => { if (typeof value !== 'string' || !/^\d+$/.test(value)) throw Error('Invalid Gmail sync cursor.'); return value; };
const header = (part, name) => (part?.headers || []).find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
const decode = (data, charset = 'utf-8') => {
  if (typeof data !== 'string' || data.length > 400000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data)) throw Error('Invalid or oversized plain-text body.');
  try { return new TextDecoder(charset, { fatal: true }).decode(Buffer.from(data, 'base64url')); }
  catch { throw Error('Invalid plain-text encoding.'); }
};
export function decodeHeader(value) {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, type, data) => {
    const bytes = type.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : Buffer.from(data.replace(/_/g, ' ').replace(/=([a-f0-9]{2})/gi, (_, n) => String.fromCharCode(parseInt(n, 16))), 'latin1');
    try { return new TextDecoder(charset, { fatal: true }).decode(bytes); }
    catch { throw Error('Invalid header encoding.'); }
  });
}
export function matchesGmailMessage(message, state) {
  const date = Number(message.internalDate);
  return Array.isArray(message.labelIds) && message.labelIds.includes(state.labelId)
    && !message.labelIds.some(id => ['SPAM', 'TRASH', 'DRAFT', 'SENT'].includes(id))
    && Number.isFinite(date) && date >= state.connectedAt
    && /^\[ToAgent\](?:\s|$)/.test(decodeHeader(header(message.payload, 'subject')));
}
export async function gmailEnvelope(message, state, getAttachment) {
  if (!matchesGmailMessage(message, state)) return null;
  const findPlain = (part, depth = 0) => {
    if (!part || depth > 20 || part.filename || /^attachment\b/i.test(header(part, 'content-disposition'))) return null;
    if (part.mimeType === 'text/plain') return part;
    if (!part.mimeType?.startsWith('multipart/')) return null;
    for (const child of part.parts || []) { const found = findPlain(child, depth + 1); if (found) return found; }
    return null;
  };
  const part = findPlain(message.payload);
  if (!part || part.body?.size > 262144) return null;
  const body = part.body?.data ?? (part.body?.attachmentId ? (await getAttachment(part.body.attachmentId)).data : '');
  const charset = header(part, 'content-type').match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1] || 'utf-8';
  return normalizeEmail({ format: 'dscode.email.v1', connector: 'gmail', account: state.account,
    id: message.id, from: decodeHeader(header(message.payload, 'from')), subject: decodeHeader(header(message.payload, 'subject')),
    body: decode(body, charset), receivedAt: new Date(Number(message.internalDate)).toISOString(),
    updatedAt: new Date(Number(message.internalDate)).toISOString() });
}

export function createGmailConnector({ inbox = createEmailInbox(), directory = join(inbox.directory, 'gmail'), fetchImpl = fetch, authorize = authorizeGoogle, openBrowser, now = Date.now } = {}) {
  const store = gmailStore(directory);
  const clientPath = () => process.env.DSCODE_GMAIL_CLIENT_FILE || join(directory, 'client.json');
  let working = false;
  const exclusive = async action => {
    if (working) return { busy: true };
    working = true;
    try { return await store.locked(action); } finally { working = false; }
  };
  async function api(token, path, { method = 'GET', body, signal } = {}) {
    const response = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
      method, headers: { Authorization: 'Bearer ' + token.access_token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      const error = Error(response.status === 401 ? 'Gmail authorization expired. Press g to reconnect.' : response.status === 403 ? 'Gmail access denied. Check API enablement and granted permissions, then reconnect.' : 'Gmail request failed (' + response.status + '). Retry sync.');
      error.status = response.status; throw error;
    }
    return response.status === 204 ? {} : response.json();
  }
  async function access(signal, force = false) {
    const token = store.read('tokens.json');
    if (!token?.refresh_token) throw Error('Gmail is not connected. Press g to connect.');
    if (!force && token.expiresAt > now() + 60000) return token;
    const next = { ...token, ...await tokenRequest({ ...readGoogleClient(clientPath()), grant_type: 'refresh_token', refresh_token: token.refresh_token }, { fetchImpl, signal }) };
    store.write('tokens.json', next); return next;
  }
  async function provision(token, signal) {
    const labels = await api(token, 'labels', { signal });
    let label = labels.labels?.find(label => label.name === LABEL);
    if (!label) label = await api(token, 'labels', { method: 'POST', body: { name: LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show' }, signal });
    if (!isId(label.id)) throw Error('Invalid Gmail ToAgent label.');
    const filters = await api(token, 'settings/filters', { signal });
    const found = filters.filter?.some(filter => JSON.stringify(filter.criteria) === JSON.stringify(FILTER)
      && filter.action?.addLabelIds?.includes(label.id) && !filter.action?.removeLabelIds?.length && !filter.action?.forward);
    if (!found) await api(token, 'settings/filters', { method: 'POST', body: { criteria: FILTER, action: { addLabelIds: [label.id] } }, signal });
    return label.id;
  }
  async function collect(token, state, signal) {
    const ids = new Set();
    let cursor, pageToken;
    try {
      do {
        const query = new URLSearchParams({ startHistoryId: state.historyId, labelId: state.labelId, maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        const page = await api(token, 'history?' + query, { signal });
        for (const event of page.history || []) for (const change of [...(event.messagesAdded || []), ...(event.labelsAdded || [])]) {
          if (isId(change.message?.id)) ids.add(change.message.id);
        }
        cursor = historyId(page.historyId); pageToken = page.nextPageToken;
      } while (pageToken);
    } catch (error) {
      if (error.status !== 404) throw error;
      // Expired history: capture a new boundary BEFORE listing so changes that
      // race this recovery are replayed on the next incremental pass.
      cursor = historyId((await api(token, 'profile', { signal })).historyId);
      pageToken = undefined;
      do {
        const query = new URLSearchParams({ labelIds: state.labelId, q: 'after:' + (Math.floor(state.connectedAt / 1000) - 1), maxResults: '100', ...(pageToken ? { pageToken } : {}) });
        const page = await api(token, 'messages?' + query, { signal });
        for (const message of page.messages || []) if (isId(message.id)) ids.add(message.id);
        pageToken = page.nextPageToken;
      } while (pageToken);
    }
    let accepted = 0, skipped = 0;
    for (const id of ids) {
      let metadata;
      try { metadata = await api(token, 'messages/' + id + '?format=metadata&metadataHeaders=Subject', { signal }); }
      catch (error) { if (error.status === 404) { skipped++; continue; } throw error; }
      let matches;
      try { matches = matchesGmailMessage(metadata, state); } catch { matches = false; }
      if (!matches) { skipped++; continue; }
      let message;
      try { message = await api(token, 'messages/' + id + '?format=full', { signal }); }
      catch (error) { if (error.status === 404) { skipped++; continue; } throw error; }
      let envelope;
      try { envelope = await gmailEnvelope(message, state, attachmentId => {
        if (!isId(attachmentId)) throw Error('Invalid body attachment.');
        return api(token, 'messages/' + id + '/attachments/' + attachmentId, { signal });
      }); } catch (error) {
        // Network/body fetch failures must retain the cursor for retry.
        if (error.status || signal?.aborted || error.name === 'TypeError' || error.name === 'TimeoutError') throw error;
        skipped++; continue;
      }
      if (envelope) { inbox.receive(envelope); accepted++; } else skipped++;
    }
    return { ...state, historyId: cursor, lastSyncAt: now(), accepted, skipped, error: null };
  }
  return {
    directory,
    configure(path) {
      return exclusive(async () => {
        if (process.env.DSCODE_GMAIL_CLIENT_FILE) throw Error('DSCODE_GMAIL_CLIENT_FILE is set. Unset it before importing a client.');
        const client = readGoogleClient(path);
        if (store.exists('tokens.json') && readGoogleClient(clientPath()).client_id !== client.client_id) throw Error('Gmail already uses a different OAuth client. Keep the connected client.');
        store.write('client.json', { installed: client });
        return { configured: true };
      });
    },
    status() {
      try {
        const state = store.read('state.json');
        return { configured: existsSync(clientPath()), connected: !!state?.account && store.exists('tokens.json'), account: state?.account,
          lastSyncAt: state?.lastSyncAt, accepted: state?.accepted || 0, skipped: state?.skipped || 0, error: state?.error || null };
      } catch { return { connected: false, error: 'Cannot read local Gmail state.' }; }
    },
    connect({ signal } = {}) {
      return exclusive(async () => {
        const client = readGoogleClient(clientPath());
        const token = await authorize(client, { fetchImpl, openBrowser, signal });
        const profile = await api(token, 'profile', { signal });
        if (typeof profile.emailAddress !== 'string' || !profile.emailAddress.includes('@')) throw Error('Google returned an invalid account.');
        const old = store.read('state.json');
        if (old?.account && old.account !== profile.emailAddress) throw Error('One Gmail account is supported. Reconnect the original account.');
        const labelId = await provision(token, signal);
        const boundary = historyId((await api(token, 'profile', { signal })).historyId);
        const state = { account: profile.emailAddress, labelId, connectedAt: old?.connectedAt ?? now(),
          historyId: old?.historyId ?? boundary, lastSyncAt: old?.lastSyncAt ?? null, error: null };
        signal?.throwIfAborted();
        store.write('tokens.json', token);
        store.write('state.json', state);
        return { connected: true, account: state.account };
      });
    },
    async sync({ signal, force = false } = {}) {
      if (!store.exists('state.json')) return { connected: false };
      return exclusive(async () => {
        const state = store.read('state.json');
        if (!state?.account) return { connected: false };
        if (!force && now() - (state.lastAttemptAt || 0) < 30000) return { throttled: true };
        state.lastAttemptAt = now(); store.write('state.json', state);
        try {
          let next;
          try { next = await collect(await access(signal), state, signal); }
          catch (error) { if (error.status !== 401) throw error; next = await collect(await access(signal, true), state, signal); }
          signal?.throwIfAborted();
          store.write('state.json', next); return { accepted: next.accepted, skipped: next.skipped };
        } catch (error) {
          const safe = error.status ? error.message : /^(Google|Gmail|Grant|Set DSCODE_|Cannot read|Invalid Gmail)/.test(error.message) ? error.message : 'Gmail sync interrupted. Retry sync.';
          store.write('state.json', { ...state, error: safe }); throw Error(safe);
        }
      });
    },
  };
}
