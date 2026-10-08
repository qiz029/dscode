import assert from 'node:assert/strict';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

export const inject = ['agentPresets', 'connection', 'webServer', 'agents', 'commands', 'tools'];
export function apply(ctx) {
  void run(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); });
}
async function run(ctx) {
  await ctx.get('loader').await();
  assert.equal(process.env.DSH_HOME, undefined, 'Qualification must include ordinary Desktop home resolution');
  assert.equal(resolveDshHome(), join(homedir(), '.dsh'));
  assert(ctx.get('dscodeEmail'), 'Email failed to activate');
  assert(ctx.get('dscodeTriggers'), 'Scheduling failed to activate');
  assert(existsSync(join(resolveDshHome(), 'config/hooks.local.json')), 'Workspace discovery failed to activate');
  const handle = await ctx.agents.create({ sessionId: 'registry-home-check', meta: { cwd: homedir(), agentPreset: 'dscode' },
    setup: async scope => { await ctx.agentPresets.mount(scope, 'dscode'); } });
  assert(ctx.commands.find(handle.agent, 'review-usage'), 'Automatic review failed to activate');
  const preset = await ctx.agentPresets.resolve('dscode');
  assert(preset); assert.equal(preset.broken, undefined, preset.broken);
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const response = await fetch(`${origin}/api/dscode-hub`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: 'registry-check', method: 'dscode-hub', payload: { action: 'status' } }) });
  assert.equal(response.status, 404, 'DSCODE must not expose the Hub endpoint');
  for (const name of ['plugin_hub_search', 'plugin_hub_info']) assert.equal(ctx.tools.get(name, scopeOf(handle.agent.ctx)), undefined, 'DSCODE must not register Hub tools');
  await handle.dispose();
  console.log('DESKTOP_REGISTRY_PASSED'); ctx.get('appExit')(0);
}
