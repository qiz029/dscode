// One guarded script attempt. The scheduler owns this guardian over IPC; losing
// that channel terminates the script process group, including ordinary children.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, lstatSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { JobStore } from './jobs.mjs';
import { acquireTriggerLease } from './lease.mjs';
import { sandboxCommand, signalGroup } from './source-sandbox.mjs';
import { openSourceIngress } from './source-ingress.mjs';

export async function runSourceAttempt({ home, project, definition, sourceId }) {
  const store = new JobStore(home);
  const lease = await acquireTriggerLease(home, `source-${sourceId}`);
  if (!lease) { store.close(); throw new Error('source lease is held by another process; inspect the previous source before restarting'); }
  let child, ingress, scratch, timer, flush, stopped = false, timedOut = false, log = '', failure;
  const stop = () => { stopped = true; if (child) signalGroup(child, 'SIGTERM'); };
  process.once('disconnect', stop);
  process.on('message', stop);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(signal, stop);
  const persistLog = () => store.run('UPDATE sources SET log=? WHERE id=?', log, sourceId);
  const collect = chunk => { log = (log + String(chunk)).slice(-32768); };
  try {
    const data = join(home, 'triggers', 'source-data', sourceId);
    mkdirSync(data, { recursive: true, mode: 0o700 });
    if (lstatSync(data).isSymbolicLink() || realpathSync(data) !== join(realpathSync(home), 'triggers', 'source-data', sourceId)) throw new Error('source state directory must not be redirected through symlinks');
    scratch = mkdtempSync('/tmp/dscode-script-');
    ingress = await openSourceIngress({ home, project, definition, store });
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    // A tiny private CLI avoids launcher provisioning and writes to global state.
    const client = fileURLToPath(new URL('./source-emit.mjs', import.meta.url));
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    writeFileSync(join(bin, 'dscode'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(client)} "$@"\n`, { mode: 0o700 });
    const launch = sandboxCommand(definition.source.command, { workspace: definition.workspace, home, writable: [data, scratch], permission: definition.source.permission });
    if (stopped || (process.send && !process.connected)) return;
    const env = { ...process.env };
    delete env.NODE_CHANNEL_FD; delete env.NODE_CHANNEL_SERIALIZATION_MODE;
    child = spawn(launch.command, launch.args, {
      cwd: definition.workspace, detached: true,
      env: { ...env, PATH: bin + delimiter + (process.env.PATH ?? ''), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
        DSCODE_SOURCE_SOCKET: ingress.path, DSCODE_SOURCE_TOKEN: ingress.token, DSCODE_SOURCE_STATE: data, DSCODE_TRIGGER_ID: definition.id },
      stdio: ['ignore', 'pipe', 'pipe', lease.fd],
    });
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    store.run("UPDATE sources SET status='running',pid=?,error=NULL WHERE id=?", child.pid ?? null, sourceId);
    flush = setInterval(persistLog, 1000);
    if (definition.source.mode === 'poll') timer = setTimeout(() => { timedOut = true; stop(); }, definition.source.timeoutSeconds * 1000);
    // A bounded grace period also handles children ignoring SIGTERM.
    const reap = setInterval(() => { if (stopped) signalGroup(child, 'SIGKILL'); }, 1000);
    try {
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? signal)); });
      if (timedOut) throw new Error('script poll timed out');
      if (!stopped && (code !== 0 || definition.source.mode === 'daemon')) throw new Error(`script exited (${code})`);
    } finally { clearInterval(reap); }
  } catch (error) { failure = error.message; collect(`\n${failure}\n`); }
  finally {
    clearTimeout(timer); clearInterval(flush);
    if (child) { signalGroup(child, 'SIGTERM'); await sleep(100); signalGroup(child, 'SIGKILL'); }
    await ingress?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    const saved = store.one('SELECT * FROM sources WHERE id=?', sourceId);
    const failures = failure ? (saved?.failures ?? 0) + 1 : 0;
    const delay = failure ? Math.min(300000, 1000 * 2 ** Math.min(failures, 8)) : (definition.source.everySeconds ?? 1) * 1000;
    persistLog();
    store.run('UPDATE sources SET status=?,pid=NULL,error=?,failures=?,nextAt=? WHERE id=?', failure ? 'backoff' : 'stopped', failure ?? null, failures, Date.now() + delay, sourceId);
    store.close(); lease.release();
    process.off('disconnect', stop); process.off('message', stop);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.off(signal, stop);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await runSourceAttempt(JSON.parse(process.argv[2])); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (process.connected) process.disconnect();
}
