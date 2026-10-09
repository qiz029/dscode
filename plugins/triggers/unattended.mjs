// Per-Agent authority: one unattended task must not disable schedule management
// for unrelated interactive sessions sharing a Desktop Host.
const unattended = new WeakSet();
export const isUnattended = agent => unattended.has(agent);
export function markUnattended(agent) {
  unattended.add(agent);
  return () => unattended.delete(agent);
}

/** Mutations schedule future autonomous work; use the existing approval pipeline. */
export function mutationProblem(ctx, agent) {
  if (!agent?.session) return 'A session is required';
  if (process.env.DSCODE_TRIGGER_OPTIONS || isUnattended(agent) || (agent.session.header?.delegationDepth ?? 0) > 0) return 'Unattended runs and subagents cannot manage schedules';
  const plan = ctx.get('planMode')?.get(agent);
  if (plan?.active || plan?.pending) return 'Schedule management is unavailable in plan mode';
  const permission = ctx.permissionPresets.current(agent.session);
  if (!['auto-review', 'auto', 'ask', 'workspace-write', 'danger-full-access'].includes(permission)) return 'Schedule management requires a writable permission preset';
}
