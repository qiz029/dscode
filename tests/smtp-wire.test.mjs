import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:tls';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { createEmailSender } from '../plugins/email/smtp.mjs';
import { emailStore } from '../plugins/email/store.mjs';

test('real TLS SMTP authenticates and submits one prefixed plain-text message', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-smtp-wire-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const certPath = join(directory, 'cert.pem'), keyPath = join(directory, 'key.pem');
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']).status, 0);
  const cert = readFileSync(certPath), sockets = new Set(), commands = []; let raw = '';
  const server = createServer({ cert, key: readFileSync(keyPath) }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write('220 localhost test\r\n'); let buffer = '', dataMode = false;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (dataMode) {
          if (line === '.') { dataMode = false; socket.write('250 queued\r\n'); }
          else raw += line.replace(/^\.\./, '.') + '\r\n';
          continue;
        }
        const verb = line.split(' ')[0]; commands.push(verb);
        if (verb === 'EHLO') socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') socket.write('235 authenticated\r\n');
        else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 ok\r\n');
        else if (verb === 'DATA') { dataMode = true; socket.write('354 continue\r\n'); }
        else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 unsupported\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  emailStore(join(directory, 'imap')).write('connection.json', { config: { host: 'imap.gmail.com', account: 'sender@example.test', password: 'synthetic-password' } });
  const sender = createEmailSender({ directory, transportFactory: options => nodemailer.createTransport({ ...options, host: '127.0.0.1', port: server.address().port, tls: { ...options.tls, ca: cert, servername: 'localhost' } }) });
  const args = { to: 'receiver@example.test', subject: '交接', body: '请检查构建。\n.line', idempotency_key: 'wire-1' };
  assert.equal((await sender.send(args)).status, 'accepted');
  await sender.send(args); assert.equal(commands.filter(c => c === 'DATA').length, 1); assert.ok(commands.includes('AUTH'));
  const parsed = await simpleParser(raw);
  assert.equal(parsed.subject, '[ToAgent] 交接'); assert.equal(parsed.text.trim(), args.body);
  assert.equal(parsed.from.value[0].address, 'sender@example.test'); assert.equal(parsed.to.value[0].address, args.to);
});
