import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { root, provision, runDsh, runtimeHome } from './harness.mjs';
import { parseAcpArgs, acpOverlay, USAGE } from '../plugins/acp/cli.mjs';

export async function runAcp(argv, { home = process.env.DSCODE_ACP_HOME ?? runtimeHome, prepare = provision, launch = runDsh } = {}) {
  const options = parseAcpArgs(argv);
  if (options.help) { process.stdout.write(USAGE + '\n'); return 0; }
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  prepare(home, { cwd: process.cwd() });
  const scratch = mkdtempSync(join(tmpdir(), 'dscode-acp-'));
  const handlers = [];
  try {
    const overlay = join(scratch, 'acp.patch.yml');
    writeFileSync(overlay, acpOverlay(join(root, 'plugins/acp/index.mjs'), options));
    const overlays = ['mcp.local.yml', 'harness.local.yml'].flatMap(file => {
      const path = join(root, 'config', file);
      return existsSync(path) ? ['--patch', path] : [];
    });
    const child = launch([...overlays, ...options.patches.flatMap(path => ['--patch', resolve(path)]), '--patch', overlay], { home, cwd: process.cwd() });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => child.kill(signal);
      handlers.push([signal, handler]); process.on(signal, handler);
    }
    return await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 130 : 0)));
    });
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    rmSync(scratch, { recursive: true, force: true });
  }
}
