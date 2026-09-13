import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ImapFlow } from 'imapflow';
import { createImapConnector } from '../plugins/email/imap.mjs';
import { createEmailInbox } from '../plugins/email/inbox.mjs';

test('real TLS IMAP client authenticates, EXAMINEs and reads BODY.PEEK without STORE', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-imap-wire-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const certPath = join(home, 'cert.pem'), keyPath = join(home, 'key.pem');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, 'Could not create local TLS fixture');
  const cert = readFileSync(certPath), key = readFileSync(keyPath), sockets = new Set(), commands = [];
  const source = Buffer.from('From: Other <other@example.test>\r\nTo: fixture@example.test\r\nSubject: [ToAgent] wire test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n来自 IMAP 的任务');
  let uidNext = 2;
  const server = createServer({ cert, key }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1] Local test\r\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const match = line.match(/^(\S+) (.*)$/); if (!match) continue;
        const [, tag, command] = match;
        const verb = command.split(' ').slice(0, command.startsWith('UID ') ? 2 : 1).join(' ');
        commands.push(verb);
        const ok = () => socket.write(tag + ' OK done\r\n');
        if (verb === 'CAPABILITY') { socket.write('* CAPABILITY IMAP4rev1\r\n'); ok(); }
        else if (verb === 'LOGIN') ok();
        else if (verb === 'LIST' || verb === 'LSUB') { socket.write('* ' + verb + ' (\\HasNoChildren) "/" "INBOX"\r\n'); ok(); }
        else if (verb === 'EXAMINE') socket.write('* FLAGS (\\Seen \\Deleted \\Draft)\r\n* ' + (uidNext - 1) + ' EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT ' + uidNext + '] next\r\n' + tag + ' OK [READ-ONLY] open\r\n');
        else if (verb === 'UID SEARCH') { socket.write('* SEARCH 2\r\n'); ok(); }
        else if (verb === 'UID FETCH') {
          if (command.includes('BODY.PEEK')) {
            commands.push('BODY.PEEK'); socket.write('* 2 FETCH (UID 2 BODY[] {' + source.length + '}\r\n'); socket.write(source); socket.write(')\r\n'); ok();
          } else {
            socket.write('* 2 FETCH (UID 2 RFC822.SIZE ' + source.length + ' INTERNALDATE "12-Sep-2026 10:00:01 +0000" FLAGS () ENVELOPE (NIL "[ToAgent] wire test" (("Other" NIL "other" "example.test")) NIL NIL ((NIL NIL "fixture" "example.test")) NIL NIL NIL NIL))\r\n'); ok();
          }
        } else if (verb === 'LOGOUT') { socket.write('* BYE done\r\n'); ok(); socket.end(); }
        else socket.write(tag + ' BAD unsupported test command\r\n');
      }
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const inbox = createEmailInbox({ directory: join(home, 'inbox') });
  const connector = createImapConnector({ inbox, now: () => Date.parse('2026-09-12T10:00:00Z'),
    clientFactory: options => new ImapFlow({ ...options, tls: { ...options.tls, ca: cert }, servername: 'localhost' }) });
  await connector.connect({ account: 'fixture@example.test', password: 'test-only', host: '127.0.0.1', port: server.address().port });
  assert.equal(inbox.list().emails.length, 0);
  uidNext = 3;
  await connector.sync({ force: true });
  assert.equal(inbox.list().emails.length, 1);
  assert.match(inbox.list().emails[0].body, /来自 IMAP/);
  assert(commands.includes('BODY.PEEK')); assert(commands.includes('EXAMINE'));
  assert(!commands.includes('SELECT')); assert(!commands.some(verb => /STORE|APPEND|EXPUNGE/.test(verb)));
});
