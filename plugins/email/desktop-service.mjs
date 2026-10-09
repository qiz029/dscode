import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { createEmailInbox, emailKey, emailPrompt, emailText } from './inbox.mjs';
import { createImapConnector } from './imap.mjs';
import { createGmailConnector } from './gmail.mjs';
import { emailStore } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const revision = mail => hash(JSON.stringify(mail));
const summary = mail => ({ key: emailKey(mail), revision: revision(mail), from: emailText(mail.from),
  subject: emailText(mail.subject), account: emailText(mail.account), updatedAt: mail.updatedAt });

/** Shared local inbox; only explicit UI admission starts or steers a turn. */
export class DesktopEmail {
  constructor({ home, inbox = createEmailInbox(), imap = createImapConnector({ inbox }), gmail = createGmailConnector({ inbox }) }) {
    this.inbox = inbox; this.imap = imap; this.gmail = gmail;
    this.store = emailStore(join(home, 'desktop-email'), 'Desktop email');
    this.enabled = this.store.read('preferences.json')?.enabled === true;
    this.closed = false; this.operation = null; this.last = null;
  }
  status() {
    return { imap: this.imap.status(), gmail: this.gmail.status(), enabled: this.enabled,
      pending: this.operation?.name ?? null, last: this.last };
  }
  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => this.poll(), 30000); this.timer.unref?.();
    this.poll();
  }
  poll() { if (this.enabled && !this.closed && !this.operation) this.begin('sync', signal => this.sync(false, signal)); }
  begin(name, action) {
    if (this.closed) throw Error('Desktop email is unavailable.');
    if (this.operation) throw Error('An email operation is already running. Cancel it or wait for completion.');
    const controller = new AbortController();
    const operation = { name, controller };
    this.operation = operation; this.last = null;
    operation.done = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return action(controller.signal); })
      .then(value => { this.last = value?.busy ? { ok: false, message: 'Another process is using this mailbox. Try again.' }
        : value?.connected === false ? { ok: false, message: 'No mailbox connected. Open Mailbox connection to configure IMAP or Gmail.' }
          : value?.throttled ? { ok: true, message: 'Waiting for the next sync interval.' }
            : { ok: true, message: name === 'sync' ? 'Sync complete.' : name === 'configure-gmail'
              ? 'Google client imported. Authorize Gmail to connect.' : 'Connection saved.' }; }, () => {
        // Connector or transport exceptions can carry passwords; never project them.
        this.last = { ok: false, message: controller.signal.aborted ? 'Email operation cancelled.'
          : 'Email operation failed. Check the connection settings and try again.' };
      }).finally(() => { if (this.operation === operation) this.operation = null; });
    return this.status();
  }
  sync(force, signal) { return (this.imap.status().connected ? this.imap : this.gmail).sync({ force, signal }); }
  async cancel() { this.operation?.controller.abort(); await this.operation?.done; return this.status(); }
  async dispose() { this.closed = true; clearInterval(this.timer); this.timer = null; await this.cancel(); }
  async request(payload, ctx, signal) {
    signal?.throwIfAborted();
    if (this.closed) throw Error('Desktop email is unavailable.');
    if (!payload || typeof payload !== 'object') throw Error('Invalid email request.');
    switch (payload.action) {
      case 'status': return this.status();
      case 'sync': return this.begin('sync', stop => this.sync(true, stop));
      case 'cancel': return this.cancel();
      case 'background':
        if (typeof payload.enabled !== 'boolean') throw Error('Choose whether background sync is enabled.');
        this.store.write('preferences.json', { enabled: payload.enabled }); this.enabled = payload.enabled;
        if (this.enabled) this.poll(); else if (this.operation?.name === 'sync') await this.cancel();
        return this.status();
      case 'connect-imap': return this.begin('connect-imap', stop => this.imap.connect(payload.config, { signal: stop }));
      case 'configure-gmail':
        if (this.operation) throw Error('Wait for the current email operation.');
        if (typeof payload.path !== 'string' || !isAbsolute(payload.path) || payload.path.length > 4096) throw Error('Choose an absolute path to the Google Desktop client JSON.');
        return this.begin('configure-gmail', () => this.gmail.configure(payload.path));
      case 'connect-gmail': return this.begin('connect-gmail', stop => this.gmail.connect({ signal: stop }));
      case 'list': {
        const offset = payload.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid inbox page.');
        const result = this.inbox.list();
        return { ...this.status(), emails: result.emails.slice(offset, offset + 50).map(summary),
          rejected: result.rejected, total: result.emails.length, offset };
      }
      case 'read': case 'inject': break;
      default: throw Error('Unknown email action.');
    }
    if (typeof payload.key !== 'string' || payload.key.length > 2048) throw Error('Choose a message.');
    const mail = this.inbox.list().emails.find(mail => emailKey(mail) === payload.key);
    if (!mail) throw Error('This message is no longer available. Refresh the inbox.');
    if (payload.action === 'read') return { ...summary(mail), body: emailText(mail.body), receivedAt: mail.receivedAt, connector: mail.connector };
    if (payload.revision !== revision(mail)) throw Error('This message changed. Refresh its preview before adding it.');
    const agent = typeof payload.sessionId === 'string' && ctx.agents.get(payload.sessionId);
    if (!agent || ctx.agentPresets.composedPreset(agent.ctx) !== 'dscode') throw Error('Choose an open DSCODE session.');
    if (typeof payload.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId)) throw Error('A stable email request ID is required.');
    const id = 'dscode-email:' + hash(JSON.stringify([agent.id, payload.requestId]));
    const events = agent.session.snapshotEvents();
    const previous = events.flatMap(event => event.type === 'user/message' ? [event.data]
      : event.type === 'agent/inbox/spliced' ? event.data.inserted ?? [] : []).find(message => message.id === id);
    if (previous) {
      if (previous.source.emailKey !== payload.key || previous.source.emailRevision !== payload.revision) throw Error('This request ID belongs to a different email.');
      await ctx.sessions.flush(agent.session);
      return { admitted: true, duplicate: true, message: 'This email request was already added. Check the session history or queue.' };
    }
    signal?.throwIfAborted();
    const message = { ...createUserMessage({ source: { kind: 'dscode-email', requestId: payload.requestId,
      emailKey: payload.key, emailRevision: payload.revision }, content: [{ type: 'text', text: emailPrompt(mail) }] }), id };
    agent.steer(message);
    await ctx.sessions.flush(agent.session);
    return { admitted: true, duplicate: false, message: 'Email added as external context to this session.' };
  }
}
