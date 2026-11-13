import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'dscode-acp-verify-'));
const fixture = join(home, 'fixture.yml');
const providers = ['custom-acp', 'custom-acp-keyed', 'custom-acp-missing'].map(id => ({
  id, name: id, baseURL: 'http://unused.invalid/v1', api: 'chat-completions', auth: id === 'custom-acp' ? 'none' : 'bearer',
  models: ['llama', 'llama-alt'].map(id => ({ id, contextWindow: 1000000, maxTokens: 4096 })),
}));
const saveProviders = () => writeFileSync(join(home, 'providers.yaml'), JSON.stringify({ version: 1, providers }));
saveProviders();
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
    if (message.error) waiter?.reject(Object.assign(Error(`${waiter.method}: ${JSON.stringify(message.error)}; ${stderr}`), { rpcError: message.error }));
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
const modelOptions = result => result.configOptions.find(option => option.id === 'model');
const verifyModels = result => {
  const model = modelOptions(result);
  assert(model.options.some(group => group.group === 'custom-acp' && group.options.length === 2));
  assert(model.options.some(group => group.group === 'custom-acp-keyed' && group.options.length === 2));
  assert(!model.options.some(group => group.group === 'custom-acp-missing'), 'unconfigured custom providers must not be advertised');
};
const waitFor = async (predicate, reason) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(reason + '\n' + stderr);
};
const titleUpdates = sessionId => updates.filter(m => m.params?.sessionId === sessionId && m.params?.update?.sessionUpdate === 'session_info_update').map(m => m.params.update.title);
try {
  const initialized = await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'dscode-test', version: '1' } });
  assert.equal(initialized.protocolVersion, 1);
  const session = await request('session/new', { cwd: root, mcpServers: [] });
  assert(session.sessionId);
  verifyModels(session);
  const hasStatusCommand = messages => messages.some(m => m.params?.sessionId === session.sessionId && m.params?.update?.sessionUpdate === 'available_commands_update' && m.params.update.availableCommands.some(c => c.name === 'status' && c.description));
  assert(hasStatusCommand(updates), 'new sessions advertise /status before the first user prompt');
  const verifyStatus = async model => {
    const start = updates.length;
    const calls = stderr.split('ACP_INFERENCE_CALL').length;
    const status = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: '/status' }] });
    assert.equal(status.stopReason, 'end_turn');
    const text = updates.slice(start).map(m => m.params?.update?.content?.text ?? '').join('');
    assert(text.includes('custom-acp') && text.includes(model), text);
    assert.match(text, /not supported|暂不支持/);
    assert.equal(stderr.split('ACP_INFERENCE_CALL').length, calls, '/status never calls the model');
    assert(!updates.slice(start).some(m => m.params?.update?.sessionUpdate === 'tool_call'));
  };
  await verifyStatus('llama');
  assert.equal(stderr.split('ACP_TITLE_CALL').length - 1, 0, '/status does not trigger automatic naming');
  assert.deepEqual(titleUpdates(session.sessionId), [], 'a session stays unnamed before ordinary user input');
  await request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: JSON.stringify(['custom-acp', 'llama-alt']) });
  await verifyStatus('llama-alt');
  await assert.rejects(request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: JSON.stringify(['custom-acp-missing', 'llama']) }), /unknown model/);
  verifyModels(await request('session/set_config_option', { sessionId: session.sessionId, configId: 'model', value: JSON.stringify(['custom-acp', 'llama']) }));
  const result = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'USE_TOOL then answer' }] });
  assert.equal(result.stopReason, 'end_turn');
  assert(updates.some(m => m.params?.update?.sessionUpdate === 'tool_call'), JSON.stringify(updates));
  assert(updates.some(m => m.params?.update?.content?.text?.includes('fixture reply')), JSON.stringify(updates));
  assert.equal(approvals.length, 1, 'the ACP client must receive tool permission requests');
  await waitFor(() => titleUpdates(session.sessionId).includes('ACP fixture session'), 'the generated title must reach the ACP client');
  assert(titleUpdates(session.sessionId).includes('USE_TOOL then answer'), 'the deterministic fallback is also published');
  assert.equal(stderr.split('ACP_TITLE_CALL').length - 1, 1, 'the first ordinary message generates one title');
  await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Follow up without renaming' }] });
  assert.equal(stderr.split('ACP_TITLE_CALL').length - 1, 1, 'later messages retain the generated title without another title request');
  approvalChoice = 'reject-once';
  const denied = await request('session/new', { cwd: root, mcpServers: [] });
  await request('session/prompt', { sessionId: denied.sessionId, prompt: [{ type: 'text', text: 'USE_TOOL' }] });
  assert.equal(approvals.length, 2);
  await request('session/close', { sessionId: denied.sessionId });
  const cancelSession = await request('session/new', { cwd: root, mcpServers: [] });
  cancelId = cancelSession.sessionId;
  const cancelled = await request('session/prompt', { sessionId: cancelSession.sessionId, prompt: [{ type: 'text', text: 'WAIT_ABORT' }] });
  assert.equal(cancelled.stopReason, 'cancelled');
  assert(!updates.some(m => m.params?.sessionId === cancelSession.sessionId && m.params?.update?._meta?.['dscode.dev/status'] === 'error'), 'cancellation must not be presented as a failure');
  await request('session/close', { sessionId: cancelSession.sessionId });
  approvalChoice = 'allow-once';
  const failed = await request('session/new', { cwd: root, mcpServers: [] });
  await assert.rejects(request('session/prompt', { sessionId: failed.sessionId, prompt: [{ type: 'text', text: 'USE_TOOL FAIL_AFTER_TOOL' }] }), error => {
    assert.equal(error.rpcError?.code, -32603);
    assert.equal(error.rpcError?.data?.code, 'TRANSPORT');
    assert.equal(error.rpcError?.data?.sessionId, failed.sessionId);
    assert.match(error.rpcError?.data?.message, /retry/i);
    assert.doesNotMatch(JSON.stringify(error.rpcError), /fake-token/);
    const notices = updates.filter(m => m.params?.sessionId === failed.sessionId && m.params?.update?._meta?.['dscode.dev/status'] === 'error');
    assert.equal(notices.length, 1, 'one visible failure notice must arrive before the prompt error response');
    assert.match(notices[0].params.update.content.text, /DSCODE — Request failed \(TRANSPORT\)/);
    return true;
  });
  await request('session/close', { sessionId: failed.sessionId });
  const fallback = await request('session/new', { cwd: root, mcpServers: [] });
  const beforeTitleFailure = stderr.length;
  const fallbackTitle = 'TITLE_FAIL Keep fallback title';
  assert.equal((await request('session/prompt', { sessionId: fallback.sessionId, prompt: [{ type: 'text', text: fallbackTitle }] })).stopReason, 'end_turn');
  await waitFor(() => stderr.slice(beforeTitleFailure).includes('ACP_TITLE_EMPTY'), 'the fixture must exercise an empty title response');
  assert.deepEqual(titleUpdates(fallback.sessionId), [fallbackTitle], 'title failure preserves the deterministic fallback');
  assert(!updates.some(m => m.params?.sessionId === fallback.sessionId && m.params?.update?._meta?.['dscode.dev/status'] === 'error'), 'auxiliary title failure does not fail the model turn');
  await request('session/close', { sessionId: fallback.sessionId });
  await request('session/close', { sessionId: session.sessionId });
  const listed = await request('session/list', {});
  assert.equal(listed.sessions.find(s => s.sessionId === session.sessionId)?.title, 'ACP fixture session', 'listing returns the persisted model-generated title');
  assert.equal(listed.sessions.find(s => s.sessionId === fallback.sessionId)?.title, fallbackTitle, 'listing returns the fallback when model naming fails');
  const beforeResume = updates.length;
  verifyModels(await request('session/resume', { sessionId: session.sessionId, cwd: root, mcpServers: [] }));
  assert(hasStatusCommand(updates.slice(beforeResume)), 'resumed sessions advertise /status again before the next user prompt');
  assert(updates.slice(beforeResume).some(m => m.params?.sessionId === session.sessionId && m.params?.update?.title === 'ACP fixture session'), 'resuming publishes the saved title without generating another');
  const titleCallsBeforeResumeStatus = stderr.split('ACP_TITLE_CALL').length;
  await verifyStatus('llama');
  assert.equal(stderr.split('ACP_TITLE_CALL').length, titleCallsBeforeResumeStatus);
  const updateCount = updates.length;
  providers[0].auth = 'bearer';
  saveProviders();
  // The custom provider watcher emits a native ACP config update. Retain only
  // the current model when this route loses its configured authentication.
  const deadline = Date.now() + 10000;
  let changed;
  while (Date.now() < deadline && !changed) {
    changed = updates.slice(updateCount).find(message => {
      const update = message.params?.update;
      return update?.sessionUpdate === 'config_option_update'
        && modelOptions(update).options.find(group => group.group === 'custom-acp')?.options.length === 1;
    });
    if (!changed) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(changed, 'provider changes must refresh ACP options while retaining the current model');
  assert.equal(modelOptions(changed.params.update).currentValue, JSON.stringify(['custom-acp', 'llama']));
  await request('session/close', { sessionId: session.sessionId });
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  assert.equal(protocolFailure, undefined);
  console.log(`ACP_PROBE_PASSED: automatic titles, fallback, title updates/list/resume; /status discovery and execution without inference before/after model switch and resume; configured model filtering, selection, current-model retention, handshake, custom API, DSCODE tool call, allow/reject, cancellation, failure notice and error response, reply, close and EOF; ${approvals.length} permission requests`);
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill('SIGTERM');
  await exited;
  rmSync(home, { recursive: true, force: true });
}
