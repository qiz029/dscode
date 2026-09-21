// The poll predicate: with no resident listener, "watch an external thing" is a
// scheduled cheap check that only starts a session when something changed. The
// check is a shell command run in the definition's workspace; exit 0 means
// "there is work", anything else means "nothing to do".
//
// A predicate that cannot run must not fire a run: a spawn failure or a timeout
// is reported as not matched, never as a match.

import { spawn as nodeSpawn } from 'node:child_process';

/** Output cap for the check's own text, so a chatty check cannot flood a record. */
export const MAX_CHECK_OUTPUT_CHARS = 2000;

/**
 * Run one poll predicate.
 * @param check - the shell command from `source.check`.
 * @param options - `{ cwd, timeoutMs, spawn }`; `spawn` is injectable for tests.
 * @returns `{ matched, code, output }`: `matched` is true only on exit 0.
 */
export function evaluateCheck(check, { cwd, timeoutMs = 60000, spawn = nodeSpawn } = {}) {
  return new Promise(resolveCheck => {
    let child;
    try {
      child = spawn('/bin/sh', ['-c', check], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolveCheck({ matched: false, code: null, output: `could not start the check: ${error?.message ?? error}` });
      return;
    }
    let output = '';
    let settled = false;
    const collect = chunk => {
      if (output.length < MAX_CHECK_OUTPUT_CHARS) output += String(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolveCheck({ matched: false, code: null, output: `${output}\n(the check exceeded ${timeoutMs}ms and was stopped)`.trim().slice(0, MAX_CHECK_OUTPUT_CHARS) });
    }, timeoutMs);
    timer.unref?.();
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCheck({ matched: code === 0, code, output: output.replace(/\s+/gu, ' ').trim().slice(0, MAX_CHECK_OUTPUT_CHARS) });
    };
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveCheck({ matched: false, code: null, output: `the check failed to start: ${error?.message ?? error}` });
    });
    child.once('exit', code => finish(code));
  });
}
