import test from 'node:test';
import assert from 'node:assert/strict';
import { runShell } from '../plugins/tui-tools/shell.mjs';
import { commandPlan } from '../packages/launcher/manager.mjs';

test('resume supports latest, exact IDs, and remaining launch options', () => {
  assert.deepEqual(commandPlan(['resume'], {}, true), { launch: ['--continue'], install: false });
  assert.deepEqual(commandPlan(['resume', 'abc', '--cwd', '/tmp'], {}, true).launch, ['--resume', 'abc', '--cwd', '/tmp']);
  assert.deepEqual(commandPlan(['resume', '--cwd', '/tmp'], {}, true).launch, ['--continue', '--cwd', '/tmp']);
});
test('shell executes in requested cwd, preserves syntax and reports failure', async () => {
  const result = await runShell('pwd; printf "%s" "a b"; printf error >&2; exit 7', { cwd: '/private/tmp' });
  assert.equal(result.kind, 'error'); assert.match(result.text, /\/private\/tmp/); assert.match(result.text, /a b/); assert.match(result.text, /error/); assert.match(result.text, /Exit 7/);
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
