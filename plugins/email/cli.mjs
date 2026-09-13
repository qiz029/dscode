import { createEmailContacts } from './contacts.mjs';
import { createGmailConnector } from './gmail.mjs';
import { createImapConnector } from './imap.mjs';

export async function runEmailClient(args, { connector = createGmailConnector(), imap = createImapConnector(), contacts = createEmailContacts(), output = console.log } = {}) {
  const [command = 'status', ...rest] = args;
  if (command === 'alias') {
    const [action = 'list', name, address] = rest;
    let result;
    if (action === 'list' && rest.length <= 1) result = contacts.list();
    else if (action === 'set' && rest.length === 3) result = await contacts.set(name, address);
    else if (action === 'remove' && rest.length === 2) result = await contacts.remove(name);
    else throw Error('Usage: dscode email alias list | set NAME ADDRESS | remove NAME');
    if (result.busy === true) throw Error('Contacts are busy in another session. Retry shortly.');
    output(JSON.stringify(result, null, 2)); return;
  }
  if (!['configure', 'connect', 'sync', 'status', 'imap-status', 'imap-sync'].includes(command) || (command === 'configure' ? rest.length !== 1 : rest.length !== 0)) throw Error('Usage: dscode email configure CLIENT_JSON | connect | sync | status | imap-status | imap-sync (IMAP setup: /email then i)');
  if (command.startsWith('imap-')) connector = imap;
  if (command === 'imap-status') { output(JSON.stringify(connector.status(), null, 2)); return; }
  if (command === 'status') { output(JSON.stringify(connector.status(), null, 2)); return; }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    if (command === 'connect') output('Complete Gmail authorization in your browser. Ctrl+C cancels.');
    const result = command === 'configure' ? await connector.configure(rest[0])
      : command === 'connect' ? await connector.connect({ signal: controller.signal })
      : await connector.sync({ signal: controller.signal, force: true });
    if (result.busy) throw Error('Gmail is busy in another session. Retry shortly.');
    output(command === 'configure' ? 'Google Desktop OAuth client saved privately. Open /email and press g to connect.' : JSON.stringify(result, null, 2));
  } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
}
