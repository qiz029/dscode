export interface Email {
  format: 'dscode.email.v1';
  connector: string;
  account: string;
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  updatedAt: string;
}

/** Connector calls this only after authenticating and matching its mail rules. */
export interface EmailReceiver {
  receive(value: unknown): Email;
}
export interface EmailInbox extends EmailReceiver {
  directory: string;
  list(): { emails: Email[]; rejected: number };
}
export function createEmailInbox(options?: { directory?: string }): EmailInbox;
export function normalizeEmail(value: unknown): Email;
export function emailKey(mail: Email): string;
export function emailText(value: unknown): string;
export function emailPrompt(mail: Email): string;
