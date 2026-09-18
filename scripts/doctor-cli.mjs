import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshEntry, environment, provision, root, runtimeHome } from './harness.mjs';
import { spawn } from 'node:child_process';

export function doctorOverlay(runner, mode = 'analyze') {
  return `${['tui-startup', 'tui-runner', 'dscode-session-bridge', 'dscode-session-cards', 'dscode-memory', 'dscode-email-tools', 'dscode-hooks', 'dscode-auto-review', 'dscode-session-metrics', 'dscode-tui-tools']
    .map(id => `- id: ${id}\n  disabled: true`).join('\n')}\n- insert:\n    - id: dscode-doctor-cli\n      name: ${JSON.stringify(runner)}\n      config:\n        local: ${mode === 'local'}\n        preview: ${mode === 'preview'}\n`;
}

export async function runDoctorCli(home = runtimeHome, mode = 'analyze') {
  if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
  provision(home, { cwd: realpathSync(process.cwd()) });
  mkdirSync(home, { recursive: true });
  const overlay = join(home, 'doctor-cli.patch.yml');
  writeFileSync(overlay, doctorOverlay(join(root, 'plugins/tui-tools/doctor-cli.mjs'), mode), { mode: 0o600 });
  const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', overlay], {
    cwd: process.cwd(), env: environment(home), stdio: 'inherit',
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => child.kill(sig));
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`DSCODE doctor exited: ${signal ?? code}`)));
  });
}
