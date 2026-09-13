import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeDoctorEvidence, collectDoctorEvidence, logRow, recordRuntimeLog, recentRuntimeLogs, summarizeTrace } from '../plugins/tui-tools/doctor.mjs';
import { doctorOverlay } from '../scripts/doctor-cli.mjs';

test('doctor summarizes stuck tools and failures without conversation or tool payloads', () => {
  const events = [
    { seq: 0, time: 1000, type: 'request/header', data: { header: { config: { provider: 'fixture', model: 'test' } } } },
    { seq: 1, time: 2000, type: 'user/message', data: { content: [{ type: 'text', text: 'PRIVATE_USER_TEXT' }] } },
    { seq: 2, time: 3000, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, time: 4000, type: 'tool/call', data: { callId: 'call-1', name: 'bash', arguments: 'PRIVATE_COMMAND' } },
    { seq: 4, time: 6000, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }] }, error: { name: 'TimeoutError', code: 'ETIMEDOUT' } } },
    { seq: 5, time: 7000, type: 'tool/call', data: { callId: 'call-2', name: 'mcp__chrome__take_snapshot', arguments: 'PRIVATE_ARGS' } },
  ];
  const summary = summarizeTrace({ id: 'session-a', createdAt: 1000, agentPreset: 'dscode' }, events, 70000);
  const value = JSON.stringify(summary);
  assert.match(value, /ETIMEDOUT/);
  assert.match(value, /no result/);
  assert(!value.includes('tool bash has no result'));
  for (const secret of ['PRIVATE_USER_TEXT', 'PRIVATE_COMMAND', 'PRIVATE_OUTPUT', 'PRIVATE_ARGS']) assert(!value.includes(secret));
  assert.deepEqual(summary.route, { provider: 'fixture', model: 'test' });
});

test('doctor persists only redacted warning/error records with owner permissions', () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-doctor-'));
  try {
    recordRuntimeLog(home, { ts: 1, type: 'info', name: 'fixture', args: ['ignored'] });
    recordRuntimeLog(home, { ts: 2, type: 'warn', name: 'fixture', args: ['api_key=sk-abcdefghijklmnop'] });
    const path = join(home, 'diagnostics/runtime.jsonl');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert(!readFileSync(path, 'utf8').includes('sk-abcdefghijklmnop'));
    assert.equal(recentRuntimeLogs(home).length, 1);
    assert.equal(logRow({ ts: 3, type: 'debug', name: 'fixture', args: [] }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('doctor collects current and recent persisted sessions and falls back when model is unavailable', async () => {
  const current = { id: 'current', header: { id: 'current', cwd: '/work', createdAt: 2000, agentPreset: 'dscode' }, snapshotEvents: () => [
    { seq: 0, time: 1000, type: 'tool/call', data: { callId: 'x', name: 'bash' } },
  ] };
  const older = { header: { id: 'older', cwd: '/work', createdAt: 1000, parentSession: 'current' } };
  const ctx = { sessionPersistence: {
    list: async () => [older],
    open: async () => ({ read: async () => ({ events: [{ seq: 0, time: 1000, type: 'assistant/attempt', data: {} }] }), close: async () => {} }),
  }, logger: { buffer: [] } };
  const evidence = await collectDoctorEvidence(ctx, { agent: { session: current }, cwd: '/work' });
  assert.deepEqual(evidence.traces.map(t => t.id), ['current', 'older']);
  assert.match(await analyzeDoctorEvidence(ctx, evidence, undefined), /没有可用的模型路由/);
  assert.match(doctorOverlay('/path/to/doctor-cli.mjs'), /dscode-doctor-cli/);
});
