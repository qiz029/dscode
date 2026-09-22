// A trigger owns this binding, independently of any one run's outcome. Publish
// it only after the new session has been flushed, before delivering its input.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const bindingPath = (home, id) => join(home, 'triggers', 'sessions', `${id}.json`);

export function readSessionBinding(home, spec) {
  let binding;
  try { binding = JSON.parse(readFileSync(bindingPath(home, spec.triggerId), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!binding || typeof binding.sessionId !== 'string' || !binding.sessionId || binding.triggerId !== spec.triggerId) {
    throw new Error(`invalid session binding for ${spec.triggerId}`);
  }
  if (binding.workspace !== spec.workspace || binding.preset !== (spec.preset ?? 'dscode')) {
    throw new Error(`persistent trigger ${spec.triggerId} is bound to another workspace or preset; use a new trigger id`);
  }
  return binding;
}

export function writeSessionBinding(home, spec, sessionId) {
  const path = bindingPath(home, spec.triggerId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const scratch = `${path}.${randomUUID()}.tmp`;
  writeFileSync(scratch, JSON.stringify({ triggerId: spec.triggerId, sessionId, workspace: spec.workspace, preset: spec.preset ?? 'dscode' }) + '\n', { mode: 0o600 });
  renameSync(scratch, path);
}

/** Called under the CLI's trigger lease. A failed resume never erases history. */
export async function openTriggerSession(ctx, spec, { home, agentOptions, setup }) {
  const persistent = spec.session?.mode === 'persistent';
  const binding = persistent ? readSessionBinding(home, spec) : undefined;
  const handle = binding
    ? await ctx.agents.resume({ resumeSessionId: binding.sessionId, agentOptions, setup })
    : await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: spec.workspace, agentPreset: spec.preset ?? 'dscode' }, agentOptions, setup });
  if (handle.agent.session.header.cwd !== spec.workspace) throw new Error('trigger session workspace does not match its definition');
  if (persistent && !binding) {
    await ctx.sessions.flush(handle.agent.session);
    writeSessionBinding(home, spec, handle.agent.session.id);
  }
  return handle;
}
