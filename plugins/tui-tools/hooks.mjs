export const hookEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
// Fail visibly instead of letting the upstream compatibility bridge silently skip gates.
export function validateHooks(raw) {
  const hooks = raw?.hooks ?? raw;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error('hooks must be an event map');
  for (const [event, groups] of Object.entries(hooks)) {
    if (!hookEvents.includes(event)) throw new Error(`Unsupported hook event: ${event}`);
    if (!Array.isArray(groups)) throw new Error(`${event}: expected matcher groups`);
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) throw new Error(`${event}: expected hooks array`);
      if (group.matcher !== undefined) {
        if (typeof group.matcher !== 'string') throw new Error(`${event}: matcher must be a regex string`);
        new RegExp(group.matcher);
      }
      for (const hook of group.hooks) {
        if (!hook || (hook.type !== undefined && hook.type !== 'command') || hook.async === true || typeof hook.command !== 'string' || !hook.command.trim()) throw new Error(`${event}: only synchronous command hooks are supported`);
        const timeout = hook.timeout ?? hook.timeoutSec;
        if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600)) throw new Error(`${event}: timeout must be 0–600 seconds, excluding zero`);
      }
    }
  }
  return hooks;
}
