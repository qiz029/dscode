import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { hookEvents, validateHooks } from './hooks.mjs';
import { redact } from '../auto-review/policy.mjs';

export const name = 'dscode-tui-tools';
export const inject = ['commands', 'agents', 'tools', 'skills', 'permissionPresets'];
const phases = ['pending', 'loading', 'active', 'failed', 'unavailable', 'unloading'];
const ok = text => ({ kind: 'success', text });
const fail = text => ({ kind: 'error', text });
const show = value => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const exists = path => access(path).then(() => true, () => false);

export async function findConflicts(cwd, configs, winners, env = process.env) {
  let project = resolve(cwd);
  while (!await exists(join(project, '.git')) && dirname(project) !== project) project = dirname(project);
  if (!await exists(join(project, '.git'))) project = resolve(cwd);
  const roots = [];
  const skipSystemRoots = new Set();
  for (const config of configs) {
    if (config.includeDefaultRoots !== false) {
      roots.push(join(project, '.dsh/skills'), join(project, '.agents/skills'));
      const dshHome = config.dshHome ?? env.DSH_HOME;
      const agentsHome = config.agentsHome ?? env.DSH_AGENTS_HOME;
      if (typeof dshHome === 'string') { const path = resolve(dshHome, 'skills'); roots.push(path); skipSystemRoots.add(path); }
      if (typeof agentsHome === 'string') roots.push(resolve(agentsHome, 'skills'));
    }
    roots.push(...(config.customSkillDirs ?? []).filter(x => typeof x === 'string').map(x => resolve(x)));
    const bundled = config.bundledSkillDir ?? (config.includeDefaultRoots !== false ? env.DSH_BUNDLED_SKILL_DIR : undefined);
    if (typeof bundled === 'string') roots.push(resolve(bundled));
  }
  const candidates = new Map();
  const errors = [];
  for (const root of new Set(roots)) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (e) { if (e.code !== 'ENOENT') errors.push(`${root}: ${e.code}`); continue; }
    for (const entry of entries) {
      if (entry.name === '.system' && skipSystemRoots.has(root)) continue;
      const path = entry.isFile() && entry.name.endsWith('.md') ? join(root, entry.name) : join(root, entry.name, 'SKILL.md');
      try {
        const raw = await readFile(path, 'utf8');
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        const meta = match && parse(match[1]);
        if (typeof meta?.name !== 'string' || typeof meta.description !== 'string') continue;
        const list = candidates.get(meta.name) ?? [];
        list.push(path); candidates.set(meta.name, list);
      } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) errors.push(`${path}: invalid or unreadable`); }
    }
  }
  const lines = [];
  for (const [name, paths] of candidates) if (paths.length > 1) {
    const winner = winners.find(s => s.name === name);
    lines.push(`${name}: effective source=${winner?.source ?? 'not in catalog'} provider=${winner?.provider ?? '?'}\n${paths.map(p => `  ${p}`).join('\n')}`);
  }
  return [...lines, ...errors, 'Scope: filesystem roots only; runtime/remote provider shadowed candidates are not exposed by DSH.'].join('\n');
}

export function apply(ctx) {
  const entries = () => [...(ctx.get('loader')?.entries() ?? [])].filter(e => e.options.group !== true);
  const mcps = () => entries().filter(e => e.options.name === '@deepseek-ai/dsh-mcp-client');
  const hook = () => entries().find(e => e.options.id === 'dscode-hooks');
  const state = e => e.disabled ? 'disabled' : phases[e.fiber?.state] ?? 'unavailable';
  let changing = false;
  const mutate = async fn => {
    if (changing || ctx.agents.list().some(a => a.status === 'running')) return fail('Wait until all agents are idle before changing process-wide plugins.');
    changing = true;
    try { return await fn(); } finally { changing = false; }
  };
  const register = (name, description, handler) => ctx.commands.register({ name, description, handler: async inv => {
    try { const result = await handler(inv); return { ...result, text: redact(result.text ?? '') }; }
    catch (e) { return fail(redact(`${name}: ${e.message}`)); }
  }});
  register('status', 'Session, model, permissions, usage and plugin health', ({ agent }) => {
    const session = agent.session;
    const route = session.requestHeader()?.config ?? agent.options;
    const events = session.snapshotEvents();
    const projections = ctx.get('sessionProjections');
    const usage = projections?.stateOf(session, 'tokenUsage')?.totals;
    const pressure = projections?.stateOf(session, 'contextPressure');
    return ok([
      `Session: ${session.id}`, `Workspace: ${session.header.cwd ?? process.cwd()}`,
      `Agent: ${agent.status} | preset: ${session.header.agentPreset ?? 'standard'}`,
      `Model: ${route?.provider ?? 'default'} / ${route?.model ?? 'default'}`,
      `Effort: ${route?.reasoningEffort ?? 'model default'}${route?.reasoningEffort === 'ultra' ? ' (DeepSeek wire: max; collaboration enabled)' : ''}`,
      `Permission: ${show(ctx.permissionPresets.current(session))}`,
      `Tokens: ${show(usage ?? 'no provider usage yet')}`,
      `Context: ${pressure?.pressureTokens ?? pressure?.surfaceTokens ?? '?'} / ${pressure?.contextWindow ?? '?'} tokens`,
      `Events: ${events.length}; /review-usage shows reviewer tokens`,
      `Tools: ${ctx.tools.schemas(agent).length}; MCP entries: ${mcps().length}`,
      `Plugins: ${entries().filter(e => state(e) === 'active').length} active, ${entries().filter(e => state(e) === 'failed').length} failed`,
      'Use /doctor for diagnostics; /statusline for live context/token display.',
    ].join('\n'));
  });
  register('doctor', 'Read-only runtime diagnostics (no model requests)', async ({ agent, signal }) => {
    const tools = ctx.tools.schemas(agent).map(t => t.name);
    const catalog = await ctx.skills.snapshot({ cwd: agent.session.header.cwd, scope: agent, signal });
    const computer = ctx.get('computerUse');
    return ok([
      `Node: ${process.version}; platform: ${process.platform}/${process.arch}`,
      ...entries().filter(e => !e.disabled && state(e) !== 'active').map(e => `CHECK plugin ${e.id}: ${state(e)}`),
      `Skills: ${catalog.skills.length}; discovery ${catalog.complete ? 'complete' : 'incomplete'}`,
      `Core tools: ${['bash', 'skill', 'computer_use_activate'].map(n => `${n}=${tools.includes(n)}`).join(', ')}`,
      ...mcps().map(e => `MCP ${e.id}: ${state(e)}; ${tools.filter(n => n.startsWith(`mcp__${e.options.config?.serverName}__`)).length} registered tools`),
      `Computer Use: ${computer ? show(computer.status()) : 'service unavailable'}`,
      'Credentials and remote model access: not tested. No credential values are read or printed.',
      'For deterministic execution checks outside this session: npm run doctor (in the installation directory).',
    ].join('\n'));
  });
  register('mcp', 'MCP list, tools <id>, enable/disable/reconnect <id>', async ({ agent, rawInput }) => {
    const [action = 'list', id, extra] = rawInput.trim().split(/\s+/).filter(Boolean);
    const list = mcps();
    if (action === 'list') return ok(list.map(e => `${e.id}: ${state(e)} | server=${show(e.options.config?.serverName)} | transport=${show(e.options.config?.transport)}`).join('\n') + '\n/mcp tools|enable|disable|reconnect <entry-id> — changes last for this process; persist startup config in mcp.local.yml.');
    const matches = list.filter(e => e.id === id || e.options.id === id);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (!entry || extra) return fail('Usage: /mcp [list | tools|enable|disable|reconnect <entry-id>]');
    if (action === 'tools') return ok(ctx.tools.schemas(agent).filter(t => t.name.startsWith(`mcp__${entry.options.config?.serverName}__`)).map(t => t.name).join('\n') || 'No tools currently registered.');
    if (!['enable', 'disable', 'reconnect'].includes(action)) return fail('Unknown MCP action.');
    return mutate(async () => {
      if (action === 'reconnect' && entry.disabled) return fail('Enable this server before reconnecting.');
      if (action === 'reconnect') await entry.update({ disabled: true });
      await entry.update({ disabled: action === 'disable' });
      return ok(`${entry.id}: ${state(entry)}. Use /mcp tools ${entry.id} to check discovery.`);
    });
  });
  register('skills', 'Skill catalog, sources, details and filesystem conflicts', async ({ agent, rawInput, signal }) => {
    const options = { cwd: agent.session.header.cwd ?? process.cwd(), scope: agent, signal };
    const { skills, complete } = await ctx.skills.snapshot(options);
    const arg = rawInput.trim();
    if (arg === 'conflicts') return ok(await findConflicts(options.cwd, entries().filter(e => !e.disabled && e.options.name === '@deepseek-ai/dsh-skill-filesystem').map(e => e.options.config ?? {}), skills));
    if (arg && arg !== 'list') {
      const skill = await ctx.skills.get(arg, options);
      return skill ? ok(`${skill.name}\n${skill.description}\nsource: ${skill.source}\nprovider: ${skill.provider}\npath: ${skill.path ?? '(provider managed)'}\ninvocation: ${show(skill.invocation)}`) : fail(`Unknown skill: ${arg}`);
    }
    return ok(`Discovery: ${complete ? 'complete' : 'incomplete'}\n${skills.map(s => `${s.name} [${s.source}; ${s.provider}] user=${s.invocation.userInvocable} model=${s.invocation.modelInvocable}\n  ${s.description}`).join('\n')}\n/skills <name> for details; /skills conflicts for duplicate filesystem names.`);
  });
  const hookPaths = new WeakMap();
  const hookPath = entry => {
    const path = entry.fiber?.config?.configPath ?? entry.options.config?.configPath;
    if (typeof path === 'string') { hookPaths.set(entry, path); return path; }
    const cached = hookPaths.get(entry) ?? ctx.get('dscodePaths')?.hooks;
    if (typeof cached !== 'string') throw new Error('Hook configuration path has not resolved');
    return cached;
  };
  register('hooks', 'Hook status and reload/disable/enable (installation-owned config)', async ({ rawInput }) => {
    const entry = hook();
    if (!entry) return fail('Hooks plugin is not mounted. Restart dscode after setup.');
    const action = rawInput.trim() || 'list';
    if (action !== 'list') {
      if (!['reload', 'disable', 'enable'].includes(action)) return fail('Usage: /hooks [list|reload|disable|enable]');
      return mutate(async () => {
        if (action !== 'disable') validateHooks(JSON.parse(await readFile(hookPath(entry), 'utf8')));
        if (action === 'reload') await entry.update({ disabled: true });
        await entry.update({ disabled: action === 'disable' });
        return ok(`Hooks: ${state(entry)}. Configuration changes apply after reload or restart.`);
      });
    }
    const path = hookPath(entry);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    const hooks = raw.hooks ?? raw;
    return ok(`Hooks: ${state(entry)}\nConfig: ${path}\n${Object.entries(hooks).map(([event, groups]) => `${event}: ${hookEvents.includes(event) ? 'supported' : 'UNSUPPORTED'}; ${Array.isArray(groups) ? groups.length : 0} groups`).join('\n')}\nSupported: ${hookEvents.join(', ')}\nOnly synchronous command hooks. Runs as your OS user, outside tool approval. Edit only trusted installation-owned config; /hooks reload applies it. No project hook auto-loading.\nPreCompact/PostCompact, PermissionRequest and subagent events are not supported by this bridge.`);
  });
}
