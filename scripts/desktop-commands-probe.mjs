import assert from 'node:assert/strict';
import { inspectComposition } from '../plugins/tui-tools/composition.mjs';

export const inject = ['agents', 'agentPresets', 'commands'];
export function apply(ctx) {
  void run(ctx).catch(error => { console.error(error); ctx.get('appExit')(1); });
}

async function run(ctx) {
  await ctx.get('loader').await();
  const make = async preset => (await ctx.agents.create({
    sessionId: preset, meta: { cwd: process.cwd(), agentPreset: preset },
    agentOptions: { provider: 'unused-fixture', model: 'no-inference' },
    setup: async scope => { await ctx.agentPresets.mount(scope, preset); },
  })).agent;
  const agent = await make('commands-fixture');
  const other = await make('commands-other');
  assert.notEqual(agent.id, other.id);
  const inventory = inspectComposition(ctx, agent);
  const modern = inventory.inspections !== null;
  if (modern) {
    assert.deepEqual(inventory.inspections.map(preset => preset.id), ['commands-fixture']);
    assert.equal(inventory.inspections[0].modules.length, 1);
    assert.deepEqual(inventory.inspections[0].leakedServices, []);
  } else {
    assert(inventory.entries.some(entry => entry.options.id === 'fixture-one'));
    assert(!inventory.entries.some(entry => entry.options.id === 'fixture-other'));
  }
  const slash = async text => (await ctx.commands.execute(agent, text, [], new AbortController().signal)).result;
  const status = await slash('/status');
  assert.equal(status.kind, 'success', status.text);
  assert.match(status.text, /preset: commands-fixture/);
  if (modern) {
    assert.match(status.text, /Preset commands-fixture: 1 active modules/);
    assert.doesNotMatch(status.text, /commands-other/);
  }
  const mcp = await slash('/mcp');
  assert.equal(mcp.kind, 'success', mcp.text);
  const doctor = await slash('/doctor local');
  assert.equal(doctor.kind, 'success', doctor.text);
  assert.match(doctor.text, /Core tools:/);
  console.log('DESKTOP_COMMANDS_PASSED ' + JSON.stringify({ inventory: modern ? 'registry service' : 'legacy standing tree', status: true, mcp: true, doctor: true, liveModelInference: false }));
  ctx.get('appExit')(0);
}
