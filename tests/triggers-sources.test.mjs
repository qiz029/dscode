import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeTrigger } from '../plugins/triggers/config.mjs';
import { JobStore } from '../plugins/triggers/jobs.mjs';
import { SourceSupervisor } from '../plugins/triggers/sources.mjs';
import { acquireTriggerLease } from '../plugins/triggers/lease.mjs';
import { openSourceIngress, emitToSource } from '../plugins/triggers/source-ingress.mjs';
import { sandboxCommand } from '../plugins/triggers/source-sandbox.mjs';
import { runTriggerCli } from '../plugins/triggers/cli.mjs';

function fixture(t, source = { kind: 'script', mode: 'daemon', command: [process.execPath, 'watch.mjs'] }) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-sources-'));
  const home = join(root, 'state'), workspace = join(root, 'project');
  mkdirSync(join(home, 'triggers'), { recursive: true }); mkdirSync(workspace);
  const raw = { id: 'watcher', workspace, source, prompt: '{{event.text}}', goal: { objective: 'handle event' } };
  const save = patch => { Object.assign(raw, patch); writeFileSync(join(home, 'triggers/watcher.json'), JSON.stringify(raw)); };
  save({});
  const definition = normalizeTrigger(raw), store = new JobStore(home);
  const saved = store.registerSource(definition, workspace);
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups) await cleanup(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, home, workspace, raw, definition, store, saved, save, cleanups };
}
async function until(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(30); }
  assert.fail(typeof message === 'function' ? message() : message);
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('script configuration rejects ambiguous commands, unsafe permissions and invalid cadence', t => {
  const f = fixture(t);
  assert.equal(f.definition.source.permission, 'read-only');
  for (const patch of [{ command: 'sh watch.sh' }, { command: [] }, { mode: 'loop' }, { permission: 'danger-full-access' }, { everySeconds: 1 }, { mode: 'poll' }, { mode: 'poll', everySeconds: 0 }]) {
    assert.throws(() => normalizeTrigger({ ...f.raw, source: { ...f.raw.source, ...patch } }));
  }
  assert.equal(normalizeTrigger({ ...f.raw, source: { ...f.raw.source, mode: 'poll', everySeconds: 5 } }).source.timeoutSeconds, 60);
  assert.throws(() => sandboxCommand(['true'], { workspace: f.workspace, platform: 'win32' }), /unavailable/);
});

test('durable ingress retries survive cancellation, reopening and full queues; conflicts fail', t => {
  const f = fixture(t);
  const args = { definition: f.definition, project: f.workspace, payload: { fields: { b: 2, a: 1 }, text: 'event' }, eventId: 'change:1', now: 10, maxPending: 1 };
  const first = f.store.acceptEvent(args);
  const other = new JobStore(f.home);
  try {
    assert.equal(other.acceptEvent({ ...args, now: 20, payload: { text: 'event', fields: { a: 1, b: 2 } } }).id, first.id);
    assert.equal(other.get(first.id).dueAt, 10);
    assert.throws(() => other.acceptEvent({ ...args, eventId: 'change:2' }), /QUEUE_FULL/);
    assert.throws(() => other.acceptEvent({ ...args, payload: { text: 'different' } }), /different payload/);
    other.cancel(first.id);
    assert.equal(other.acceptEvent(args).state, 'cancelled');
    assert.notEqual(other.acceptEvent({ ...args, eventId: 'change:2' }).id, first.id);
    assert.throws(() => other.acceptEvent({ ...args, eventId: 'large', payload: { fields: { huge: 'a'.repeat(140000) } } }), /128 KiB/);
  } finally { other.close(); }
});

test('scoped socket acknowledges committed jobs and refuses wrong identities and disabled sources', async t => {
  const f = fixture(t);
  const ingress = await openSourceIngress({ home: f.home, project: f.workspace, definition: f.definition, store: f.store });
  f.cleanups.push(() => ingress.close());
  const env = { DSCODE_SOURCE_SOCKET: ingress.path, DSCODE_SOURCE_TOKEN: ingress.token };
  const args = { env, triggerId: 'watcher', eventId: 'one', payload: { text: 'hello' } };
  const receipt = await emitToSource(args);
  assert.equal(f.store.get(receipt.jobId).state, 'pending');
  assert.equal((await emitToSource(args)).jobId, receipt.jobId);
  await assert.rejects(emitToSource({ ...args, triggerId: 'other' }), /scope mismatch/);
  await assert.rejects(emitToSource({ ...args, env: { ...env, DSCODE_SOURCE_TOKEN: 'bad' } }), /scope mismatch/);
  f.save({ enabled: false });
  await assert.rejects(emitToSource({ ...args, eventId: 'two' }), /stopped/);
});

test('CLI emit queues once and the job uses the original event identity and payload', async t => {
  const f = fixture(t);
  const output = [], specs = [];
  const deps = { home: f.home, project: f.workspace, stdout: { write: s => output.push(s) }, stderr: { write: s => output.push(s) }, spawnRun: async ({ spec }) => { specs.push(spec); return { code: 0, result: { outcome: 'completed', exitCode: 0 } }; } };
  const args = ['emit', 'watcher', '--event-id', 'build:1', '--text', 'build failed'];
  assert.equal(await runTriggerCli(args, deps), 0);
  assert.equal(await runTriggerCli(args, deps), 0);
  assert.equal(f.store.list().length, 1);
  assert.equal(await runTriggerCli(['run-job', f.store.list()[0].id], deps), 0);
  assert.match(specs[0].prompt, /build failed/);
  assert.equal(f.store.list()[0].state, 'completed');
  assert.equal(await runTriggerCli(args, deps), 0);
  assert.equal(f.store.list().length, 1);
});

// These cases execute real filesystem sandboxes and local IPC; no model/network service.
test('daemon emits, persists its cursor, enforces writes, and stop kills its process group', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const forbidden = join(f.root, 'outside.txt');
  writeFileSync(join(f.workspace, 'watch.mjs'), `
    import { spawnSync, spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    for (const path of [${JSON.stringify(forbidden)}, ${JSON.stringify(join(f.home, 'triggers', 'oops'))}, ${JSON.stringify(join(f.workspace, 'oops'))}]) {
      try { writeFileSync(path, 'BAD'); throw new Error('sandbox permitted write: '+path); } catch(e) { if (!['EPERM','EACCES'].includes(e.code)) throw e; }
    }
    const result = spawnSync('dscode', ['trigger','emit','watcher','--event-id','one','--text','changed'], { encoding:'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    writeFileSync(join(process.env.DSCODE_SOURCE_STATE,'cursor'), result.stdout);
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], { stdio:'ignore' });
    writeFileSync(join(process.env.DSCODE_SOURCE_STATE,'child'), String(child.pid));
    process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);
  `);
  const supervisor = new SourceSupervisor({ home: f.home, store: f.store, report: () => {} });
  f.cleanups.push(() => supervisor.close());
  supervisor.tick();
  const data = join(f.home, 'triggers/source-data', f.saved.id);
  await until(() => existsSync(join(data, 'child')), () => f.store.source('watcher', f.workspace).log);
  assert.equal(f.store.list().length, 1);
  assert.equal(JSON.parse(readFileSync(join(data, 'cursor'), 'utf8')).jobId, f.store.list()[0].id);
  assert.equal(existsSync(forbidden), false);
  assert.equal(await acquireTriggerLease(f.home, `source-${f.saved.id}`), undefined, 'script attempt holds singleton lease');
  const pid = f.store.source('watcher', f.workspace).pid, grandchild = Number(readFileSync(join(data, 'child'), 'utf8'));
  f.store.controlSource(f.definition, f.workspace, 'stop'); supervisor.tick();
  await until(() => !supervisor.active.size, 'source did not stop');
  await until(() => !alive(pid) && !alive(grandchild), 'process group survived stop');
  assert.equal(f.store.list()[0].state, 'pending', 'stopping a producer preserves accepted jobs');
});

test('poll checks finish without model work, use backoff on failure and bound output', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t, { kind: 'script', mode: 'poll', command: [process.execPath, '-e', 'console.log("x".repeat(50000)); process.exit(2)'], everySeconds: 3600, timeoutSeconds: 1 });
  const supervisor = new SourceSupervisor({ home: f.home, store: f.store, report: () => {} });
  f.cleanups.push(() => supervisor.close());
  supervisor.tick(); await until(() => !supervisor.active.size, 'poll did not finish');
  const result = f.store.source('watcher', f.workspace);
  assert.equal(result.status, 'backoff'); assert.match(result.error, /exited/); assert.equal(result.failures, 1);
  assert(result.nextAt > Date.now()); assert(result.log.length <= 32768); assert.equal(f.store.list().length, 0);
  supervisor.tick(); assert.equal(supervisor.active.size, 0, 'backoff does not immediately respawn');
});

test('guardian stops the script if its scheduler IPC parent dies', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'watch.mjs'), `import { writeFileSync } from 'node:fs'; import { join } from 'node:path'; writeFileSync(join(process.env.DSCODE_SOURCE_STATE,'pid'),String(process.pid)); setInterval(()=>{},1000);`);
  const module = new URL('../plugins/triggers/sources.mjs', import.meta.url).href;
  const jobs = new URL('../plugins/triggers/jobs.mjs', import.meta.url).href;
  const parentFile = join(f.root, 'parent.mjs');
  writeFileSync(parentFile, `import { SourceSupervisor } from ${JSON.stringify(module)}; import { JobStore } from ${JSON.stringify(jobs)}; const s = new SourceSupervisor({home:${JSON.stringify(f.home)},store:new JobStore(${JSON.stringify(f.home)})}); s.tick(); setInterval(()=>{},1000);`);
  const parent = fork(parentFile, [], { stdio: ['ignore','ignore','ignore','ipc'], execArgv: [] });
  f.cleanups.push(async () => { if (alive(parent.pid)) { parent.kill('SIGKILL'); await sleep(1500); } });
  const pidFile = join(f.home, 'triggers/source-data', f.saved.id, 'pid');
  await until(() => existsSync(pidFile), 'script failed to start');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  parent.kill('SIGKILL');
  await until(() => !alive(pid), 'script survived scheduler death');
});

test('poll timeout is reported, while source edits and restart replace a live process', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t, { kind: 'script', mode: 'poll', command: [process.execPath, '-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], everySeconds: 3600, timeoutSeconds: 1 });
  const supervisor = new SourceSupervisor({ home: f.home, store: f.store, report: () => {} });
  f.cleanups.push(() => supervisor.close());
  supervisor.tick(); await until(() => !supervisor.active.size, 'poll did not time out');
  assert.match(f.store.source('watcher', f.workspace).error, /timed out/);
  f.save({ source: { kind: 'script', mode: 'daemon', command: [process.execPath, '-e', 'console.log("revision-one"); setInterval(()=>{},1000)'] } });
  f.store.controlSource(normalizeTrigger(f.raw), f.workspace, 'restart');
  supervisor.tick();
  await until(() => f.store.source('watcher', f.workspace).status === 'running', 'daemon did not start');
  const first = f.store.source('watcher', f.workspace).pid;
  f.save({ source: { ...f.raw.source, command: [process.execPath, '-e', 'console.log("revision-two"); setInterval(()=>{},1000)'] } });
  supervisor.tick();
  await until(() => !supervisor.active.size, 'edited source did not stop');
  supervisor.tick();
  await until(() => f.store.source('watcher', f.workspace).status === 'running', 'edited source did not restart');
  const second = f.store.source('watcher', f.workspace).pid;
  assert.notEqual(second, first); assert.equal(alive(first), false);
  await until(() => f.store.source('watcher', f.workspace).log.includes('revision-two'), 'new script not observed');
  f.store.controlSource(normalizeTrigger(f.raw), f.workspace, 'restart'); supervisor.tick();
  await until(() => !supervisor.active.size, 'restart did not stop'); supervisor.tick();
  await until(() => f.store.source('watcher', f.workspace).pid && f.store.source('watcher', f.workspace).pid !== second, 'restart did not replace process');
  f.save({ enabled: false }); supervisor.tick();
  await until(() => !supervisor.active.size, 'disable did not stop');
  assert.equal(f.store.source('watcher', f.workspace).desired, 'running');
});

test('workspace-write sources can edit the project but cannot edit harness state inside it', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t, { kind: 'script', mode: 'poll', everySeconds: 3600, command: ['/bin/sh', '-c', 'true'], permission: 'workspace-write' });
  // Bind the workspace to the parent of the state directory to test the exclusion.
  f.save({ workspace: f.root, source: { ...f.raw.source, command: [process.execPath, '-e', `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(f.root, 'allowed'))},'yes'); try { fs.writeFileSync(${JSON.stringify(join(f.home, 'bad'))},'no'); process.exit(9); } catch(e) { if (!['EPERM','EACCES'].includes(e.code)) throw e; }`] } });
  const supervisor = new SourceSupervisor({ home: f.home, store: f.store, report: () => {} });
  f.cleanups.push(() => supervisor.close());
  supervisor.tick(); await until(() => !supervisor.active.size, 'poll did not finish');
  assert.equal(readFileSync(join(f.root, 'allowed'), 'utf8'), 'yes');
  assert.equal(existsSync(join(f.home, 'bad')), false);
  assert.equal(f.store.source('watcher', f.workspace).error, null);
});
