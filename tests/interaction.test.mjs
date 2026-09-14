import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { runShell } from '../plugins/tui-tools/shell.mjs';
import { commandPlan } from '../packages/launcher/manager.mjs';
import { patchInteraction } from '../scripts/patch-interaction.mjs';
import { createTestRuntime } from '../scripts/test-runtime.mjs';

const fixture = createTestRuntime({ tui: true });
after(fixture.close);
const source = readFileSync(`${fixture.root}/node_modules/dsh-code/lib/index.mjs`, 'utf8');
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
test('chat hides reasoning and tools by default and shows them dimmed in verbose mode', () => {
  const text = line => line.segments.map(segment => segment.text).join('');
  const context = vm.createContext({
    transcriptEntryLines: entry => [{ segments: [{ text: 'body:' + entry.text + '|reasoning:' + entry.reasoning, style: 'plain' }] }],
    lineSegment: (text, style = 'plain') => ({ text, style }),
    hangingStyledLines: (segments, _w, firstPrefix, firstStyle) => [{ segments: [{ text: firstPrefix, style: firstStyle }, ...segments] }],
    hangingTextLines: (value, w, firstPrefix, firstStyle) => value.split('\n').flatMap(row => { const parts = []; for (let i = 0; i < Math.max(1, row.length); i += w) parts.push(row.slice(i, i + w)); return parts; }).map((part, i) => ({ segments: [{ text: (i === 0 ? firstPrefix : '  ') + part, style: firstStyle }] })),
    textLines: (value, _w, style) => [{ segments: [{ text: value, style }] }],
  });
  vm.runInContext(extract('dscodeChatLines') + '\n' + extract('dscodeThinkingLines'), context);
  assert.equal(context.dscodeChatLines({ kind: 'tool', state: 'running' }, 80).length, 0);
  assert.equal(context.dscodeChatLines({ kind: 'tool', state: 'done' }, 80).length, 0);
  const entry = { kind: 'assistant', reasoning: 'private thinking', text: 'answer' };
  assert.equal(text(context.dscodeChatLines(entry, 80)[0]), 'body:answer|reasoning:');
  assert.equal(context.dscodeChatLines({ kind: 'assistant', reasoning: 'only thoughts', text: '' }, 80).length, 0);
  assert.equal(entry.reasoning, 'private thinking');
  const tool = context.dscodeChatLines({ kind: 'tool', state: 'done', name: 'bash', preview: 'ls -la', summary: 'total 3\nsrc' }, 80, true);
  assert.deepEqual([...tool.map(text)], ['· Tool Call: bash ls -la', '  Output: total 3', '  src']);
  assert(tool[0].segments.every(segment => segment.style === 'dim'), 'tool call lines are dim');
  const failed = context.dscodeChatLines({ kind: 'tool', state: 'error', name: 'bash', preview: '', summary: 'exit 1' }, 80, true);
  assert.equal(text(failed[0]), '· Tool Call: bash · error');
  assert.equal(failed[1].segments[0].style, 'error');
  assert.equal(text(context.dscodeChatLines({ kind: 'tool', state: 'running', name: 'review', preview: '' }, 80, true)[0]), '· Tool Call: review · running');
  const verbose = context.dscodeChatLines(entry, 80, true);
  assert.deepEqual([...verbose.map(text)], ['· Thinking: private thinking', 'body:answer|reasoning:']);
  assert.equal(verbose[0].segments[0].style, 'dimItalic');
  assert.deepEqual([...context.dscodeChatLines({ kind: 'assistant', reasoning: 'only thoughts', text: '' }, 80, true).map(text)], ['· Thinking: only thoughts']);
  // 95 characters of collapsed thinking wrapped at 10 columns is 10 rows: eight stay, a fold marker follows, then the answer.
  const long = context.dscodeChatLines({ kind: 'assistant', reasoning: Array.from({ length: 12 }, (_, i) => 'line ' + i).join('\n'), text: 'x' }, 10, true);
  assert.equal(long.length, 8 + 1 + 1, 'thinking is capped at eight lines plus a fold marker');
  assert.match(text(long[8]), /… 2 more lines · Ctrl\+O/);
  assert(!text(long[1]).includes('\n'), 'thinking newlines collapse into one flowing paragraph');
  assert.equal(patchInteraction(source), source);
  assert(source.includes('label: "/verbose"') && source.includes('if (text === "/verbose")') && source.includes('notify(dscodeT(next ? "verbose.on" : "verbose.off"))'), 'verbose command, dispatch and localized toggle notice are wired');
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
