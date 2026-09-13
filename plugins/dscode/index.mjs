export const name = 'dscode-execution-policy';
export const inject = ['systemPrompt', 'tools', 'agents', 'commands', 'terminals'];
export const SHELL_POLICY = `Use bash as the persistent shell for reading, searching and modifying files. Prefer rg/rg --files, sed and standard CLI tools. Use apply_patch with a standard unified diff on stdin (git apply format, a/ and b/ paths); apply_patch --check validates before writing. It is not the *** Begin Patch format. Quote heredoc delimiters to avoid shell interpolation.
Each agent has its own persistent shell, initially in the session workspace. cd, exported variables, functions and background jobs persist only while this shell lives. Timeout, cancellation, exit, /shell reset and process restart discard shell state; resume restores conversation, not an OS process. Never assume an environment from a past session still exists. Inspect pwd when paths matter. Keep long-running processes controlled and clean them up when done.
Normal bash remains confined by the active sandbox. After a genuine sandbox denial, shell_retry provides a fresh, one-shot shell with the existing approval/escalation mechanism. Set an explicit absolute workdir and reconstruct needed non-secret setup; it does not inherit the persistent shell's cd, exports, functions or jobs. Use existing credential-aware CLIs; never paste secrets into arguments. Approval rejection is final for that action; do not work around it.
Ultra is a DeepSeek harness effort: the provider sends max and adds collaboration guidance. Only Ultra may start or wake child agents; low, high and max work in the current agent. Before spawning a child in Ultra, identify an independent bounded task and a clear wall-clock benefit. Complete small bounded tasks directly. Prefer subagent_fork when the child needs established conversation context; use fresh subagent for a self-contained task that does not benefit from that history. The current unfinished turn is not included in a fork, so always give the child a self-contained assignment. When delegating, use reasoning_effort to choose the child effort independently: low for bounded work, high for difficult work, max only when needed. Omission inherits the parent. Choose worktree: true for independent parallel edits when the parent Git workspace is clean; the child then starts at HEAD in an isolated checkout. Omit it for read-only work or a child that needs uncommitted parent files. For substantial tasks, use at most three concurrently running children when useful. Assign disjoint file ownership in a shared workspace and verify results. Inspect and integrate isolated child changes before removing its worktree. Children complete their assigned work themselves and return results to the parent; they cannot delegate again. The runtime enforces a three-child cap in ultra and the preset allows one delegation level.`;

export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'dscode:shell-policy', order: 1050, text: SHELL_POLICY });
  ctx.systemPrompt.section({ name: 'dscode:child-policy', order: 1051, text: ({ scope }) => scope?.session?.header?.origin === 'subagent' && scope.session.header.agentPreset === 'dscode'
    ? 'You are a delegated worker. Complete your assigned task yourself and return a concise result to the parent. You cannot start or wake another agent; ask the parent to make any new delegation decision.' : '' });
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next();
    if (context.scope?.session?.header?.origin !== 'subagent' || context.scope.session.header.agentPreset !== 'dscode') return assembled;
    const hidden = new Set(['subagent', 'subagent_fork', 'workflow', 'ralph']);
    return { ...assembled, tools: assembled.tools.filter(tool => !hidden.has(tool.name)), sections: assembled.sections.filter(section => !hidden.has(section.name.replace(/^tool:/, ''))) };
  });
  const reservations = new Map();
  ctx.on('tools/execute', async (exec, next) => {
    const owner = exec.agent;
    if (!owner || !['subagent', 'subagent_fork', 'send_message', 'workflow', 'ralph'].includes(exec.name)) return next();
    if (owner.session.header.origin === 'subagent' && ['subagent', 'subagent_fork', 'workflow', 'ralph'].includes(exec.name)) throw new Error('Child agents cannot delegate again. Complete the assigned work and report to the parent.');
    const effort = owner.session.requestHeader()?.config?.reasoningEffort ?? owner.options.reasoningEffort;
    if (effort !== 'ultra') {
      if (['subagent', 'subagent_fork', 'workflow', 'ralph'].includes(exec.name)) throw new Error('Child-agent work requires Ultra. Select /effort ultra before delegating.');
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
    reservations.set(id, (reservations.get(id) ?? 0) + 1);
    try { return await next(); }
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
