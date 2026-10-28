// Acceptance for the shared Host (P2 in docs/runtime-client-design.md), using a
// temporary state directory and the deterministic fixture model:
//  1. two clients on one session: a protocol client delivers while a separate
//     terminal client is attached, and the terminal shows it live;
//  2. a terminal killed mid-turn leaves the turn running on the Host, and a new
//     terminal reattaches and interrupts it;
//  3. concurrent starts converge on one Host;
//  4. the Host exits once idle (no terminal, no running turn), not while a
//     terminal is attached;
//  5. one Host serving two folders gives each session the AGENTS.md above its
//     own project root (per-session discovery, not the Host's launch folder);
//  6. /reload makes a live session pick up an MCP server added to a config
//     overlay, an ancestor AGENTS.md and a skill in a new ancestor folder, all
//     created after the session started, and drops the server again.
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'dscode-host-'));
const workspace = join(home, 'workspace'); mkdirSync(workspace);
mkdirSync(join(workspace, '.codex'));
writeFileSync(join(workspace, '.codex/hooks.json'), JSON.stringify({ hooks: {
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'true' }] }],
} }));
const userHome = join(home, 'user'); mkdirSync(userHome);
const patch = join(home, 'host-fixture.patch.yml');
writeFileSync(patch, [
  '- id: agent-default-model\n  config:\n    provider: fixture\n    model: fixture',
  '- id: permission\n  config:\n    defaultPreset: workspace-write',
  '- id: dscode-session-cards\n  config:\n    enabled: false', '- id: dscode-memory\n  config:\n    generate: false',
  `- insert:\n    - id: fixture-model\n      name: ${JSON.stringify(join(root, 'scripts/fixture-model.mjs'))}`,
].join('\n') + '\n');
// harness.mjs resolves the state directory at import, so the environment comes first.
Object.assign(process.env, { DSCODE_SOURCE_HOME: home, DSCODE_HOST_PATCH: patch, HOME: userHome, CI: 'false', DSCODE_LANGUAGE: 'en',
  DSCODE_UPDATE_CHECK: 'off', DSCODE_ACCOUNT_LOGIN: '0', DSCODE_MEMORY_HOME: join(home, 'memories') });
const { ensureHost, hostStatus, stop } = await import('./host.mjs');
const { call, callDscode, openDscodeStream, openStream } = await import('../plugins/local-carrier/client.mjs');

const tick = ms => new Promise(r => setTimeout(r, ms));
const until = async (label, predicate, ms = 30000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await tick(100); }
  throw Error(`timed out waiting for ${label}${await diagnose()}`);
};
/** What a lifecycle failure leaves behind: the answering Host, this home's processes and the Host log. */
async function diagnose() {
  const status = await hostStatus(home, 2000).catch(() => undefined);
  const processes = spawnSync('ps', ['-axo', 'pid,ppid,etime,command'], { encoding: 'utf8' }).stdout.split('\n').filter(line => line.includes(home)).join('\n');
  let log = '';
  try { log = readFileSync(join(home, 'run', 'host.log'), 'utf8').split('\n').slice(-60).join('\n'); } catch { /* no log yet */ }
  return `\nHost status: ${JSON.stringify(status)}\nProcesses:\n${processes || '(none)'}\nHost log tail:\n${log || '(empty)'}`;
}
const value = result => { assert.equal(result?.ok, true, JSON.stringify(result)); return result.value; };

/** Start a separate terminal client with the probe; resolves its handle and output. */
function terminal(socketPath, scenario, args) {
  const child = spawn(process.execPath, [join(root, 'scripts/tui-client-probe.mjs'), ...args], {
    cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DSCODE_RUNTIME_SOCKET: socketPath, TUI_PROBE_SCENARIO: scenario },
  });
  const state = { output: '', code: undefined };
  child.stdout.on('data', b => { state.output += b; }); child.stderr.on('data', b => { state.output += b; });
  const exited = new Promise(resolve => child.once('exit', code => { state.code = code; resolve(code); }));
  return { child, state, exited };
}

const report = {};
async function sessionSnapshot(socket, sessionId) {
  const controller = new AbortController();
  const stream = openStream(socket, 'session/follow', { args: { request: { address: { kind: 'session', sessionId }, maxMessages: 1000 } } }, controller.signal);
  try { const first = await stream.next(); assert.equal(first.value.type, 'snapshot'); return first.value; }
  finally { controller.abort(); await stream.return(); }
}
try {
  const socket = await ensureHost();
  const first = await hostStatus();
  assert(first.pid > 0 && first.pid !== process.pid);

  // 1. Two clients on one session.
  const created = await Promise.all(Array.from({ length: 3 }, () => call(socket, 'session/create', { request: { sessionId: 'session-concurrent-create', cwd: workspace, agentPreset: 'dscode' } }).then(value)));
  assert.equal(new Set(created.map(item => item.sessionId)).size, 1);
  const { sessionId } = created[0];
  report.concurrentCreate = true;
  // Exercise a real prompt hook before the terminal scenario. Without the
  // workingDirectory service in the workspace adapter, this throws UNKNOWN
  // (reading 'ensure') despite the same Host working in hook-free projects.
  await callDscode(socket, 'session/deliver', { sessionId, content: [{ type: 'text', text: 'hello with a project hook' }], mode: 'followup' });
  const hooked = await until('prompt hook turn completed', async () => {
    const snapshot = await sessionSnapshot(socket, sessionId);
    return snapshot.records.some(record => record.event.type === 'turn/end') ? snapshot : undefined;
  });
  assert.deepEqual(hooked.records.find(record => record.event.type === 'turn/end').event.data.reason, { kind: 'completed' });
  assert(hooked.records.some(record => record.event.type === 'hook/result' && record.event.data.point === 'UserPromptSubmit' && record.event.data.exitCode === 0), 'the prompt hook must execute successfully');
  assert(hooked.records.some(record => record.event.type === 'assistant/message' && JSON.stringify(record.event).includes('Streaming through the fixture works.')), 'the hooked turn must produce the fixture reply');
  report.workspacePromptHook = true;
  const viewer = terminal(socket, 'attach', ['--resume', sessionId]);
  await until('terminal attached', () => viewer.state.output.includes('TUI_PROBE_READY') || viewer.state.code !== undefined);
  assert.equal(viewer.state.code, undefined, viewer.state.output.slice(-3000));
  await until('both clients attached', async () => (await hostStatus())?.clients >= 1);
  const delivery = { requestId: 'shared-host-delivery', sessionId, content: [{ type: 'text', text: 'from the second client' }], mode: 'followup' };
  await Promise.all(Array.from({ length: 3 }, () => callDscode(socket, 'session/deliver', delivery)));
  await assert.rejects(callDscode(socket, 'session/deliver', { ...delivery, mode: 'steer' }), error => error.code === 'dscode/idempotency-conflict');
  assert.equal(await viewer.exited, 0, viewer.state.output.slice(-3000));
  report.multiClient = true;

  // 1b. A terminal attaching later shows the session's own route.
  const { sessionId: routed } = value(await call(socket, 'session/create', { request: { cwd: workspace, agentPreset: 'dscode' } }));
  value(await call(socket, 'session/selectModel', { request: { sessionId: routed, provider: 'fixture', model: 'fixture-b' } }));
  await callDscode(socket, 'session/deliver', { sessionId: routed, content: [{ type: 'text', text: 'hello' }], mode: 'followup' });
  await until('routed turn done', async () => (await hostStatus())?.running === 0);
  const routedView = terminal(socket, 'model-resume', ['--resume', routed]);
  assert.equal(await routedView.exited, 0, routedView.state.output.slice(-3000));
  report.sessionRoute = true;

  // 2. A terminal killed mid-turn; the turn survives and a new terminal joins it.
  const crashing = terminal(socket, 'slow-crash', ['--resume', sessionId]);
  await until('slow turn running', () => crashing.state.output.includes('TUI_PROBE_SLOW_RUNNING') || crashing.state.code !== undefined);
  assert.equal(crashing.state.code, undefined, crashing.state.output.slice(-3000));
  crashing.child.kill('SIGKILL');
  await crashing.exited;
  assert.equal((await hostStatus()).running, 1, 'the turn keeps running after the terminal died');
  // Two-message pages force the reattaching terminal to page back through the whole log.
  process.env.DSCODE_HISTORY_PAGE = '2';
  const rejoin = terminal(socket, 'reattach', ['--resume', sessionId]);
  delete process.env.DSCODE_HISTORY_PAGE;
  assert.equal(await rejoin.exited, 0, rejoin.state.output.slice(-3000));
  await until('turn stopped on the Host', async () => (await hostStatus())?.running === 0);
  report.crashReattach = true;

  // 3. Concurrent starts converge on one Host.
  assert.equal(await stop(), true);
  const sockets = await Promise.all([ensureHost(), ensureHost(), ensureHost()]);
  assert.equal(new Set(sockets).size, 1);
  const pids = new Set((await Promise.all([hostStatus(), hostStatus()])).map(status => status.pid));
  assert.equal(pids.size, 1);
  report.singleHost = true;
  // Concurrent cold follows read the persisted log; the first writes share
  // Agent recovery. Delivery receipts survive the Host restart.
  const restored = await Promise.all([sessionSnapshot(sockets[0], sessionId), sessionSnapshot(sockets[0], sessionId)]);
  assert(restored.every(frame => frame.header.id === sessionId));
  await Promise.all(Array.from({ length: 3 }, () => callDscode(sockets[0], 'session/deliver', delivery)));
  const replayed = await sessionSnapshot(sockets[0], sessionId);
  assert.equal(replayed.records.filter(record => record.event.type === 'user/message' && record.event.data.content?.some(block => block.text === 'from the second client')).length, 1);
  report.concurrentResume = true;
  report.durableDeliveryRetry = true;

  // 4. Idle exit, but never while a terminal is attached.
  assert.equal(await stop(), true);
  process.env.DSCODE_HOST_IDLE_MS = '1500';
  const idleSocket = await ensureHost();
  const attached = new AbortController();
  void (async () => { for await (const _ of openStream(idleSocket, '$events', { args: {} }, attached.signal)) void _; })().catch(() => {});
  await tick(4000);
  assert((await hostStatus()) !== undefined, 'an attached terminal keeps the Host alive');
  attached.abort();
  await until('idle exit', async () => (await hostStatus(home, 500)) === undefined, 20000);
  report.idleExit = true;

  // 5. Per-session workspace instructions on one shared Host.
  delete process.env.DSCODE_HOST_IDLE_MS;
  const sharedSocket = await ensureHost();
  const instructionsIn = async marker => {
    // The rule sits ABOVE the project root, where only per-session discovery
    // (not the Host's launch folder) can find it.
    const area = join(userHome, `area-${marker}`), folder = join(area, 'project');
    mkdirSync(join(folder, '.git'), { recursive: true });
    writeFileSync(join(area, 'AGENTS.md'), `Ancestor rule: ${marker}\n`);
    const { sessionId: id } = value(await call(sharedSocket, 'session/create', { request: { cwd: folder, agentPreset: 'dscode' } }));
    const done = new AbortController(); let answer;
    const following = (async () => {
      for await (const frame of openStream(sharedSocket, 'session/follow', { args: { request: { address: { kind: 'session', sessionId: id } } } }, done.signal)) {
        const text = JSON.stringify(frame).match(/instructions:\[[A-Z_,]*\]/)?.[0];
        if (text && frame.type === 'event') { answer = text; done.abort(); }
      }
    })().catch(() => {});
    await callDscode(sharedSocket, 'session/deliver', { sessionId: id, content: [{ type: 'text', text: 'INSTRUCTIONS' }], mode: 'followup' });
    await until(`instructions answer in ${marker}`, () => answer);
    done.abort(); await following;
    return answer;
  };
  assert.equal(await instructionsIn('MARKER_ALPHA'), 'instructions:[MARKER_ALPHA]');
  assert.equal(await instructionsIn('MARKER_BETA'), 'instructions:[MARKER_BETA]');
  report.perSessionInstructions = true;

  // 6. /reload on a live session.
  const area = join(userHome, 'area-reload'), folder = join(area, 'project');
  mkdirSync(join(folder, '.git'), { recursive: true });
  const { sessionId: live } = value(await call(sharedSocket, 'session/create', { request: { cwd: folder, agentPreset: 'dscode' } }));
  const ask = async () => {
    const done = new AbortController(); let answer;
    const following = (async () => {
      for await (const frame of openStream(sharedSocket, 'session/follow', { args: { request: { address: { kind: 'session', sessionId: live } } } }, done.signal)) {
        const text = frame.type === 'event' ? JSON.stringify(frame).match(/instructions:\[[A-Z_,]*\]/)?.[0] : undefined;
        if (text) { answer = text; done.abort(); }
      }
    })().catch(() => {});
    await callDscode(sharedSocket, 'session/deliver', { sessionId: live, content: [{ type: 'text', text: 'INSTRUCTIONS' }], mode: 'followup' });
    await until('instructions answer', () => answer);
    done.abort(); await following;
    await until('turn finished', async () => (await hostStatus())?.running === 0);
    return answer;
  };
  const command = async line => {
    await callDscode(sharedSocket, 'commands/execute', { sessionId: live, line });
    const done = new AbortController();
    for await (const frame of openStream(sharedSocket, 'session/follow', { args: { request: { address: { kind: 'session', sessionId: live } } } }, done.signal)) {
      done.abort();
      return frame.records.map(record => record.event).filter(event => event.type === 'command/done').at(-1)?.data;
    }
  };
  const skillNames = async () => {
    const done = new AbortController();
    for await (const state of openDscodeStream(sharedSocket, 'skills/watch', { sessionId: live, cwd: folder }, done.signal)) { done.abort(); return state.rows.map(row => row.name); }
  };
  assert.equal(await ask(), 'instructions:[]');
  // Everything below appears after the session exists.
  writeFileSync(join(area, 'AGENTS.md'), 'Ancestor rule: MARKER_GAMMA\n');
  mkdirSync(join(area, '.agents', 'skills', 'reload-skill'), { recursive: true });
  writeFileSync(join(area, '.agents', 'skills', 'reload-skill', 'SKILL.md'), '---\nname: reload-skill\ndescription: added above the project after the session started\n---\nBody.\n');
  const fixturePatch = readFileSync(patch, 'utf8');
  appendFileSync(patch, `- insert:\n    - id: mcp-reload\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: reloadprobe\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(join(root, 'tests/fixtures/atomicmail-mcp.mjs'))}, ${JSON.stringify(join(home, 'mcp-started.log'))}]\n`);
  assert(!(await skillNames()).includes('reload-skill'), 'a new ancestor folder is not seen before /reload');
  const reloaded = await command('/reload');
  assert.equal(reloaded?.kind, 'success', JSON.stringify(reloaded));
  assert.match(reloaded.text, /MCP: added mcp-reload/);
  assert.match(reloaded.text, /mcp-reload: active, 3 tools/);
  assert((await skillNames()).includes('reload-skill'), 'the ancestor skill is visible after /reload');
  assert.match((await command('/mcp tools mcp-reload'))?.text ?? '', /mcp__reloadprobe__help/);
  assert.equal(await ask(), 'instructions:[MARKER_GAMMA]');
  writeFileSync(patch, fixturePatch);
  assert.match((await command('/reload'))?.text ?? '', /MCP: removed mcp-reload/);
  report.reload = true;

  console.log('HOST_VERIFIED ' + JSON.stringify(report));
} catch (error) {
  if (!String(error?.message).includes('Host status:')) console.error(`verify-host failed after ${JSON.stringify(report)}${await diagnose()}`);
  throw error;
} finally {
  await stop().catch(() => {});
  if (!process.env.KEEP) rmSync(home, { recursive: true, force: true });
}
