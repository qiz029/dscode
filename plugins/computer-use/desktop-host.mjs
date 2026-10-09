import { Service } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { Config, MacOSComputerUseProvider, createComputerUseTools } from './desktop-upstream.mjs';
import { computerSkill, loadedComputerSkill } from './desktop-skill.mjs';

export { Config };
export const inject = ['subprocess', 'approval', 'sessions', 'agents', 'agentPresets', 'commands'];

class DesktopComputerUseProvider extends MacOSComputerUseProvider {
  // The outer Loader entry has already validated Config and created volatile
  // references. Preserve those identities instead of validating them as numbers.
  static Config = undefined;
  async [Service.init]() {
    // A missing OS capability must remain diagnosable without disabling the Host.
    try { await super[Service.init](); } catch (error) { this.ctx.logger.warn(error.message); }
  }
}

export async function apply(ctx, config = {}) {
  await ctx.plugin(DesktopComputerUseProvider, config);
  const service = ctx.get('computerUse'), scopes = new Map();
  let closed = false;
  const isDscode = agent => agent && ctx.agentPresets.composedPreset(agent.ctx) === 'dscode';
  const mount = async agent => {
    if (closed || scopes.has(agent) || !isDscode(agent) || !service.status().ready) return;
    const fiber = agent.ctx.inject(['tools', 'skills'], scope => {
      if (closed) return;
      scope.skills.register(computerSkill);
      let active = false, bootstrap;
      const activate = () => {
        if (closed) throw Error('Computer Use has been unloaded.');
        if (active) return { activated: false };
        const definitions = createComputerUseTools(service);
        for (const definition of definitions) scope.tools.register(definition);
        active = true; bootstrap?.();
        return { activated: true, tools: definitions.map(tool => tool.name) };
      };
      if (loadedComputerSkill(agent.session)) activate();
      else bootstrap = scope.tools.register(defineTool({ name: 'computer_use_activate',
        description: `Activate native macOS tools after loading the ${computerSkill.name} skill.`, parameters: {},
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: () => {
          if (!loadedComputerSkill(agent.session)) throw Error(`Load ${computerSkill.name} first.`);
          return activate();
        },
      }));
      scope.on('tools/result', (exec, result) => {
        if (exec.agent === agent && exec.name === 'skill' && !result.isError && result.value?.name === computerSkill.name && result.value?.content === computerSkill.content) activate();
      });
    });
    scopes.set(agent, fiber);
    agent.ctx.effect(() => () => { scopes.delete(agent); });
    await fiber;
    if (closed) await fiber.dispose();
  };
  ctx.effect(() => async () => {
    closed = true;
    await Promise.all([...scopes.values()].map(fiber => fiber.dispose()));
    scopes.clear();
  }, 'dscode desktop computer-use consumers');
  ctx.on('agent/created', ({ agent }) => mount(agent));
  ctx.commands.register({ name: 'computer', description: 'Native Computer Use helper and macOS permission status',
    input: { hint: '[status]' },
    handler: async ({ agent, rawInput, signal }) => {
      if (!isDscode(agent) || closed) return { kind: 'error', text: 'Choose a DSCODE session to inspect Computer Use.' };
      if (rawInput.trim() && rawInput.trim() !== 'status') return { kind: 'error', text: 'Usage: /computer [status]' };
      try {
        const status = await service.health(signal ?? new AbortController().signal);
        if (status.ready) await Promise.all(ctx.agents.list().map(mount));
        return { kind: 'success', text: JSON.stringify(status, null, 2) };
      } catch (error) { return { kind: 'error', text: error.message }; }
    },
  });
  await Promise.all(ctx.agents.list().map(mount));
}
