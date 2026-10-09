import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'dscode-acp-verify-'));
const fixture = join(home, 'fixture.yml');
writeFileSync(join(home, 'providers.yaml'), JSON.stringify({ version: 1, providers: [{ id: 'custom-acp', name: 'ACP fixture', baseURL: 'http://unused.invalid/v1', api: 'chat-completions', auth: 'none', models: [{ id: 'llama', contextWindow: 1000000, maxTokens: 4096 }] }] }));
writeFileSync(fixture, `- insert:\n    - id: acp-fixture\n      name: ${JSON.stringify(join(root, 'tests/fixtures/acp-runtime.mjs'))}\n- id: dscode-custom\n  config:\n    path: ${JSON.stringify(join(home, 'providers.yaml'))}\n`);
const launcher = process.env.DSCODE_ACP_VERIFY_LAUNCHER;
if (launcher) {
  assert(process.env.DSCODE_ACP_VERIFY_MODULES, 'Installed launcher verification requires its profile node_modules directory');
  const profile = join(home, 'profiles/dscode');
  mkdirSync(profile, { recursive: true });
  mkdirSync(join(home, '.hub/installations/dscode'), { recursive: true });
  writeFileSync(join(home, '.hub/installations/dscode/current.json'), '{}');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@toddzheng024/dscode-bundle'] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n');
  symlinkSync(resolve(process.env.DSCODE_ACP_VERIFY_MODULES), join(profile, 'node_modules'));
}
const child = spawn(process.execPath, [launcher ?? join(root, 'bin/dscode.mjs'), 'acp', '--model', 'custom-acp/llama', '--patch', fixture], {
  cwd: root, env: { ...process.env, DSCODE_HOME: home, DSCODE_ACP_HOME: home, DSCODE_ACCOUNT_LOGIN: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '', nextId = 0, protocolFailure;
const pending = new Map(), updates = [], approvals = [];
let approvalChoice = 'allow-once', cancelId;
child.stderr.on('data', chunk => {
  stderr += chunk;
  if (process.env.DSCODE_ACP_VERIFY_VERBOSE) process.stderr.write(chunk);
  if (cancelId && stderr.includes('ACP_WAIT_ABORT')) {
    send({ method: 'session/cancel', params: { sessionId: cancelId } });
    cancelId = undefined;
  }
});
const exited = new Promise(resolveExit => child.on('exit', code => resolveExit(code)));
const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { protocolFailure = line; child.kill('SIGTERM'); return; }
  if (process.env.DSCODE_ACP_VERIFY_VERBOSE) console.error('ACP received:', line);
  if (message.method === 'session/request_permission') {
    approvals.push(message.params);
    send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: approvalChoice } } });
  } else if (message.method) updates.push(message);
  else {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(Error(`${waiter.method}: ${JSON.stringify(message.error)}; ${stderr}`));
    else waiter?.resolve(message.result);
  }
});
const request = (method, params) => new Promise((resolveRequest, reject) => {
  const id = ++nextId;
  if (process.env.DSCODE_ACP_VERIFY_VERBOSE) console.error('ACP request:', method);
  pending.set(id, { resolve: resolveRequest, reject, method }); send({ id, method, params });
});
const timeout = setTimeout(() => {
  for (const waiter of pending.values()) waiter.reject(Error(`ACP timeout during ${waiter.method}: ${stderr}; non-protocol stdout: ${protocolFailure ?? 'none'}`));
  child.kill('SIGTERM');
}, 60000);
try {
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dscode-test', version: '1' } });
  assert.equal(initialized.protocolVersion, 1);
  const session = await request('session/new', { cwd: root, mcpServers: [] });
  assert(session.sessionId);
  const result = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'USE_TOOL then answer' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert(updates.some(m => m.params?.update?.sessionUpdate === 'tool_call'), JSON.stringify(updates));
  assert(updates.some(m => m.params?.update?.content?.text?.includes('fixture reply')), JSON.stringify(updates));
  assert.equal(approvals.length, 1, 'the ACP client must receive tool permission requests');
  approvalChoice = 'reject-once';
  const denied = await request('session/new', { cwd: root, mcpServers: [] });
  await request('session/prompt', { sessionId: denied.sessionId, prompt: [{ type: 'text', text: 'USE_TOOL' }] });
  assert.equal(approvals.length, 2);
  await request('session/close', { sessionId: denied.sessionId });
  const cancelSession = await request('session/new', { cwd: root, mcpServers: [] });
  cancelId = cancelSession.sessionId;
  const cancelled = await request('session/prompt', { sessionId: cancelSession.sessionId, prompt: [{ type: 'text', text: 'WAIT_ABORT' }] });
  assert.equal(cancelled.stopReason, 'cancelled');
  await request('session/close', { sessionId: cancelSession.sessionId });
  await request('session/close', { sessionId: session.sessionId });
  const listed = await request('session/list', {});
  assert(listed.sessions.some(s => s.sessionId === session.sessionId));
  await request('session/resume', { sessionId: session.sessionId, cwd: root, mcpServers: [] });
  await request('session/close', { sessionId: session.sessionId });
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  assert.equal(protocolFailure, undefined);
  console.log(`ACP_PROBE_PASSED: handshake, custom API, DSCODE tool call, allow/reject, cancellation, reply, list, resume, close and EOF; ${approvals.length} permission requests`);
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  rmSync(home, { recursive: true, force: true });
}
