#!/usr/bin/env node
// A custom runner for @deepseek-ai/dsh-sandbox-local, selected through the `sandbox`
// row's `runnerCommand`. The provider appends a bwrap-compatible profile and then
// `--` and the command:
//
//   dsh-sandbox-runner --ro-bind / / --dev /dev --unshare-pid --proc /proc
//     --die-with-parent [--tmpfs /tmp] [--bind <root> <root>] -- <command...>
//
// We translate the profile into a Seatbelt one and add the single grant the built-in
// profile lacks: /dev/ptmx. Without it a confined command cannot allocate a PTY
// (posix_openpt returns EPERM), which silently breaks nested harnesses, tmux, expect
// and any node-pty based suite. When the kernel refuses to apply another profile —
// which is exactly what happens inside an already-confined process — the command
// inherits the enclosing profile instead of nesting a second one.
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NAME = 'dscode-sandbox-runner';
// Configure this string as runnerFailureSignatures so the provider recognises our
// own failures instead of reading them as a denied command.
export const FATAL_PREFIX = `${NAME}: fatal: `;
// Informational output must never carry the configured failure signature: the provider
// turns any non-zero exit whose stderr matches it into a sandbox failure, so a notice
// would misreport a failing command as a broken runner.
export const NOTICE_PREFIX = `${NAME}: notice: `;
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const OPERAND_FLAGS = new Map([['--ro-bind', 2], ['--bind', 2], ['--tmpfs', 1], ['--dev', 1], ['--proc', 1], ['--dir', 1]]);

const canonical = path => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

const sbpl = path => `"${String(path).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/** Split the appended bwrap-compatible profile from the command after `--`. */
export function parseProfile(argv) {
  const writable = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--') { index += 1; break; }
    if (!token.startsWith('--')) throw new Error(`unexpected profile argument ${JSON.stringify(token)}`);
    const operands = OPERAND_FLAGS.get(token) ?? 0;
    if (operands === 2) {
      const [, destination] = [argv[index + 1], argv[index + 2]];
      if (!destination) throw new Error(`${token} needs two operands`);
      if (token === '--bind') writable.push(destination);
    } else if (operands === 1 && !argv[index + 1]) throw new Error(`${token} needs an operand`);
    index += operands + 1;
  }
  return { writable, command: argv.slice(index) };
}

/** Writable roots that mirror the provider's own Seatbelt grant, plus the temp areas. */
export function writableRoots(parsed, { temp = tmpdir() } = {}) {
  return [...new Set([...parsed.writable, '/tmp', temp].map(canonical))];
}

/** The SBPL profile: upstream's deny-by-default write policy plus /dev/ptmx. */
export function seatbeltProfile(roots) {
  const forms = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (literal ${sbpl('/dev/null')}))`,
    `(allow file-write* (literal ${sbpl('/dev/ptmx')}))`,
  ];
  if (roots.length) forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbpl(root)})`).join(' ')})`);
  return forms.join(' ');
}

/** Whether this process may apply a Seatbelt profile at all. */
export function seatbeltApplies(exec = SANDBOX_EXEC) {
  const probe = spawnSync(exec, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (probe.error) return probe.error.code === 'ENOENT' ? { ok: false, reason: 'missing' } : { ok: false, reason: probe.error.message };
  if (probe.status === 0) return { ok: true };
  return { ok: false, reason: (probe.stderr ?? '').trim().split('\n').at(-1) || `exit ${probe.status}` };
}

const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function runUnder(program, args) {
  return new Promise(resolvePromise => {
    const child = spawn(program, args, { stdio: 'inherit' });
    const forward = signal => () => { try { child.kill(signal); } catch { /* already gone */ } };
    const handlers = Object.keys(SIGNAL_CODES).map(signal => [signal, forward(signal)]);
    for (const [signal, handler] of handlers) process.on(signal, handler);
    child.on('error', error => { process.stderr.write(`${FATAL_PREFIX}${error.message}\n`); resolvePromise(126); });
    child.on('exit', (code, signal) => resolvePromise(code ?? SIGNAL_CODES[signal] ?? 1));
  });
}

export async function run(argv, { exec = SANDBOX_EXEC, stderr = process.stderr } = {}) {
  const parsed = parseProfile(argv);
  if (parsed.command.length === 0) {
    stderr.write(`${FATAL_PREFIX}no command after --\n`);
    return 126;
  }
  const [program, ...args] = parsed.command;
  const applies = seatbeltApplies(exec);
  if (!applies.ok && applies.reason === 'missing') {
    stderr.write(`${FATAL_PREFIX}${exec} is not available; refusing to run unconfined\n`);
    return 126;
  }
  if (!applies.ok) {
    // Applying a profile is what the kernel refuses inside an existing one, so this
    // process is already confined: inherit that profile rather than nest a second.
    stderr.write(`${NOTICE_PREFIX}inheriting the enclosing profile (${applies.reason})\n`);
    return runUnder(program, args);
  }
  return runUnder(exec, ['-p', seatbeltProfile(writableRoots(parsed)), '--', program, ...args]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${FATAL_PREFIX}${error.message}\n`);
    process.exitCode = 126;
  });
}
