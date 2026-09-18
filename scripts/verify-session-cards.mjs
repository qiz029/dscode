import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
const home = mkdtempSync(join(tmpdir(), 'dscode-cards-runtime-'));
try {
  provision(home);
  // Project identity needs a repository; keep it in this probe's own fixture,
  // independent of whether the source or surrounding checks run inside Git.
  const project = spawnSync('git', ['init', '--quiet', home], { encoding: 'utf8' });
  if (project.status !== 0) throw Error(project.stderr);
  const patch = join(home, 'probe.patch.yml');
  writeFileSync(patch, `- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- id: dscode-memory\n  config:\n    generate: false\n- id: dscode-session-cards\n  config:\n    minMessages: 1\n    debounceMs: 0\n    cooldownMs: 0\n- insert:\n    - id: session-cards-probe\n      name: ${JSON.stringify(join(root, 'scripts/session-cards-probe.mjs'))}\n`);
  const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], { cwd: home,
    env: { ...environment(home), DSCODE_MEMORY_HOME: join(home, 'memories') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
  if (code !== 0 || !output.includes('SESSION_CARDS_PROBE_PASSED')) throw Error(output || `Card probe exited ${code}`);
  console.log(output.split('\n').find(line => line.includes('SESSION_CARDS_PROBE_PASSED')));
} finally {
  try { rmSync(socketDirectory(home), { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  rmSync(home, { recursive: true, force: true });
}
