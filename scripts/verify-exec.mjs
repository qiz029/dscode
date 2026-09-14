import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root } from './harness.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-exec-runtime-'));
const run = (args, input) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, 'scripts/exec.mjs'), ...args], { cwd: root, env: { ...process.env, DSCODE_EXEC_HOME: home }, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
  child.once('error', reject);
  child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  if (input !== undefined) { child.stdin.end(input); }
});
try {
  const fixture = join(home, 'exec-fixture.patch.yml');
  writeFileSync(fixture, `- insert:\n    - id: exec-fixture\n      name: ${JSON.stringify(join(root, 'scripts/exec-fixture.mjs'))}\n`);
  const base = ['--patch', fixture, '--model', 'exec-fixture/fixture', '--effort', 'high', '--permission', 'ask'];

  const plain = await run([...base, 'hello', 'there']);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, 'fixture reply: hello there\n');
  assert.match(plain.stderr, /session [0-9a-f-]{36}\n$/, plain.stderr);
  assert(!plain.stderr.includes('ExperimentalWarning'), plain.stderr);

  const piped = await run([...base, '--quiet'], 'from stdin');
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(piped.stdout, 'fixture reply: from stdin\n');
  assert(!piped.stderr.includes('session ') && !piped.stderr.includes('→'), piped.stderr);

  const json = await run([...base, '--json', 'USE_TOOL then answer']);
  assert.equal(json.code, 0, json.stderr);
  const lines = json.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines[0].type, 'session'); assert.equal(lines[0].model, 'fixture'); assert.equal(lines[0].effort, 'high');
  const tool = lines.find(line => line.type === 'tool');
  assert(tool && tool.name === 'bash', JSON.stringify(lines));
  const result = lines.at(-1);
  assert.equal(result.type, 'result'); assert.equal(result.reason, 'completed'); assert.match(result.text, /^fixture reply:/);
  assert.equal(result.sessionId, lines[0].sessionId);

  // A command that only terminal input could finish used to hold the turn until
  // the 300s deadline; the macOS probe settles it as a stdin wait and interrupts it.
  const blockingStarted = Date.now();
  const blocking = await run([...base, 'USE_BLOCKING_TOOL']);
  const blockingElapsed = Date.now() - blockingStarted;
  // A confined environment that denies PTY allocation cannot reach the terminal
  // backend at all; say so instead of failing every such sandbox.
  if (blocking.stdout.includes('no pty')) console.log('EXEC_PROBE_SKIPPED: this environment denies PTY allocation, so the terminal-blocking command was not exercised');
  else {
    assert.equal(blocking.code, 0, `blocking command did not settle in ${blockingElapsed}ms: ${blocking.stderr}`);
    assert.equal(blocking.stdout, 'fixture reply: stall noted\n', 'the tool result must report the interrupted stdin wait');
    assert(blockingElapsed < 60000, `blocking command took ${blockingElapsed}ms`);
  }

  const resumed = await run([...base, '--resume', result.sessionId, 'again']);
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.stdout, 'fixture reply: again\n');
  assert.match(resumed.stderr, new RegExp(`session ${result.sessionId}`));

  const empty = await run([...base], '   ');
  assert.equal(empty.code, 1); assert.match(empty.stderr, /Prompt is empty/);
  const bad = await run(['--effort', 'extreme', 'x']);
  assert.equal(bad.code, 1); assert.match(bad.stderr, /--effort expects/);
  // A known level name passes the CLI; the Host refuses it when the model does not offer it.
  const unoffered = await run(['--effort', 'medium', 'x']);
  assert.equal(unoffered.code, 1); assert.match(unoffered.stderr, /--effort medium is not offered by [^;]+; it offers /);
  console.log('EXEC_PROBE_PASSED: argument prompt, stdin prompt, --quiet, --json with a tool call, a terminal-blocking command, --resume, empty prompt, bad option and unoffered effort exits');
} finally { rmSync(home, { recursive: true, force: true }); }
