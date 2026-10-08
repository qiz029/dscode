import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as Instructions from '@deepseek-ai/dsh-agent-instructions';
import * as FilesystemSkills from '@deepseek-ai/dsh-skill-filesystem';
import { ancestorSkillDirs, writeWorkspaceInstructions } from '../tui-tools/workspace-discovery.mjs';
import { writeHookConfig } from '../tui-tools/hook-sources.mjs';
import { mountWorkspaceHooks } from './hooks.mjs';

export const name = 'dscode-desktop-workspace';
export const inject = ['agents', 'agentPresets', 'skills', 'sessionProjections', 'shell'];

/** Session-owned discovery; Desktop's process cwd is not a workspace identity. */
export function apply(ctx) {
  const stateDir = process.env.DSH_HOME;
  if (!stateDir) throw Error('Desktop workspace discovery requires DSH_HOME');
  mkdirSync(join(stateDir, 'config'), { recursive: true });
  const installationHooks = join(stateDir, 'config/hooks.local.json');
  if (!existsSync(installationHooks)) writeFileSync(installationHooks, '{"hooks":{}}\n', { mode: 0o600, flag: 'wx' });
  ctx.on('agent/created', async payload => {
    const { agent } = payload;
    if (ctx.agentPresets.composedPreset(agent.ctx) !== 'dscode') return;
    const cwd = agent.session.header.cwd;
    if (!cwd) throw Error('DSCODE Desktop sessions require a workspace directory');
    const home = homedir();
    const key = createHash('sha256').update(JSON.stringify([agent.session.id, resolve(cwd)])).digest('hex');
    const directory = join(stateDir, 'desktop-workspaces', key);
    const outputDir = join(directory, 'instructions');
    const instructionHome = writeWorkspaceInstructions({ cwd, home, stateDir, outputDir }) ?? stateDir;
    agent.ctx.effect(() => () => rmSync(directory, { recursive: true, force: true }));
    await agent.ctx.plugin(Instructions, { dshHome: instructionHome, maxBytes: 65536 });
    await agent.ctx.plugin(FilesystemSkills, { customSkillDirs: ancestorSkillDirs({ cwd, home }) });
    const hooks = writeHookConfig({ root: stateDir, cwd, home: directory });
    await mountWorkspaceHooks(agent.ctx, hooks.path, payload);
  });
}
