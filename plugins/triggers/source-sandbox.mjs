// Script sources never fall back to unsandboxed execution.
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const canonical = path => realpathSync(path);
const literal = value => JSON.stringify(value);
export function sandboxCommand(command, { workspace, writable = [], home, permission = 'read-only', platform = process.platform } = {}) {
  const roots = writable.map(canonical);
  const project = canonical(workspace);
  const state = home ? canonical(home) : undefined;
  if (platform === 'darwin') {
    const writes = roots.map(root => `(subpath ${literal(root)})`);
    if (permission === 'workspace-write') writes.push(state
      ? `(require-all (subpath ${literal(project)}) (require-not (subpath ${literal(state)})))`
      : `(subpath ${literal(project)})`);
    const profile = `(version 1) (allow default) (deny file-write*) (allow file-write* (literal "/dev/null") ${writes.join(' ')})`;
    return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, '--', ...command] };
  }
  if (platform === 'linux') {
    const bwrap = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, 'bwrap')).find(path => existsSync(path));
    if (!bwrap) throw new Error('script sandbox unavailable: install bubblewrap');
    const args = ['--die-with-parent', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
    if (permission === 'workspace-write') args.push('--bind', project, project);
    if (state) args.push('--ro-bind', state, state);
    for (const root of roots) args.push('--bind', root, root);
    return { command: bwrap, args: [...args, '--', ...command] };
  }
  throw new Error(`script sandbox unavailable on ${platform}`);
}

export function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
