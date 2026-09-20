import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from '../plugins/tui-tools/shell.mjs';
import { commandPlan } from '../packages/launcher/manager.mjs';

test('resume supports latest, exact IDs, and remaining launch options', () => {
  assert.deepEqual(commandPlan(['resume'], {}, true), { launch: ['--continue'], install: false });
  assert.deepEqual(commandPlan(['resume', 'abc', '--cwd', '/tmp'], {}, true).launch, ['--resume', 'abc', '--cwd', '/tmp']);
  assert.deepEqual(commandPlan(['resume', '--cwd', '/tmp'], {}, true).launch, ['--continue', '--cwd', '/tmp']);
});
test('shell executes in requested cwd, preserves syntax and reports failure', async () => {
  // A canonical directory on the platform under test: /private/tmp answers only on macOS.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dscode-shell-cwd-')));
  try {
    const result = await runShell('pwd; printf "%s" "a b"; printf error >&2; exit 7', { cwd: directory });
    assert.equal(result.kind, 'error'); assert.match(result.text, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); assert.match(result.text, /a b/); assert.match(result.text, /error/); assert.match(result.text, /Exit 7/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.equal((await runShell('printf ok')).kind, 'success');
  assert.equal((await runShell(' ')).kind, 'error');
});
test('shell cancellation, timeout and output bounds', async () => {
  const controller = new AbortController();
  const pending = runShell('sleep 30', { signal: controller.signal });
  controller.abort();
  assert.match((await pending).text, /cancelled/);
  assert.match((await runShell('sleep 30', { timeoutMs: 20 })).text, /timed out/);
  const large = await runShell('printf 123456789', { maxBytes: 4 });
  assert.match(large.text, /1234\n\[output truncated\]/);
});
