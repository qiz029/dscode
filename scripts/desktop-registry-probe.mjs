import assert from 'node:assert/strict';

export const inject = ['agentPresets', 'connection', 'webServer'];
export function apply(ctx) {
  void run(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const preset = await ctx.agentPresets.resolve('dscode');
  assert(preset); assert.equal(preset.broken, undefined, preset.broken);
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const response = await fetch(`${origin}/api/dscode-hub`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: 'registry-check', method: 'dscode-hub', payload: { action: 'status' } }) });
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  assert.equal(result.ok, true, result.error?.message);
  console.log('DESKTOP_REGISTRY_PASSED'); ctx.get('appExit')(0);
}
