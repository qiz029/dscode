// Probe-only loopback IMAP server for the packed Desktop connector check.
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export async function desktopImapFixture(home) {
  const control = join(home, 'imap-fixture.json'), trace = join(home, 'imap-trace.jsonl');
  writeFileSync(control, JSON.stringify({ uidNext: 2, holdSearch: false }));
  writeFileSync(trace, '');
  const source = Buffer.from('From: Fixture <sender@example.test>\r\nTo: reader@example.test\r\nSubject: [ToAgent] Native Desktop sync\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nLocal TLS mailbox context. Do not send a reply.');
  const sockets = new Set(), servers = [];
  const record = value => appendFileSync(trace, JSON.stringify(value) + '\n');
  const certificate = name => {
    const key = join(home, name + '-key.pem'), cert = join(home, name + '-cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    return { certPath: cert, key: readFileSync(key), cert: readFileSync(cert) };
  };
  const listen = async (credentials, trusted) => {
    const server = createServer(credentials, socket => {
      sockets.add(socket); socket.on('close', () => { sockets.delete(socket); record({ closed: true, trusted }); });
      socket.on('error', () => {});
      socket.write('* OK [CAPABILITY IMAP4rev1] Isolated fixture\r\n');
      let buffer = '';
      socket.on('data', data => {
        buffer += data.toString();
        while (buffer.includes('\r\n')) {
          const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const match = line.match(/^(\S+) (.*)$/); if (!match) continue;
          const [, tag, command] = match;
          const verb = command.split(' ').slice(0, command.startsWith('UID ') ? 2 : 1).join(' ');
          record({ verb, trusted }); // Never retain LOGIN arguments.
          const state = JSON.parse(readFileSync(control, 'utf8'));
          const ok = () => socket.write(tag + ' OK done\r\n');
          if (verb === 'CAPABILITY') { socket.write('* CAPABILITY IMAP4rev1\r\n'); ok(); }
          else if (verb === 'LOGIN') ok();
          else if (verb === 'LIST' || verb === 'LSUB') { socket.write('* ' + verb + ' (\\HasNoChildren) "/" "INBOX"\r\n'); ok(); }
          else if (verb === 'EXAMINE') socket.write('* FLAGS (\\Seen \\Deleted \\Draft)\r\n* ' + (state.uidNext - 1) + ' EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\n* OK [UIDNEXT ' + state.uidNext + '] next\r\n' + tag + ' OK [READ-ONLY] open\r\n');
          else if (verb === 'UID SEARCH') { if (!state.holdSearch) { socket.write('* SEARCH 2\r\n'); ok(); } }
          else if (verb === 'UID FETCH') {
            if (command.includes('BODY.PEEK')) {
              record({ verb: 'BODY.PEEK', trusted }); socket.write('* 2 FETCH (UID 2 BODY[] {' + source.length + '}\r\n'); socket.write(source); socket.write(')\r\n'); ok();
            } else {
              const date = new Date(Date.now() + 1000).toUTCString().replace(/^\w+, (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1-$2-$3 $4 +0000');
              socket.write('* 2 FETCH (UID 2 RFC822.SIZE ' + source.length + ' INTERNALDATE "' + date + '" FLAGS () ENVELOPE (NIL "[ToAgent] Native Desktop sync" (("Fixture" NIL "sender" "example.test")) NIL NIL ((NIL NIL "reader" "example.test")) NIL NIL NIL NIL))\r\n'); ok();
            }
          } else if (verb === 'LOGOUT') { socket.write('* BYE done\r\n'); ok(); socket.end(); }
          else socket.write(tag + ' BAD unsupported fixture command\r\n');
        }
      });
    });
    server.on('tlsClientError', () => record({ tlsRejected: true, trusted }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    servers.push(server); return server.address().port;
  };
  try {
    const trusted = certificate('trusted'), untrusted = certificate('untrusted');
    const port = await listen(trusted, true), untrustedPort = await listen(untrusted, false);
    return { ca: trusted.certPath, port, untrustedPort,
      async close() {
        for (const socket of sockets) socket.destroy();
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
        const rows = readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        assert(!rows.some(row => /STORE|APPEND|EXPUNGE|SELECT/.test(row.verb ?? '')), 'Mailbox mutation attempted');
      } };
  } catch (error) { for (const socket of sockets) socket.destroy(); for (const server of servers) server.close(); throw error; }
}
