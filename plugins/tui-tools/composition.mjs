import * as presets from '@deepseek-ai/dsh-agent-preset-registry';

/** Keep mutable Host entries separate from the new registry's detached inventory. */
export function inspectComposition(ctx, agent) {
  const host = [...(ctx.get('loader')?.entries() ?? [])].filter(e => e.options.group !== true);
  if (!agent?.ctx) return { entries: host, inspections: null };
  const registry = agent.ctx.get?.('agentPresets') ?? ctx.get('agentPresets');
  if (typeof registry?.inspectCompositions === 'function') {
    // Passing the Agent context is essential: an existing session may retain an
    // older revision, and other sessions may use unrelated presets.
    return { entries: host, inspections: registry.inspectCompositions(agent.ctx) };
  }
  // The pinned terminal runtime still exposes the standing Loader tree. The
  // namespace import also loads on 0.2.1, which removed this named export.
  const entries = typeof presets.standingMountFor === 'function'
    ? [...(presets.standingMountFor(agent.ctx)?.tree.entries() ?? [])] : [];
  return { entries: [...host, ...entries.filter(e => e.options.group !== true)], inspections: null };
}

export function presetInventoryLines({ inspections }) {
  return (inspections ?? []).map(preset =>
    `Preset ${preset.id}: ${preset.modules.length} active modules (read-only inventory); leaked services: ${preset.leakedServices.join(', ') || 'none'}`);
}

export function presetMcpNotice({ inspections }, command = 'mcp') {
  return inspections?.some(preset => preset.modules.some(module => module.moduleName === '@deepseek-ai/dsh-mcp-client'))
    ? `Preset MCP modules are present. This runtime exposes no mutable preset entries or server configuration; /${command} controls Host entries only. Change preset servers through their bundle configuration and restart.` : '';
}
