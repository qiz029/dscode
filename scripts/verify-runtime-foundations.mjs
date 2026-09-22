import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
const home = mkdtempSync(join(tmpdir(), 'dscode-foundations-')), children = [];
try {
  provision(home);
  const patch = join(home, 'probe.patch.yml');
  writeFileSync(patch, `- id: dscode-session-cards\n  config:\n    enabled: false\n- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- id: dscode-memory\n  config:\n    generate: false\n- insert:\n    - id: runtime-foundations-probe\n      name: ${JSON.stringify(join(root, 'scripts/runtime-foundations-probe.mjs'))}\n`);
  const start = mode => {
    const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], {
      cwd: root, env: { ...environment(home), DSCODE_FOUNDATIONS_MODE: mode, DSCODE_MEMORY_HOME: join(home, 'memories') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const record = { child, output: '', done: false };
    child.stdout.on('data', b => { record.output += b; }); child.stderr.on('data', b => { record.output += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    record.exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => { record.done = true; clearTimeout(timer); resolve({ code, signal }); }); child.once('error', reject); });
    children.push(record); return record;
  };
  const completed = async record => { const exit = await record.exited; assert.equal(exit.code, 0, record.output); return record.output; };
  const holder = start('holder');
  for (let n = 0; !holder.output.includes('FOUNDATIONS_OWNER_READY'); n++) {
    assert(!holder.done && n < 1000, holder.output || 'Owner never became ready');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  console.log((await completed(start('contender'))).split('\n').find(s => s.includes('FOUNDATIONS_CONTENDER')));
  holder.child.kill('SIGKILL'); assert.equal((await holder.exited).signal, 'SIGKILL');
  assert((await completed(start('successor'))).includes('FOUNDATIONS_RELEASED'));
  assert((await completed(start('successor'))).includes('FOUNDATIONS_RELEASED'));
  console.log('FOUNDATIONS_OWNERSHIP: kernel lock excludes second Host, read stays available, SIGKILL and clean disposal release ownership');
  console.log((await completed(start('preset'))).split('\n').find(s => s.includes('FOUNDATIONS_PRESET_LOCK')));
  console.log((await completed(start('boundaries'))).split('\n').find(s => s.includes('FOUNDATIONS_BOUNDARIES')));
} finally {
  for (const record of children) if (!record.done) record.child.kill('SIGKILL');
  await Promise.allSettled(children.map(r => r.exited));
  rmSync(socketDirectory(home), { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}
