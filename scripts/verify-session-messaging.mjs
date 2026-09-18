import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
const home = mkdtempSync(join(tmpdir(), 'dscode-messaging-'));
try {
  provision(home); const patch = join(home, 'probe.patch.yml');
  writeFileSync(patch, `- id: dscode-session-cards\n  config:\n    enabled: false\n- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- id: dscode-memory\n  config:\n    generate: false\n- insert:\n    - id: session-messaging-probe\n      name: ${JSON.stringify(join(root, 'scripts/session-messaging-probe.mjs'))}\n`);
  const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], {
    cwd: root, env: { ...environment(home), DSCODE_MEMORY_HOME: join(home, 'memories'), DSCODE_MESSAGING_PATCH: patch }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
  if (code !== 0 || !output.includes('SESSION_MESSAGING_PROBE_PASSED')) throw Error(output || `Probe exited ${code}`);
  console.log(output.split('\n').find(s => s.includes('SESSION_MESSAGING_PROBE_PASSED')));
} finally { rmSync(socketDirectory(home), { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
