import { emailAddress as address } from './contacts.mjs';
import nodemailer from 'nodemailer';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createEmailInbox } from './inbox.mjs';
import { emailStore } from './store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

export function outgoingEmail({ to, subject, body, idempotency_key }) {
  if (!address(to)) throw Error('Specify one plain recipient email address.');
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 500 || /[\x00-\x1f\x7f]/.test(subject)) throw Error('Invalid email subject.');
  if (typeof body !== 'string' || !body.trim() || body.includes('\0') || Buffer.byteLength(body) > 262144) throw Error('Email requires plain text of at most 256 KiB.');
  if (typeof idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(idempotency_key)) throw Error('Use a stable idempotency_key of 1..128 letters, digits, underscores or hyphens.');
  subject = subject.trim();
  if (!subject.startsWith('[ToAgent]')) subject = '[ToAgent] ' + subject;
  return { to, subject, body, idempotency_key };
}

export function createEmailSender({ directory = createEmailInbox().directory, transportFactory = options => nodemailer.createTransport(options) } = {}) {
  const credentials = emailStore(join(directory, 'imap'));
  const outbox = emailStore(join(directory, 'outbox'));
  const filename = key => hash(key) + '.json';
  return {
    status(key) {
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw Error('Invalid idempotency_key.');
      const entry = outbox.read(filename(key));
      return entry ? entry.receipt : { status: 'not_found' };
    },
    async send(value, { signal } = {}) {
      const mail = outgoingEmail(value);
      return outbox.locked(async () => {
        const file = filename(mail.idempotency_key), digest = hash(JSON.stringify(mail));
        const existing = outbox.read(file);
        if (existing) {
          if (existing.digest !== digest) throw Error('This idempotency_key belongs to a different email.');
          return existing.receipt;
        }
        const config = credentials.read('connection.json')?.config;
        if (!config || config.host !== 'imap.gmail.com' || !address(config.account) || !config.password) throw Error('Configure Gmail with an application password in /email first.');
        if (signal?.aborted) return { status: 'cancelled' };
        const messageId = `<${randomUUID()}@${config.account.split('@')[1]}>`;
        const receipt = { status: 'uncertain', messageId, from: config.account, to: mail.to, subject: mail.subject, attemptedAt: new Date().toISOString() };
        // Persist before SMTP: a crash or lost final response must never cause a blind retry.
        outbox.write(file, { digest, receipt });
        let transport;
        try {
          transport = transportFactory({ host: 'smtp.gmail.com', port: 465, secure: true,
            auth: { user: config.account, pass: config.password },
            tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
            logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
            connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
          // Once SMTP starts, cancellation cannot recall a submitted message.
          // Finish recording its outcome even if the agent turn is cancelled.
          const info = await transport.sendMail({ from: config.account, to: mail.to,
            envelope: { from: config.account, to: [mail.to] }, subject: mail.subject, text: mail.body,
            messageId, disableFileAccess: true, disableUrlAccess: true });
          receipt.status = info.accepted?.includes(mail.to) ? 'accepted' : 'rejected';
          outbox.write(file, { digest, receipt });
        } catch {
          // SMTP errors may contain secrets or message content. Only expose the durable receipt.
        } finally {
          transport?.close();
        }
        return receipt;
      });
    },
  };
}
