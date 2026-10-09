const targets = new Map();

/** Keep name resolution out of the runtime's immutable tool-call arguments. */
export async function withChildTarget(exec, target, next) {
  const key = exec.token ?? exec;
  targets.set(key, target);
  try { return await next(); }
  finally { targets.delete(key); }
}

export function childTarget(exec) { return targets.get(exec.token ?? exec) ?? exec.arguments.agent_id; }
