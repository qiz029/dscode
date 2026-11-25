import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { patchShellUnicode } from '../scripts/patch-shell-unicode.mjs';
import { patchTerminalBash } from '../scripts/patch-runtime.mjs';

const source = readFileSync(new URL('../node_modules/@deepseek-ai/dsh-terminal-bash/lib/index.js', import.meta.url), 'utf8');
const patched = patchTerminalBash(source);
const environmentSource = patched.slice(patched.indexOf('function childEnvironment('), patched.indexOf('\n/**', patched.indexOf('function childEnvironment(')));
const childEnvironment = runInNewContext(environmentSource + '\nchildEnvironment', { CONTROLLED_PROMPT: 'dsh> ' });

test('given a pinned runtime, Unicode patch upgrades existing installs and rejects drift', () => {
  assert.equal(patchShellUnicode(patched), patched);
  assert.equal(patchTerminalBash(patched), patched);
  assert.throws(() => patchShellUnicode('unknown upstream'), /patch drift/i);
  const spec = { owner: { id: 'owner' }, sessionId: 'terminal' };
  assert.equal(childEnvironment(spec, 'pwsh').PROMPT_COMMAND, undefined);
  assert.match(childEnvironment(spec, 'bash').PROMPT_COMMAND, /convert-meta off/);
});

test('given C and UTF-8 locales, interactive Bash preserves Unicode arguments and paths', { skip: process.platform === 'win32' }, () => {
  const env = childEnvironment({ owner: { id: 'owner' }, sessionId: 'terminal' }, 'bash');
  const result = spawnSync('python3', ['-c', `
import os, pty, subprocess, select, time, tempfile
for locale in ['C', 'en_US.UTF-8']:
 with tempfile.TemporaryDirectory() as directory:
  master, slave = pty.openpty()
  env = dict(os.environ, **${JSON.stringify(env)}, LC_ALL=locale)
  process = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '+H', '-i'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=directory)
  os.close(slave)
  def until(marker):
   output = b''
   deadline = time.monotonic() + 5
   while marker not in output:
    assert time.monotonic() < deadline, repr(output)
    if select.select([master], [], [], 0.1)[0]:
     output += os.read(master, 65536)
   return output
  try:
   until(b'dsh> ')
   os.write(master, "printf '%s' '中文 café 日本語 😀' > '中文 😀.txt'\\n".encode())
   until(b'dsh> ')
   with open(os.path.join(directory, '中文 😀.txt'), encoding='utf-8') as file:
    assert file.read() == '中文 café 日本語 😀'
   os.write(master, b'false\\n')
   assert b'133;D;1' in until(b'dsh> '), 'prompt must preserve command exit status'
  finally:
   process.kill()
   process.wait()
   os.close(master)
`], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});
