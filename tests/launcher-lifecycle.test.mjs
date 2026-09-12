import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { activeRuns, acquireLock } from '../packages/launcher/locks.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'dscode-launch-'));
  const release = { slug: 'dscode', version: '0.2.0', runtime: '0.1.5-rc.1', bundle: '@fixture/bundle' };
  const put = (path, value) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const profile = join(home, 'profiles/dscode');
  put(join(home, '.hub/installations/dscode/current.json'), {});
  put(join(profile, 'package.json'), {});
  put(join(profile, 'node_modules/@fixture/bundle/package.json'), { name: release.bundle, version: release.version });
  put(join(profile, 'node_modules/@deepseek-ai/dsh/package.json'), { version: release.runtime });
  put(join(profile, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), `
    console.log(JSON.stringify({ready:true,pid:process.pid,args:process.argv.slice(2)}));
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{},1000);
  `);
  const launcher = join(home, 'launcher');
  mkdirSync(launcher);
  for (const name of ['manager.mjs', 'locks.mjs']) cpSync(new URL(`../packages/launcher/${name}`, import.meta.url), join(launcher, name));
  put(join(launcher, 'node_modules/@dsh-plugin-hub/cli/package.json'), { main: 'dist/index.js' });
  put(join(launcher, 'node_modules/@dsh-plugin-hub/cli/dist/index.js'), '');
  put(join(launcher, 'node_modules/@dsh-plugin-hub/cli/dist/bin.js'), `
    console.log(JSON.stringify({ready:true,pid:process.pid,kind:'hub'}));
    process.on('SIGTERM',()=>process.exit(0));
    setInterval(()=>{},1000);
  `);
  symlinkSync(new URL('../node_modules/@deepseek-ai', import.meta.url), join(launcher, 'node_modules/@deepseek-ai'), 'dir');
  const processes = [], runtimePids = new Set();
  const start = args => {
    const manager = join(launcher, 'manager.mjs');
    const program = `import {run} from ${JSON.stringify(manager)}; await run(${JSON.stringify(args)},${JSON.stringify(release)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...process.env, DSCODE_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    const ready = Promise.withResolvers();
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal, output, errors }));
    });
    child.stdout.on('data', chunk => {
      output += chunk;
      const line = output.split('\n').find(line => line.startsWith('{"ready":'));
      if (line) { const value = JSON.parse(line); runtimePids.add(value.pid); ready.resolve(value); }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    const record = { child, done, ready: Promise.race([ready.promise, done.then(exit => { throw Error(exit.errors || 'Runtime exited before ready'); })]) };
    record.ready.catch(() => {});
    processes.push(record);
    return record;
  };
  t.after(async () => {
    for (const pid of runtimePids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
    for (const { child } of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.allSettled(processes.map(p => p.done));
    rmSync(home, { recursive: true, force: true });
  });
  return { home, start, runtimePids };
}

test('real launcher admits two sessions and blocks profile mutations until both exit', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const one = f.start(['--resume', 'session-one']), two = f.start(['--resume', 'session-two']);
  const hosts = await Promise.all([one.ready, two.ready]);
  assert.notEqual(hosts[0].pid, hosts[1].pid);
  assert(hosts[0].args.includes('session-one'));
  assert(hosts[1].args.includes('session-two'));
  for (const command of ['install', 'update', 'rollback']) {
    const result = await f.start([command]).done;
    assert.equal(result.code, 1);
    assert.match(result.errors, /sessions are running/);
  }
  one.child.kill('SIGTERM'); await one.done;
  assert.equal((await activeRuns(f.home)).length, 1);
  two.child.kill('SIGTERM'); await two.done;
  assert.equal((await activeRuns(f.home)).length, 0);
  const release = await acquireLock(f.home); release();
});

test('runtime inherits version protection after launcher SIGKILL; dead leases are reclaimed', { timeout: 15000 }, async t => {
  const f = fixture(t), first = f.start([]), host = await first.ready;
  first.child.kill('SIGKILL'); await first.done;
  assert.equal((await activeRuns(f.home)).length, 1);
  assert.match((await f.start(['update']).done).errors, /sessions are running/);
  process.kill(host.pid, 'SIGTERM');
  for (let n = 0; (await activeRuns(f.home)).length; n++) {
    assert(n < 100, 'Orphan runtime did not release its lease');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  f.runtimePids.delete(host.pid);
  const next = f.start([]); await next.ready;
  next.child.kill('SIGTERM'); assert.equal((await next.done).code, 0);
});

test('in-flight Hub mutation retains its gate after launcher SIGKILL', { timeout: 15000 }, async t => {
  const f = fixture(t), update = f.start(['update']), hub = await update.ready;
  assert.equal(hub.kind, 'hub');
  update.child.kill('SIGKILL'); await update.done;
  const launch = await f.start([]).done;
  assert.equal(launch.code, 1);
  assert.match(launch.errors, /starting or changing versions/);
  process.kill(hub.pid, 'SIGTERM');
  const release = await acquireLock(f.home); release();
  f.runtimePids.delete(hub.pid);
});
