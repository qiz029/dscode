import { spawn } from 'node:child_process';

// User-authored shell commands only: never registered as an agent tool.
export function runShell(command, { cwd, signal, timeoutMs = 120000, maxBytes = 65536 } = {}) {
  if (!command.trim()) return Promise.resolve({ kind: 'error', text: 'Usage: !<shell command>' });
  if (signal?.aborted) return Promise.resolve({ kind: 'error', text: 'Shell command cancelled' });
  return new Promise(resolve => {
    const child = spawn(process.env.SHELL || '/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, stopped = '', failure;
    const collect = chunk => {
      if (bytes < maxBytes) output += chunk.subarray(0, maxBytes - bytes).toString();
      bytes += chunk.length;
    };
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const cancel = () => { stopped = 'cancelled'; kill(); };
    const timer = setTimeout(() => { stopped = 'timed out'; kill(); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { failure = error.message; });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve({ kind: code === 0 && !stopped && !failure ? 'success' : 'error', text: [output.trimEnd(), bytes > maxBytes ? '[output truncated]' : '', failure || (stopped ? `Shell command ${stopped}` : `Exit ${code ?? exitSignal}`)].filter(Boolean).join('\n') });
    });
  });
}
