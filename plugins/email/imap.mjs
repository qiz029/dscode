import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createEmailInbox, normalizeEmail } from './inbox.mjs';
import { emailStore } from './store.mjs';

const MAX_SOURCE = 2 * 1024 * 1024;
const subjectMatches = value => typeof value === 'string' && /^\[ToAgent\](?:\s|$)/.test(value);
const identity = config => JSON.stringify([config.host, config.port, config.account, config.mailbox]);
const hash = data => createHash('sha256').update(data).digest('hex');

export function imapConfiguration(value) {
  if (!value || ['host', 'account', 'mailbox', 'password'].some(key => value[key] !== undefined && typeof value[key] !== 'string')) throw Error('Invalid IMAP configuration.');
  const config = { host: value?.host?.trim().toLowerCase() || 'imap.gmail.com', port: Number(value?.port ?? 993),
    account: value?.account?.trim(), mailbox: value?.mailbox?.trim() || 'INBOX', password: value?.password };
  if (!/^[a-z0-9.-]+$/.test(config.host) || config.host.length > 253) throw Error('Enter an IMAP hostname, without a URL or port.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw Error('Enter a valid TLS port.');
  if (typeof config.account !== 'string' || !config.account || config.account.length > 320 || /[\s\x00-\x1f\x7f]/.test(config.account)) throw Error('Enter your mailbox login address.');
  if (config.mailbox.length > 256 || /[\x00-\x1f\x7f]/.test(config.mailbox)) throw Error('Invalid mailbox folder.');
  if (typeof config.password !== 'string' || !config.password || config.password.length > 1024 || /[\x00-\x1f\x7f]/.test(config.password)) throw Error('Enter an application password.');
  if (config.host === 'imap.gmail.com') config.password = config.password.replace(/ /g, '');
  if (!config.password) throw Error('Enter an application password.');
  return config;
}

export async function imapEnvelope(source, metadata, state) {
  if (!Buffer.isBuffer(source) || source.length > MAX_SOURCE) return null;
  const received = new Date(metadata.internalDate).getTime();
  if (!Number.isFinite(received) || received < state.connectedAt) return null;
  const parsed = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, skipTextLinks: true });
  if (!subjectMatches(parsed.subject) || !parsed.text?.trim() || Buffer.byteLength(parsed.text) > 262144) return null;
  return normalizeEmail({ format: 'dscode.email.v1', connector: 'imap', account: state.config.account,
    id: hash(identity(state.config)) + ':' + hash(source), from: parsed.from?.text || 'Unknown sender',
    subject: parsed.subject, body: parsed.text, receivedAt: new Date(received).toISOString(), updatedAt: new Date(received).toISOString() });
}

export function createImapConnector({ inbox = createEmailInbox(), directory = join(inbox.directory, 'imap'),
  clientFactory = options => new ImapFlow(options), now = Date.now } = {}) {
  const store = emailStore(directory, 'IMAP');
  let working = false;
  const exclusive = async action => {
    if (working) return { busy: true };
    working = true;
    try { return await store.locked(action); } finally { working = false; }
  };
  async function withMailbox(config, signal, action) {
    const stop = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
    stop.throwIfAborted();
    const client = clientFactory({ host: config.host, port: config.port, secure: true,
      auth: { user: config.account, pass: config.password }, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true,
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 });
    client.on('error', () => {}); // Library errors are handled through operation promises, never logged.
    const abort = () => client.close();
    stop.addEventListener('abort', abort, { once: true });
    let lock;
    try {
      await client.connect(); stop.throwIfAborted();
      lock = await client.getMailboxLock(config.mailbox, { readOnly: true });
      const mailbox = client.mailbox;
      const uidValidity = String(mailbox?.uidValidity ?? '');
      const uidNext = Number(mailbox?.uidNext);
      if (!/^\d+$/.test(uidValidity) || uidValidity === '0' || !Number.isSafeInteger(uidNext) || uidNext < 1) throw Error('Invalid mailbox checkpoint');
      const result = await action(client, { uidValidity, uidNext }, stop);
      stop.throwIfAborted(); return result;
    } finally {
      stop.removeEventListener('abort', abort); lock?.release(); client.close();
    }
  }
  const publicState = state => ({ connected: !!state?.config, account: state?.config?.account,
    host: state?.config?.host || 'imap.gmail.com', port: state?.config?.port || 993,
    mailbox: state?.config?.mailbox || 'INBOX', lastSyncAt: state?.lastSyncAt,
    accepted: state?.accepted || 0, skipped: state?.skipped || 0, error: state?.error || null });
  return {
    status() { try { return publicState(store.read('connection.json')); } catch { return { connected: false, error: 'Cannot read IMAP settings.' }; } },
    connect(value, { signal } = {}) {
      return exclusive(async () => {
        const config = imapConfiguration(value), old = store.read('connection.json');
        if (old?.config && identity(old.config) !== identity(config)) throw Error('Reconnect the same IMAP account and folder.');
        try {
          return await withMailbox(config, signal, async (_, checkpoint, stop) => {
            stop.throwIfAborted();
            // IMAP INTERNALDATE has second precision; UIDNEXT excludes earlier mail.
            const state = { ...old, config, connectedAt: old?.connectedAt ?? Math.floor(now() / 1000) * 1000,
              uidValidity: old?.uidValidity ?? checkpoint.uidValidity, uidNext: old?.uidNext ?? checkpoint.uidNext, error: null };
            store.write('connection.json', state); return publicState(state);
          });
        } catch { throw Error(signal?.aborted ? 'IMAP connection cancelled.' : 'IMAP connection failed. Check host, folder and application password.'); }
      });
    },
    async sync({ signal, force = false } = {}) {
      if (!store.exists('connection.json')) return { connected: false };
      return exclusive(async () => {
        const state = store.read('connection.json');
        if (!state?.config) return { connected: false };
        if (!force && now() - (state.lastAttemptAt || 0) < 30000) return { throttled: true };
        state.lastAttemptAt = now(); store.write('connection.json', state);
        try {
          return await withMailbox(state.config, signal, async (client, checkpoint, stop) => {
            const recovery = checkpoint.uidValidity !== state.uidValidity;
            const start = recovery ? 1 : state.uidNext, end = checkpoint.uidNext - 1;
            let accepted = 0, skipped = 0;
            let nextUid = checkpoint.uidNext;
            if (start <= end) {
              const matches = await client.search({ uid: start + ':' + end, header: { subject: '[ToAgent]' }, deleted: false, draft: false,
                ...(recovery ? { since: new Date(state.connectedAt - 86400000) } : {}) }, { uid: true });
              const ids = [...new Set(matches || [])].filter(uid => Number.isSafeInteger(uid) && uid >= start && uid <= end).sort((a, b) => a - b);
              const batch = ids.slice(0, 50);
              if (batch.length < ids.length) nextUid = batch.at(-1) + 1;
              for (const uid of batch) {
                stop.throwIfAborted();
                const meta = await client.fetchOne(uid, { envelope: true, internalDate: true, size: true, flags: true }, { uid: true });
                if (!meta || !subjectMatches(meta.envelope?.subject) || !(meta.internalDate instanceof Date) || meta.internalDate.getTime() < state.connectedAt
                  || !Number.isFinite(meta.size) || meta.size > MAX_SOURCE || meta.flags?.has('\\Deleted') || meta.flags?.has('\\Draft')) { skipped++; continue; }
                // Explicit BODY.PEEK with a byte cap; never mutate Seen or download unbounded attachments.
                const fetched = await client.fetchOne(uid, { source: { start: 0, maxLength: MAX_SOURCE + 1 } }, { uid: true });
                if (!fetched) { skipped++; continue; }
                if (!Buffer.isBuffer(fetched.source) || fetched.source.length < meta.size) throw Error('Incomplete IMAP body');
                let mail;
                try { mail = await imapEnvelope(fetched.source, meta, state); } catch { skipped++; continue; }
                if (mail) { inbox.receive(mail); accepted++; } else skipped++;
              }
            }
            stop.throwIfAborted();
            store.write('connection.json', { ...state, ...checkpoint, uidNext: nextUid, lastSyncAt: now(), accepted, skipped, error: null });
            return { accepted, skipped };
          });
        } catch {
          const message = signal?.aborted ? 'IMAP sync cancelled.' : 'IMAP sync failed. Press r to retry or i to update credentials.';
          store.write('connection.json', { ...state, error: message }); throw Error(message);
        }
      });
    },
  };
}
