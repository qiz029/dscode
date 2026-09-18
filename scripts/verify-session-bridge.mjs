import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
const home = mkdtempSync(join(tmpdir(), 'dscode-bridge-runtime-'));
try {
  provision(home);
  const patch = join(home, 'probe.patch.yml');
  writeFileSync(patch, `- id: dscode-session-cards\n  config:\n    enabled: false\n- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- id: dscode-memory\n  config:\n    generate: false\n- insert:\n    - id: session-bridge-probe\n      name: ${JSON.stringify(join(root, 'scripts/session-bridge-probe.mjs'))}\n`);
  const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], {
    cwd: root, env: { ...environment(home), DSCODE_MEMORY_HOME: join(home, 'memories') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
  if (code !== 0 || !output.includes('SESSION_BRIDGE_PROBE_PASSED')) throw Error(output || `Session probe exited ${code}`);
  if (readdirSync(socketDirectory(home)).some(name => name.endsWith('.sock'))) throw Error('Host exited without removing its socket');
  console.log(output.split('\n').find(line => line.includes('SESSION_BRIDGE_PROBE_PASSED')));
} finally {
  try { rmSync(socketDirectory(home), { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  rmSync(home, { recursive: true, force: true });
}
