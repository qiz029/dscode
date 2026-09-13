export const name = 'dscode-execution-policy';
export const inject = ['systemPrompt', 'tools', 'agents', 'commands', 'terminals'];
export const SHELL_POLICY = `Use bash as the persistent shell for reading, searching and modifying files. Prefer rg/rg --files, sed and standard CLI tools. Use apply_patch with a standard unified diff on stdin (git apply format, a/ and b/ paths); apply_patch --check validates before writing. It is not the *** Begin Patch format. Quote heredoc delimiters to avoid shell interpolation.
Each agent has its own persistent shell, initially in the session workspace. cd, exported variables, functions and background jobs persist only while this shell lives. Timeout, cancellation, exit, /shell reset and process restart discard shell state; resume restores conversation, not an OS process. Never assume an environment from a past session still exists. Inspect pwd when paths matter. Keep long-running processes controlled and clean them up when done.
Normal bash remains confined by the active sandbox. After a genuine sandbox denial, shell_retry provides a fresh, one-shot shell with the existing approval/escalation mechanism. Set an explicit absolute workdir and reconstruct needed non-secret setup; it does not inherit the persistent shell's cd, exports, functions or jobs. Use existing credential-aware CLIs; never paste secrets into arguments. Approval rejection is final for that action; do not work around it.
Delegation to child agents (subagent, subagent_fork) exists only at the ultra effort; at low, high and max, do the work in this agent. Ultra adds its own delegation guidance to the request; the preset allows one delegation level and the runtime caps a parent at three concurrently running children.`;

/** Child names: 1-10 characters, letters/digits/underscores, starting and ending with a letter. */
export const CHILD_NAME = /^[A-Za-z](?:[A-Za-z0-9_]{0,8}[A-Za-z])?$/;
export const CHILD_NAME_RULE = 'name must be 1-10 characters of letters, digits or underscores, starting and ending with a letter';
const DELEGATION_TOOLS = ['subagent', 'subagent_fork', 'workflow', 'ralph'];

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'dscode:shell-policy', order: 1050, text: SHELL_POLICY });
  ctx.systemPrompt.section({ name: 'dscode:child-policy', order: 1051, text: ({ scope }) => scope?.session?.header?.origin === 'subagent' && scope.session.header.agentPreset === 'dscode'
    ? 'You are a delegated worker. Complete your assigned task yourself and return a concise result to the parent. You cannot start or wake another agent; ask the parent to make any new delegation decision. Your parent is addressed as / in send_message.' : '' });
  // Child names chosen by the parent, keyed by parent session: /name resolves to the durable child id.
  const names = new Map();
  const liveChildren = ownerId => {
    const known = names.get(ownerId) ?? new Map();
    for (const [name, childId] of known) if (ctx.agents.get(childId) === undefined) known.delete(name);
    return known;
  };
  const resolveAgentPath = (owner, value) => {
    if (typeof value !== 'string' || !value.startsWith('/')) return value;
    if (value === '/') {
      const parent = owner.session.header.parentSession;
      if (!parent) throw new Error('This agent has no parent; / is only valid inside a child agent.');
      return parent;
    }
    const known = liveChildren(owner.session.id);
    const childId = known.get(value.slice(1));
    if (!childId) throw new Error(`Unknown child ${value}. Live children: ${[...known.keys()].map(name => '/' + name).join(', ') || '(none)'}.`);
    return childId;
  };
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    if (context.scope?.session?.header?.origin !== 'subagent' || context.scope.session.header.agentPreset !== 'dscode') return assembled;
    const hidden = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph']);
    return { ...assembled, tools: assembled.tools.filter(tool => !hidden.has(tool.name)), sections: assembled.sections.filter(section => !hidden.has(section.name.replace(/^tool:/, ''))) };
  });
  const reservations = new Map();
  ctx.on('tools/execute', async (exec, next) => {
    const owner = exec.agent;
    if (!owner || !['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'workflow', 'ralph'].includes(exec.name)) return next();
    if (exec.name === 'send_message' || exec.name === 'interrupt_agent') exec.arguments.agent_id = resolveAgentPath(owner, exec.arguments.agent_id);
    if (exec.name === 'interrupt_agent') return next();
    if (owner.session.header.origin === 'subagent' && DELEGATION_TOOLS.includes(exec.name)) throw new Error('Child agents cannot delegate again. Complete the assigned work and report to the parent.');
    const effort = owner.session.requestHeader()?.config?.reasoningEffort ?? owner.options.reasoningEffort;
    if (effort !== 'ultra') {
      if (DELEGATION_TOOLS.includes(exec.name)) throw new Error('Child-agent work requires Ultra. Select /effort ultra before delegating.');
      const target = ctx.agents.get(exec.arguments.agent_id);
      if (target?.status !== 'running' && target?.session.header.parentSession === owner.session.id) throw new Error('Waking a child agent requires Ultra. Select /effort ultra first.');
      return next();
    }
    if (['workflow', 'ralph'].includes(exec.name)) throw new Error('Use capped subagent/subagent_fork delegation in Ultra; workflow and ralph are unavailable in dscode.');
    const target = exec.name === 'send_message' ? ctx.agents.get(exec.arguments.agent_id) : undefined;
    if (exec.name === 'send_message' && (exec.arguments.agent_id === owner.session.header.parentSession || target?.status === 'running')) return next();
    const id = owner.session.id;
    const running = ctx.agents.list().filter(a => a.session.header.origin === 'subagent' && a.session.header.parentSession === id && a.status === 'running').length;
    if (running + (reservations.get(id) ?? 0) >= 3) throw new Error('Ultra concurrent child limit reached (3). Wait for a child to settle, then delegate or send more work.');
    const childName = exec.name === 'send_message' ? undefined : exec.arguments.name;
    if (childName !== undefined) {
      if (typeof childName !== 'string' || !CHILD_NAME.test(childName)) throw new Error(CHILD_NAME_RULE);
      if (liveChildren(id).has(childName)) throw new Error(`Child name /${childName} is already used by a live child of this agent; choose another name.`);
    }
    reservations.set(id, (reservations.get(id) ?? 0) + 1);
    try {
      const result = await next();
      if (childName !== undefined && result?.kind === 'continuable' && typeof result.subagentId === 'string') {
        if (!names.has(id)) names.set(id, new Map());
        names.get(id).set(childName, result.subagentId);
      }
      return result;
    }
    finally { const left = (reservations.get(id) ?? 1) - 1; if (left) reservations.set(id, left); else reservations.delete(id); }
  });
  ctx.commands.register({ name: 'shell', description: 'Persistent shell status or reset (idle only)', handler: async ({ agent, rawInput }) => {
    const action = rawInput.trim() || 'status';
    const sessions = ctx.terminals.list(agent);
    if (action === 'status') return { kind: 'success', text: `Persistent terminals: ${sessions.length}. ${sessions.map(s => `${s.sessionId}: ${JSON.stringify(s.status)}`).join('\n')}\nState is process-local, not restored from conversation. /shell reset closes shells and discards cwd, exports and jobs.` };
    if (action !== 'reset') return { kind: 'error', text: 'Usage: /shell [status|reset]' };
    if (agent.status === 'running') return { kind: 'error', text: 'Stop the running turn before resetting its shell.' };
    for (const session of sessions) await ctx.terminals.kill(agent, session.sessionId, 'User requested /shell reset');
    return { kind: 'success', text: 'Shells closed. The next bash call starts fresh from the workspace.' };
  }});
}
