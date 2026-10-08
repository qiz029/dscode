// Probe-only Nodemailer peer; all recipients and credentials are synthetic.
import { createServer } from 'node:tls';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export async function desktopSmtpFixture(home) {
  const control = join(home, 'smtp-fixture.json'), trace = join(home, 'smtp-trace.jsonl');
  const cert = join(home, 'smtp-cert.pem'), key = join(home, 'smtp-key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  writeFileSync(control, JSON.stringify({ mode: 'accept' })); writeFileSync(trace, '');
  const sockets = new Set(), timers = new Set();
  const mode = () => JSON.parse(readFileSync(control, 'utf8')).mode;
  const record = value => appendFileSync(trace, JSON.stringify(value) + '\n');
  const server = createServer({ cert: readFileSync(cert), key: readFileSync(key) }, socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.write('220 localhost Desktop fixture\r\n'); let buffer = '', raw = '', dataMode = false;
    const accepted = () => {
      if (mode() === 'disconnect') { socket.destroy(); return; }
      if (mode() === 'hold') {
        const timer = setInterval(() => { if (mode() !== 'hold' || socket.destroyed) { clearInterval(timer); timers.delete(timer); if (!socket.destroyed) accepted(); } }, 10);
        timers.add(timer); return;
      }
      socket.write('250 queued locally\r\n');
    };
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (dataMode) {
          if (line === '.') { dataMode = false; record({ message: raw }); raw = ''; accepted(); }
          else raw += line.replace(/^\.\./, '.') + '\r\n';
          continue;
        }
        const verb = line.split(' ')[0]; record({ verb });
        if (verb === 'EHLO') socket.write('250-localhost\r\n250 AUTH PLAIN\r\n');
        else if (verb === 'AUTH') {
          const auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString().split('\0');
          socket.write(auth.at(-2) === 'sender@example.test' && auth.at(-1) === 'fixture-smtp-password' ? '235 authenticated\r\n' : '535 fixture credential mismatch\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 ok\r\n');
        else if (verb === 'DATA') { dataMode = true; socket.write('354 continue\r\n'); }
        else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 unsupported\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { ca: cert, port: server.address().port, async close() {
    for (const timer of timers) clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}
