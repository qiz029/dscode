import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
export const name = 'dscode-bootstrap';
export function apply(ctx) {
  const root = dirname(fileURLToPath(import.meta.url));
  const home = process.env.DSH_HOME;
  if (!home) throw new Error('DSCODE requires DSH_HOME. Start with dscode, or set an isolated DSH_HOME.');
  const config = join(home, 'config');
  mkdirSync(config, { recursive: true });
  const hooks = join(config, 'hooks.local.json');
  if (!existsSync(hooks)) writeFileSync(hooks, '{"hooks":{}}\n', { mode: 0o600, flag: 'wx' });
  const require = createRequire(import.meta.url);
  const chrome = join(dirname(require.resolve('chrome-devtools-mcp/package.json')), 'build/src/bin/chrome-devtools-mcp.js');
  ctx.provide('dscodePaths', { presets: join(root, 'presets'), hooks, chrome });
  const oldPath = process.env.PATH;
  const added = join(root, 'bin');
  process.env.PATH = added + ':' + (oldPath ?? '');
  ctx.on('dispose', () => { if (process.env.PATH === added + ':' + (oldPath ?? '')) process.env.PATH = oldPath; });
}
