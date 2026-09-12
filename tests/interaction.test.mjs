import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runShell } from '../plugins/tui-tools/shell.mjs';
import { commandPlan } from '../packages/launcher/manager.mjs';
import { patchInteraction } from '../scripts/patch-interaction.mjs';
import { patchTui } from '../scripts/patch-tui.mjs';

patchTui(new URL('..', import.meta.url).pathname);
const source = readFileSync(new URL('../node_modules/dsh-code/lib/index.mjs', import.meta.url), 'utf8');
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start) + 2;
  assert(start >= 0 && end > start);
  return source.slice(start, end);
}
test('Shift+Enter survives CSI-u and modifyOtherKeys normalization; Enter submits', () => {
  const context = vm.createContext({ KITTY_KEYPAD_CODES: {}, CSI_U_SOURCE: '\\x1B\\[(\\d+)(?:;(\\d+))?(?:(:|;)(\\d+))?u' });
  vm.runInContext(extract('legacyForKey') + '\n' + extract('normalizeKeyboardChunk'), context);
  assert.equal(context.normalizeKeyboardChunk('\x1b[13;2u'), '\n');
  assert.equal(context.normalizeKeyboardChunk('\x1b[27;2;13~'), '\n');
  assert.equal(context.normalizeKeyboardChunk('\x1b[13u'), '\r');
  // Exercise the actual composer branch, including insertion in the middle.
  const start = source.indexOf('if (input === "\\n" || key.ctrl');
  const end = source.indexOf('\n\t\tif (key.return)', start);
  let edited;
  const handler = vm.runInNewContext(`(input, key) => { ${source.slice(start, end)} return 'submit'; }`, { liveValue: 'ab', liveCursor: 1, insertText: (s, i, t) => s.slice(0, i) + t + s.slice(i), applyEdit: v => { edited = v; } });
  handler('\n', {}); assert.equal(edited, 'a\nb');
  assert.equal(handler('\r', { return: true }), 'submit');
});
test('chat hides reasoning and completed tools while retaining assistant text', () => {
  const context = vm.createContext({ transcriptEntryLines: entry => entry });
  vm.runInContext(extract('dscodeChatLines'), context);
  assert.equal(context.dscodeChatLines({ kind: 'tool', state: 'running' }, 80).length, 0);
  assert.equal(context.dscodeChatLines({ kind: 'tool', state: 'done' }, 80).length, 0);
  const entry = { kind: 'assistant', reasoning: 'private thinking', text: 'answer' };
  const result = context.dscodeChatLines(entry, 80);
  assert.equal(result.reasoning, ''); assert.equal(result.text, 'answer');
  assert.equal(entry.reasoning, 'private thinking');
  assert.equal(patchInteraction(source), source);
  assert.throws(() => patchInteraction('unknown upstream'), /drift/);
});
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
