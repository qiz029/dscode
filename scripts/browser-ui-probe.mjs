// Manual UI qualification fixture: all model responses and pages are local.
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { BrowserAccess } from '../plugins/browser/access.mjs';
import { BrowserPreview } from '../plugins/browser/preview.mjs';
export const inject = ['agents', 'llm', 'permissionPresets', 'webServer', 'connection', 'commands'];
export function apply(ctx) { void start(ctx).catch(error => {
  writeFileSync(join(process.env.DSH_HOME, 'browser-ui-failure.log'), error.stack ?? String(error));
  console.error(error); ctx.get('appExit')(1);
}); }
async function start(ctx) {
  await ctx.get('loader').await();
  for (const [method, flag, marker] of [
    ['capture', 'DSCODE_BROWSER_UI_HOLD_CAPTURE', 'capture'],
    ['annotate', 'DSCODE_BROWSER_UI_HOLD_ANNOTATION', 'annotation'],
  ]) {
    if (process.env[flag] !== '1') continue;
    const original = BrowserPreview.prototype[method];
    let held = false, disposed = false;
    BrowserPreview.prototype[method] = async function (...args) {
      const result = await original.apply(this, args);
      if (!held) {
        held = true;
        writeFileSync(join(process.env.DSH_HOME, `${marker}-held.json`), JSON.stringify({
          heldAt: Date.now(), pageId: result.pageId, url: result.url, capturedAt: result.capturedAt, sent: result.sent,
        }));
        const deadline = Date.now() + 120000;
        while (!disposed && !existsSync(join(process.env.DSH_HOME, `release-${marker}`)) && Date.now() < deadline) await delay(25);
        if (disposed || Date.now() >= deadline) throw Error(`Fixture ${marker} hold ended without release.`);
        writeFileSync(join(process.env.DSH_HOME, `${marker}-released.json`), JSON.stringify({ releasedAt: Date.now() }));
      }
      return result;
    };
    ctx.on('dispose', () => { disposed = true; BrowserPreview.prototype[method] = original; });
  }
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><html><head><title>Browser preview fixture</title></head><body style="margin:0;background:#f4f6fb;font:20px system-ui;color:#18243b"><main style="margin:70px auto;width:650px;background:white;padding:45px;border-radius:20px"><p style="color:#68748c">DSCODE · LOCAL FIXTURE</p><h1>Plan your next visit</h1><p>Select the orange button in the preview and ask the agent to adjust its label.</p><button style="margin-top:24px;background:#f97316;color:white;border:0;border-radius:10px;padding:16px 26px;font:inherit">Book a visit</button><p style="font-size:14px;color:#68748c;margin-top:40px">This page performs no external requests.</p></main></body></html>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  ctx.on('dispose', () => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const extension = process.env.DSCODE_BROWSER_UI_EXTENSION === '1';
  await new BrowserAccess(join(process.env.DSH_HOME, 'browser')).update('allow', url);
  let step = 0, pageId;
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'mcp__browser__new_page') pageId = result.value?.structuredContent?.pages.find(p => p.selected)?.id;
    if (extension && exec.name === 'browser_start') pageId = result.value?.pages?.[0]?.id;
  });
  ctx.on('approval/request', (req, next) => req.toolName === 'mcp__browser__new_page' ? Promise.resolve('allowed-once') : next(), { prepend: true });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const annotations = (options.messages ?? []).filter(message => message.role === 'user' && message.content.some(b => b.type === 'text' && b.text.startsWith('Browser annotation from the user')));
      if (annotations.length) writeFileSync(join(process.env.DSH_HOME, 'annotation-receipt.json'), JSON.stringify({ count: annotations.length, hasImage: annotations.at(-1).content.some(b => b.type === 'image'), text: annotations.at(-1).content.find(b => b.type === 'text').text }));
      const actions = extension ? [['browser_start', {}]] : [['browser_start', {}], ['mcp__browser__new_page', { url, background: true }], ['browser_tabs', { action: 'keep', pageId }]];
      const action = options.purpose ? undefined : actions[step++];
      const block = action ? { type: 'tool-call', id: `ui-${step}`, name: action[0], arguments: JSON.stringify(action[1]) } : { type: 'text', text: annotations.length ? 'Annotation received with the captured screenshot. The fixture does not change the page.' : 'The local page is ready. Open Browser preview from the right sidebar to inspect it and send an annotation.' };
      yield { type: 'block-start', index: 0, blockType: block.type }; yield { type: 'block-end', index: 0, block }; yield { type: 'finish', reason: { kind: action ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['browser-fixture'], new Adapter());
  const { agent } = await ctx.agents.create({ sessionId: 'browser-preview-ui', meta: { cwd: process.cwd() }, agentOptions: { provider: 'browser-fixture', model: 'fixture' }, setup: (scope, agent) => { installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined }); } });
  ctx.permissionPresets.set(agent.session, 'workspace-write');
  if (extension) {
    const signal = AbortSignal.timeout(30000);
    const paired = (await ctx.commands.execute(agent, '/browser pair --json', [], signal))?.result;
    if (paired?.kind !== 'success') throw Error(paired?.text ?? 'Extension pairing failed.');
    console.log('BROWSER_EXTENSION_PAIRING ' + JSON.stringify({ pairingUrl: JSON.parse(paired.text).pairingUrl, url }));
    let ready = false;
    for (let i = 0; i < 300 && !ready; i++) {
      await delay(100);
      // Poll the registered read-only handler without filling native command
      // history with fixture readiness checks. Pairing itself uses execute().
      const status = await ctx.commands.view(agent).get('browser').definition.handler({ agent, rawInput: 'status --json', signal });
      ready = status?.kind === 'success' && JSON.parse(status.text).extensionReady;
    }
    if (!ready) throw Error('The fixture extension did not share its page.');
  }
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Open the local preview fixture.' }] }));
  await agent.whenIdle();
  if (!Number.isSafeInteger(pageId)) throw Error('The fixture browser did not open its page. Inspect the tool failure before testing the UI.');
  console.log('BROWSER_UI_READY ' + JSON.stringify({ url: ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`), home: process.env.DSH_HOME, sessionId: agent.session.id, mode: extension ? 'extension' : 'isolated' }));
}
