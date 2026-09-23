import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHookConfig } from '../../plugins/tui-tools/hook-sources.mjs';
import { ancestorSkillDirs, writeWorkspaceInstructions } from '../../plugins/tui-tools/workspace-discovery.mjs';
import { homedir } from 'node:os';
export const name = 'dscode-bootstrap';
export function apply(ctx) {
  const root = dirname(fileURLToPath(import.meta.url));
  const home = process.env.DSH_HOME;
  if (!home) throw new Error('DSCODE requires DSH_HOME. Start with dscode, or set an isolated DSH_HOME.');
  const config = join(home, 'config');
  mkdirSync(config, { recursive: true });
  const hooks = join(config, 'hooks.local.json');
  if (!existsSync(hooks)) writeFileSync(hooks, '{"hooks":{}}\n', { mode: 0o600, flag: 'wx' });
  const hookConfig = writeHookConfig({ root: home, cwd: process.cwd(), home });
  // The bundle knows the session directory only at runtime, so the same ancestor
  // resolution the launcher runs happens here before the agent preset mounts.
  process.env.DSCODE_SKILL_ANCESTOR_DIRS = JSON.stringify(ancestorSkillDirs({ cwd: process.cwd(), home: homedir() }));
  process.env.DSCODE_INSTRUCTION_HOME = writeWorkspaceInstructions({ cwd: process.cwd(), home: homedir(), stateDir: home }) ?? home;
  process.env.DSCODE_SANDBOX_RUNNER = join(root, 'plugins/tui-tools/sandbox-runner.mjs');
  ctx.provide('dscodePaths', { hooks: hookConfig.path });
  const oldPath = process.env.PATH;
  const added = join(root, 'bin');
  process.env.PATH = added + ':' + (oldPath ?? '');
  ctx.on('dispose', () => { if (process.env.PATH === added + ':' + (oldPath ?? '')) process.env.PATH = oldPath; });
}
