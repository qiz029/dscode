import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parseExecArgs, execOverlay, readStream, USAGE } from '../scripts/exec.mjs';
import { exitCodeFor, toolPreview, messageText } from '../plugins/exec/index.mjs';

test('exec arguments: prompt words, options, stdin marker and errors', async () => {
  const parsed = parseExecArgs(['--cwd', '/tmp', '--model', 'deepseek-official/deepseek-chat', '--effort', 'ultra', '--permission', 'auto', '--approve-all', '--resume', 'abc', '--json', '--quiet', '--timeout', '2.5', '--patch', 'a.yml', '--patch', 'b.yml', 'fix', 'the', 'bug']);
  assert.deepEqual(parsed, { prompt: 'fix the bug', cwd: '/tmp', model: 'deepseek-official/deepseek-chat', effort: 'ultra', permission: 'auto', approveAll: true, resume: 'abc', json: true, quiet: true, timeoutMs: 2500, patches: ['a.yml', 'b.yml'], help: false });
  assert.equal(parseExecArgs(['-']).prompt, '-');
  assert.equal(parseExecArgs([]).prompt, '');
  assert.equal(parseExecArgs(['--', '--not-an-option']).prompt, '--not-an-option');
  assert.equal(parseExecArgs(['--help']).help, true);
  assert.throws(() => parseExecArgs(['--effort', 'medium']), /low, high, max or ultra/);
  assert.throws(() => parseExecArgs(['--model', 'nomodel']), /provider\/model/);
  assert.throws(() => parseExecArgs(['--timeout', '0']), /positive/);
  assert.throws(() => parseExecArgs(['--cwd']), /requires a value/);
  assert.throws(() => parseExecArgs(['--bogus']), /Unknown option/);
  assert.match(USAGE, /dscode exec/);
  const stream = new PassThrough(); stream.end('piped prompt');
  assert.equal(await readStream(stream), 'piped prompt');
});

test('exec overlay disables the TUI rows and session cards, then inserts the exec plugin', () => {
  const overlay = execOverlay('/x/plugins/exec/index.mjs');
  assert.match(overlay, /- id: tui-startup\n  disabled: true/);
  assert.match(overlay, /- id: tui-runner\n  disabled: true/);
  assert.match(overlay, /- id: dscode-session-cards\n  config:\n    enabled: false/);
  assert.match(overlay, /- insert:\n    - id: dscode-exec\n      name: "\/x\/plugins\/exec\/index.mjs"/);
});

test('exec exit codes, tool previews and message text', () => {
  assert.equal(exitCodeFor(undefined), 0);
  assert.equal(exitCodeFor({ kind: 'completed' }), 0);
  assert.equal(exitCodeFor({ kind: 'error', error: { code: 'X', message: 'y' } }), 1);
  assert.equal(exitCodeFor({ kind: 'max-tokens' }), 2);
  assert.equal(exitCodeFor({ kind: 'aborted', reason: { kind: 'user' } }), 130);
  assert.equal(exitCodeFor({ kind: 'blocked' }), 3);
  assert.equal(toolPreview('bash', JSON.stringify({ command: 'ls  -la', description: 'list files' })), '→ bash list files');
  assert.equal(toolPreview('bash', JSON.stringify({ command: 'x'.repeat(200) })), '→ bash ' + 'x'.repeat(119) + '…');
  assert.equal(toolPreview('review', 'not json'), '→ review');
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'tool-call' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(messageText(undefined), '');
});
