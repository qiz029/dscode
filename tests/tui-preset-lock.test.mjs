import test from 'node:test';
import assert from 'node:assert/strict';
import { requireDscodePreset, mountDscodePreset } from '../packages/tui/src/dscode/preset.ts';
import { resolvePreset } from '../packages/tui/src/presets.ts';
import { resolveTuiStartup } from '../packages/tui/src/startup.ts';
import { completionCandidates } from '../packages/tui/src/app.ts';

function session(header = { agentPreset: 'minimal' }, seed = []) {
  const events = [...seed];
  return { header, snapshotEvents: () => events, append: (type, data) => events.push({ type, data }) };
}

test('interactive startup and new-session mode requests only accept DSCODE', () => {
  assert.equal(requireDscodePreset(), 'dscode');
  assert.equal(requireDscodePreset('dscode'), 'dscode');
  for (const id of ['minimal', 'standard', 'code', 'ptc', 'custom', '']) {
    assert.throws(() => requireDscodePreset(id), /locked/);
    assert.throws(() => resolveTuiStartup({ mode: id }), /locked/);
  }
  assert.deepEqual(resolveTuiStartup({}), { kind: 'fresh' }, 'bare launch stays lazy');
  assert.deepEqual(resolveTuiStartup({ mode: 'dscode' }), { kind: 'fresh', mode: 'dscode' });
  assert.deepEqual(resolveTuiStartup({ resume: 'old' }), { kind: 'resume', sessionId: 'old' });
});

test('legacy history is retained while its effective preset is durably moved to DSCODE', async () => {
  const history = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { text: 'keep history' } }];
  const stored = session({ agentPreset: 'minimal' }, history), mounts = [];
  const service = { mount: async (_ctx, id) => { mounts.push(id); return { id }; } };
  await mountDscodePreset(service, {}, stored);
  assert.deepEqual(mounts, ['dscode']);
  assert.deepEqual(stored.snapshotEvents().slice(0, 2), history);
  assert.equal(stored.header.agentPreset, 'minimal', 'original header is not rewritten');
  assert.equal(resolvePreset(stored), 'dscode');
  await mountDscodePreset(service, {}, stored);
  assert.equal(stored.snapshotEvents().filter(e => e.type === 'agent-preset/selected').length, 1);
});

test('latest legacy selection is overridden, while failed composition never records a switch', async () => {
  const stored = session({ agentPreset: 'dscode' }, [{ type: 'agent-preset/selected', data: { agentPreset: 'standard' } }]);
  await assert.rejects(mountDscodePreset({ mount: async () => { throw new Error('missing dscode'); } }, {}, stored), /missing dscode/);
  assert.equal(resolvePreset(stored), 'standard');
  await mountDscodePreset({ mount: async () => ({ id: 'dscode' }) }, {}, stored);
  assert.equal(resolvePreset(stored), 'dscode');
  const fresh = session({ agentPreset: 'dscode' });
  await mountDscodePreset({ mount: async () => ({ id: 'dscode' }) }, {}, fresh);
  assert.deepEqual(fresh.snapshotEvents(), []);
});

test('slash completion hides mode even if a registry exposes it, and retains model controls', () => {
  const rows = completionCandidates('/mo', [{ name: 'mode', description: 'legacy preset picker' }], []);
  assert(!rows.some(row => row.label === '/mode'));
  assert(rows.some(row => row.label === '/model'));
  assert(completionCandidates('/eff', [], []).some(row => row.label === '/effort'));
});
