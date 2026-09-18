import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAILURE_PREFIX, parseProfile, run, seatbeltApplies, seatbeltProfile, writableRoots } from '../plugins/tui-tools/sandbox-runner.mjs';

const RUNNER = join(import.meta.dirname, '..', 'plugins', 'tui-tools', 'sandbox-runner.mjs');
const upstreamWorkspaceWrite = root => ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', root, root, '--', '/bin/sh', '-c', 'printf RUNNER_OK'];

test('the appended bwrap profile is split from the command', () => {
  const readOnly = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--', 'true'];
  assert.deepEqual(parseProfile(readOnly), { writable: [], command: ['true'] });
  const workspace = parseProfile(upstreamWorkspaceWrite('/project'));
  assert.deepEqual(workspace.writable, ['/project']);
  assert.deepEqual(workspace.command, ['/bin/sh', '-c', 'printf RUNNER_OK']);
  assert.throws(() => parseProfile(['not-a-flag']), /unexpected profile argument/);
  assert.throws(() => parseProfile(['--bind', '/only-one']), /needs two operands/);
  assert.throws(() => parseProfile(['--tmpfs']), /needs an operand/);
});

test('the Seatbelt profile keeps upstream grants and adds the PTY node', () => {
  const profile = seatbeltProfile(['/project']);
  assert.match(profile, /^\(version 1\) \(allow default\) \(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\* \(literal "\/dev\/null"\)\)/);
  assert.match(profile, /\(allow file-write\* \(literal "\/dev\/ptmx"\)\)/);
  assert.match(profile, /\(subpath "\/project"\)/);
  assert.match(seatbeltProfile([]), /literal "\/dev\/ptmx"/);
  assert(!/\(subpath/.test(seatbeltProfile([])));
});

test('writable roots mirror the provider plus the temp areas, deduplicated', () => {
  const roots = writableRoots({ writable: ['/project', '/project'] }, { temp: '/var/tmp' });
  assert.deepEqual(roots, ['/project', realpathSync('/tmp'), realpathSync('/var/tmp')]);
});

test('a configured runner applies the profile it built and passes the command through', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-runner-'));
  try {
    const shim = join(directory, 'fake-sandbox-exec');
    const recorded = join(directory, 'profile.txt');
    // A shim stands in for sandbox-exec: it records the profile and then execs the
    // command, so the apply path is exercised even on a host that cannot nest one.
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$2" > ${JSON.stringify(recorded)}\nshift 2\n[ "$1" = "--" ] && shift\nexec "$@"\n`);
    chmodSync(shim, 0o755);
    const applied = [];
    const outcome = await run(upstreamWorkspaceWrite(directory), { exec: shim, stderr: { write: line => applied.push(line) } });
    assert.equal(outcome, 0);
    assert.deepEqual(applied, []);
    const profile = readFileSync(recorded, 'utf8');
    assert.match(profile, /literal "\/dev\/ptmx"/);
    assert.match(profile, new RegExp(`subpath "${realpathSync(directory).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), profile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inside an existing profile the runner inherits instead of nesting a second one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-runner-nested-'));
  try {
    const applies = seatbeltApplies();
    const result = spawnSync(process.execPath, [RUNNER, ...upstreamWorkspaceWrite(directory)], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RUNNER_OK/);
    if (applies.ok) assert.equal(result.stderr, '', 'an unconfined host applies the profile and says nothing');
    else assert.match(result.stderr, /inheriting the enclosing profile/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the runner fails loudly and closed when it cannot confine', async () => {
  const lines = [];
  const stderr = { write: line => lines.push(line) };
  assert.equal(await run(['--ro-bind', '/', '/', '--'], { stderr }), 126);
  assert.match(lines.at(-1), new RegExp(`^${FAILURE_PREFIX}no command after --`));
  const missing = join(tmpdir(), 'dscode-runner-does-not-exist');
  assert.equal(await run(['--', '/bin/true'], { exec: missing, stderr }), 126);
  assert.match(lines.at(-1), /is not available; refusing to run unconfined/);
});
