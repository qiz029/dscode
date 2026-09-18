import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';
const home = mkdtempSync(join(tmpdir(), 'dscode-memory-runtime-'));
try {
  provision(home);
  const patch = join(home, 'memory-probe.patch.yml');
  writeFileSync(patch, `- id: dscode-session-cards\n  config:\n    enabled: false\n- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- insert:\n    - id: memory-probe\n      name: ${JSON.stringify(join(root, 'scripts/memory-probe.mjs'))}\n`);
  const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], {
    cwd: root, env: { ...environment(home), DSCODE_MEMORY_HOME: join(home, 'memories') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
  if (code !== 0 || !output.includes('MEMORY_PROBE_PASSED')) throw Error(output || `Memory probe exited ${code}`);
  console.log(output.split('\n').find(line => line.includes('MEMORY_PROBE_PASSED')));
} finally { rmSync(home, { recursive: true, force: true }); }
