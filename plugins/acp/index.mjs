import { apply as applyAcp } from '@deepseek-ai/dsh-acp';
import z from '@deepseek-ai/schemastery';

export const name = 'dscode-acp';
export const inject = ['acpAppStartup', 'agents', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'llm', 'sessionPersistence', 'sessions', 'dscodeCustom'];
export const Config = z.object({ model: z.string() });

// Scope the factory to this bridge: TUI and delegated agents keep their own
// composition. ACP still owns model selection, MCP attachment and disposal.
export function presetAgents(ctx) {
  const wrap = method => async (options) => {
    const handle = await ctx.agents[method]({
      ...options,
      ...(method === 'create' ? { meta: { ...options.meta, agentPreset: 'dscode' } } : {}),
      setup: async (agentCtx, agent) => {
        await ctx.agentPresets.mount(agentCtx, 'dscode');
        await options.setup?.(agentCtx, agent);
      },
    });
    ctx.permissionPresets.set(handle.agent.session, 'ask');
    return handle;
  };
  const overrides = { create: wrap('create'), resume: wrap('resume') };
  return new Proxy(ctx.agents, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function startAcp(ctx, config = {}, bridge = applyAcp) {
  const selection = config.model
    ? { provider: config.model.slice(0, config.model.indexOf('/')), model: config.model.slice(config.model.indexOf('/') + 1) }
    : ctx.agentDefaultModel.currentSelection();
  const scoped = ctx.extend({ agents: presetAgents(ctx) });
  bridge(scoped, { provider: selection.provider, model: selection.model });
}

export async function apply(ctx, config) {
  await ctx.get('dscodeCustom').refresh();
  startAcp(ctx, config);
}
