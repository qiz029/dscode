import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

/** Packed full preset + real Chrome + preview RPC + production custom adapter. */
export async function verifyDesktopBrowser(ctx, { interactive = false, reload = false } = {}) {
  const largeImageFixture = interactive && process.env.DSCODE_BROWSER_UI_LARGE_IMAGE === '1';
  let pageId, failure, requests = 0, annotationImage;
  let interactiveReady = false, navigationServer, navigationUrl;
  const service = ctx.get('dscodeCustom'), results = [];
  const key = `fixture-${randomUUID()}`, id = 'custom-desktop-browser', model = 'desktop-browser-vision';
  let pageRequests = 0, frameRequests = 0;
  const revisionFile = join(resolveDshHome(), 'browser-fixture-revision');
  const fragmentFile = join(resolveDshHome(), 'browser-fixture-fragment');
  const revision = () => existsSync(revisionFile) ? readFileSync(revisionFile, 'utf8').trim() : 'initial';
  const frameReceipt = loadedRevision => writeFileSync(join(resolveDshHome(), 'frame-document-receipt.json'),
    JSON.stringify({ pageRequests, frameRequests, loadedRevision }));
  const server = createServer(async (req, res) => {
    if (interactive && req.url === '/fixture-state') {
      res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ revision: revision(), fragment: existsSync(fragmentFile) ? readFileSync(fragmentFile, 'utf8').trim() : '' })); return;
    }
    if (interactive && req.url?.startsWith('/frame-ready?')) {
      frameReceipt(new URL(req.url, 'http://localhost').searchParams.get('revision'));
      res.writeHead(204); res.end(); return;
    }
    if (interactive && req.url === '/frame') {
      frameRequests++;
      const current = revision();
      res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store');
      res.end(`<html><body style="font:20px system-ui;background:#fff4e5;padding:20px"><h2>Embedded editor</h2>
        <p>Document revision: ${current}</p><button style="background:orange;padding:24px">Inspect this button</button>
        <script>fetch('/frame-ready?revision='+encodeURIComponent(${JSON.stringify(current)}));</script></body></html>`);
      return;
    }
    if (req.url === '/page') {
      pageRequests++;
      res.setHeader('content-type', 'text/html');
      res.end(largeImageFixture ? `<!doctype html><title>Large screenshot fixture</title>
        <style>body{margin:0}canvas{display:block}section{position:absolute;top:24px;left:24px;background:white;padding:24px;font:18px system-ui}</style>
        <canvas></canvas><section><h1>Large screenshot fixture</h1><p>Detailed pixels must reach the preview and annotation.</p><button style="background:orange;padding:24px">Inspect this button</button></section>
        <script>function draw(){const canvas=document.querySelector('canvas');canvas.width=innerWidth;canvas.height=innerHeight;
        const ctx=canvas.getContext('2d'),image=ctx.createImageData(canvas.width,canvas.height);let seed=123456789;
        for(let i=0;i<image.data.length;i+=4){for(let j=0;j<3;j++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;image.data[i+j]=seed>>>24;}image.data[i+3]=255;}
        ctx.putImageData(image,0,0);}draw();addEventListener('resize',draw);</script>` : interactive ? `<!doctype html><title>Combined Desktop fixture</title><h1>Browser and models together</h1>
        <iframe id="editor" title="Cross-site editor" style="width:680px;height:300px;border:1px solid #888" src="http://localhost:${server.address().port}/frame"></iframe>
        <script>let revision=${JSON.stringify(revision())}; setInterval(async()=>{
          const state=await fetch('/fixture-state').then(r=>r.json());
          if(state.fragment && location.hash!==state.fragment) location.hash=state.fragment;
          if(state.revision!==revision){revision=state.revision;const frame=document.querySelector('#editor');frame.src=frame.src;}
        },250);</script>` : '<!doctype html><title>Combined Desktop fixture</title><h1>Browser and models together</h1><button style="background:orange;padding:24px">Inspect this button</button>');
      return;
    }
    if (req.method === 'GET') { res.writeHead(204); res.end(); return; }
    try {
      assert.equal(req.url, '/v1/chat/completions');
      assert(req.headers.authorization === `Bearer ${key}`);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, model);
      const latestUser = body.messages.findLast(message => message.role === 'user');
      const annotation = Array.isArray(latestUser?.content) && latestUser.content.some(part =>
        part.type === 'text' && part.text.startsWith('Browser annotation from the user')) ? latestUser : undefined;
      // Full presets may request auxiliary summaries without exposing tools.
      // They do not advance the scripted browser turn or its request count.
      if (!body.tools?.length && !annotation) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Desktop fixture auxiliary response.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      requests++;
      let action;
      if (annotation) {
        const image = annotation.content.find(part => part.type === 'image_url');
        assert(image, 'Annotation pixels must reach the custom HTTP endpoint');
        annotationImage = Buffer.from(image.image_url.url.split(',')[1], 'base64');
        assert(annotationImage.length > 100);
        if (interactive) {
          const admitted = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
            && event.data.content.some(block => block.text?.startsWith('Browser annotation from the user')));
          const ref = admitted.at(-1).data.content.find(block => block.type === 'image').attachment;
          const expected = await ctx.attachments.readImageRequest(ref, { ...requestImageDimensions(ref.width, ref.height, 2048 * 2048), maxBytes: 1024 * 1024 });
          assert.deepEqual(annotationImage, Buffer.from(expected.data));
          writeFileSync(join(resolveDshHome(), 'annotation-receipt.json'), JSON.stringify({ count: admitted.length,
            hasImage: true, exactImageBytes: true, customHttpTransport: true, fullPreset: 'dscode', largeImageFixture, text: annotation.content.find(part => part.type === 'text').text }));
        }
      } else {
        action = [
          ['browser_start', {}],
          ['mcp__browser__new_page', { url: `http://127.0.0.1:${server.address().port}/page`, background: true }],
          ...(largeImageFixture ? [['mcp__browser__resize_page', { pageId, width: 2000, height: 1500 }]] : []),
          ['mcp__browser__take_screenshot', { pageId, format: 'png' }],
          ['browser_tabs', { action: 'keep', pageId }],
        ][requests - 1];
        if (navigationUrl && requests === 6) action = ['mcp__browser__navigate_page', { pageId, url: navigationUrl }];
        if (requests === (largeImageFixture ? 5 : 4)) assert(body.messages.some(message => Array.isArray(message.content)
          && message.content.some(part => part.type === 'image_url')), 'Tool screenshot must reach the custom endpoint: ' + JSON.stringify(body.messages.filter(message => message.role === 'tool').map(message => ({ role: message.role, content: typeof message.content === 'string' ? message.content.slice(0, 1500) : '[non-text content]' }))));
        if (action) assert(body.tools.some(tool => tool.function.name === action[0]),
          `Missing ${action[0]}; preceding tool results: ${JSON.stringify(results)}`);
      }
      const delta = action ? { tool_calls: [{ index: 0, id: `desktop-browser-${requests}`, function: { name: action[0], arguments: JSON.stringify(action[1]) } }] }
        : { content: annotation ? 'DESKTOP_ANNOTATION_OK' : 'DESKTOP_BROWSER_READY' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: action ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      failure ??= error;
      if (interactive) writeFileSync(join(resolveDshHome(), 'browser-ui-failure.log'), error.stack ?? String(error));
      res.writeHead(500); res.end('Fixture request failed');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let handle, scopeHandle;
  const disposers = [
    ctx.on('approval/request', (request, next) => request.agent?.session.id === 'desktop-browser-combined'
      && (request.toolName === 'browser_stop' || request.toolName?.startsWith('mcp__browser__')) ? Promise.resolve('allowed-once') : next(), { prepend: true }),
    ctx.on('tools/result', (exec, result) => {
      if (exec.agent?.session.id !== 'desktop-browser-combined') return;
      results.push({ name: exec.name, result });
      if (exec.name === 'mcp__browser__new_page') pageId = result.value?.structuredContent?.pages.find(page => page.selected)?.id;
    }),
  ];
  const cleanup = async () => {
    await handle?.dispose();
    await scopeHandle?.dispose();
    for (const dispose of disposers) dispose();
    await service.remove(id, (await service.list()).revision);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (navigationServer) { navigationServer.closeAllConnections(); await new Promise(resolve => navigationServer.close(resolve)); }
  };
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await service.save({ id, name: 'Combined Desktop fixture', api: 'chat-completions', auth: 'bearer', baseURL: `${origin}/v1`,
      models: [{ id: model, contextWindow: 100000, inputModalities: ['text', 'image'] }],
    }, key, (await service.list()).revision);
    const setup = async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'dscode');
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
    };
    handle = reload
      ? await ctx.agents.resume({ resumeSessionId: 'desktop-browser-combined', setup })
      : await ctx.agents.create({ sessionId: 'desktop-browser-combined', meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: id, model }, setup });
    const agent = handle.agent;
    const browserCommand = ctx.commands.list(agent).find(command => command.name === 'browser');
    assert(browserCommand?.input?.hint, 'Desktop must admit browser command arguments instead of sending them to the model');
    assert.notEqual(browserCommand.input.attachments, true, 'Browser control commands do not accept attachments');
    const command = async input => {
      const { result } = await ctx.commands.execute(agent, input, [], AbortSignal.timeout(15000));
      assert.equal(result.kind, 'success', result.text);
      return result;
    };
    const permissionReceipt = join(resolveDshHome(), 'desktop-browser-permissions.json');
    if (reload) {
      assert(agent.session.snapshotEvents().some(event => event.type === 'assistant/message'
        && event.data.message.content.some(block => block.text === 'DESKTOP_ANNOTATION_OK')), 'Resume lost the previous browser conversation');
      assert(!ctx.tools.schemas(agent).some(tool => tool.name.startsWith('mcp__browser__')), 'Resume must not inherit a previous live browser connection');
      const previous = JSON.parse(readFileSync(permissionReceipt, 'utf8'));
      const permissions = JSON.parse((await command('/browser permissions --json')).text).permissions;
      assert.equal(permissions.sites[previous.allowed].access, 'allow');
      assert.equal(permissions.sites[previous.blocked].access, 'block');
    }
    ctx.permissionPresets.set(agent.session, 'workspace-write');
    await command(`/browser site allow ${origin}`);
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Open the local fixture and capture its page.' }] }));
    await agent.whenIdle();
    if (failure) throw failure;
    assert.deepEqual(results.map(row => row.name), ['browser_start', 'mcp__browser__new_page', ...(largeImageFixture ? ['mcp__browser__resize_page'] : []), 'mcp__browser__take_screenshot', 'browser_tabs']);
    assert(results.every(row => !row.result.isError), JSON.stringify(results.filter(row => row.result.isError)));
    assert.equal(requests, largeImageFixture ? 6 : 5);
    if (interactive) {
      const browserInitiallyStopped = process.env.DSCODE_BROWSER_UI_START_STOPPED === '1';
      if (browserInitiallyStopped) await command('/browser stop');
      const browserInitiallyHandedOff = process.env.DSCODE_BROWSER_UI_HANDOFF === '1';
      if (browserInitiallyHandedOff) await command(`/browser handoff ${pageId}`);
      ctx.on('dispose', cleanup);
      interactiveReady = true;
      return { sessionId: agent.session.id, model, pageId, customBrowserScreenshot: true, browserInitiallyStopped, browserInitiallyHandedOff, browserCommandInput: true };
    }
    if (reload) scopeHandle = await ctx.agents.create({ sessionId: 'desktop-browser-reload-unconnected',
      meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: id, model }, setup });
    const other = reload ? scopeHandle.agent : ctx.agents.get('desktop-preset-parent');
    assert(other && !ctx.tools.schemas(other).some(tool => tool.name.startsWith('mcp__browser__')), 'Browser tools leaked to another full-preset Agent');
    const host = `http://127.0.0.1:${ctx.webServer.port}`;
    const login = await fetch(ctx.connection.authenticatedUrl(host), { redirect: 'manual' });
    const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (action, args = {}) => {
      const response = await fetch(`${host}/api/dscode-browser`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: host },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-browser', payload: { action, sessionId: agent.session.id, ...args } }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).result;
    };
    const listed = await rpc('tabs');
    assert(listed.ok, listed.error?.message);
    assert.equal(listed.value.pages.find(page => page.id === pageId).url, origin + '/page');
    navigationServer = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Navigated Desktop fixture</title><h1>New preview origin</h1><button>Inspect the new site</button>');
    });
    await new Promise(resolve => navigationServer.listen(0, '127.0.0.1', resolve));
    const nextOrigin = `http://127.0.0.1:${navigationServer.address().port}`;
    await command(`/browser site once ${nextOrigin}`);
    // Navigation is an agent action: run it inside an actual turn so approval
    // events have the same durable turn boundary as normal browser operations.
    navigationUrl = nextOrigin + '/page';
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Navigate to the second fixture origin.' }] }));
    await agent.whenIdle();
    if (failure) throw failure;
    assert.equal(results.at(-1).name, 'mcp__browser__navigate_page');
    assert(!results.at(-1).result.isError, JSON.stringify(results.at(-1)));
    assert.equal(requests, 7);
    const captured = await rpc('capture', { pageId });
    assert(captured.ok, captured.error?.message);
    assert.equal(captured.value.url, nextOrigin + '/page');
    assert(captured.value.permissions.sessionSites.includes(nextOrigin));
    assert.equal(captured.value.permissions.sites[origin].access, 'allow');
    const observedPermissions = await rpc('handoff');
    assert.equal(observedPermissions.ok, true);
    assert(observedPermissions.value.permissions.sessionSites.includes(nextOrigin));
    const annotation = { token: captured.value.token, x: 0.5, y: 0.5, text: 'Make the orange button easier to find.' };
    const sent = await rpc('annotate', { annotation });
    assert(sent.ok, sent.error?.message); assert.equal(sent.value.imageInput, true);
    await agent.whenIdle();
    if (failure) throw failure;
    assert.equal(requests, 8);
    const events = agent.session.snapshotEvents();
    assert(events.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.text === 'DESKTOP_ANNOTATION_OK')));
    const admitted = events.filter(event => event.type === 'user/message' && event.data.content.some(block => block.text?.startsWith('Browser annotation from the user')));
    assert.equal(admitted.length, reload ? 2 : 1);
    const ref = admitted.at(-1).data.content.find(block => block.type === 'image').attachment;
    const expected = await ctx.attachments.readImageRequest(ref, { ...requestImageDimensions(ref.width, ref.height, 2048 * 2048), maxBytes: 1024 * 1024 });
    assert.deepEqual(annotationImage, Buffer.from(expected.data));
    assert.equal((await rpc('annotate', { annotation })).ok, false, 'Annotation receipt must remain single-use in the combined preset');
    const blockReceipt = await command(`/browser site block ${nextOrigin}`);
    assert.match(blockReceipt.text, /^Browser: connected/);
    assert.equal((await rpc('capture', { pageId })).ok, false, 'Revocation must prevent new previews');
    const revokedPermissions = await rpc('handoff');
    assert.equal(revokedPermissions.ok, true);
    assert.equal(revokedPermissions.value.permissions.sites[nextOrigin].access, 'block');
    assert(!revokedPermissions.value.permissions.sessionSites.includes(nextOrigin));
    writeFileSync(permissionReceipt, JSON.stringify({ allowed: origin, blocked: nextOrigin }));
    const stopped = await rpc('stop');
    assert(stopped.ok, stopped.error?.message);
    assert.match(stopped.value.message, /^Browser: disconnected/);
    assert(!ctx.tools.schemas(agent).some(tool => tool.name.startsWith('mcp__browser__')));
    assert.equal((await rpc('tabs')).ok, false, 'Stopped sidebar connections must no longer expose tabs');
    assert.equal((await rpc('annotate', { annotation })).ok, false, 'Stopped sidebar connections must reject old annotations');
    const beforeStart = agent.session.snapshotEvents().length;
    const started = await rpc('start');
    assert(started.ok, started.error?.message);
    const startEvents = agent.session.snapshotEvents().slice(beforeStart);
    const startDone = startEvents.find(event => event.type === 'command/done');
    assert.match(startDone?.data.text ?? '', /^Browser: connected/, 'Sidebar startup must record readable status in conversation history');
    assert.doesNotMatch(startDone.data.text, /"documentId"|"tools"|"instructions"/);
    assert.equal(started.value.message, startDone.data.text);
    const restartedTabs = await rpc('tabs');
    assert(restartedTabs.ok, restartedTabs.error?.message);
    assert(restartedTabs.value.pages.length > 0);
    const restartedPreview = await rpc('capture', { pageId: restartedTabs.value.pages[0].id });
    assert(restartedPreview.ok, restartedPreview.error?.message);
    const resumePageId = restartedTabs.value.pages[0].id;
    await command(`/browser handoff ${resumePageId}`);
    assert.match((await command('/browser permissions')).text, /^Browser: waiting for you/);
    assert.equal((await rpc('tabs')).value.handoff.pageId, resumePageId);
    assert.equal((await rpc('handoff')).value.handoff.pageId, resumePageId);
    assert.equal((await rpc('capture', { pageId: resumePageId })).ok, false);
    const beforeResume = agent.session.snapshotEvents().length;
    const resumed = await rpc('resume');
    assert(resumed.ok, resumed.error?.message);
    const resumeDone = agent.session.snapshotEvents().slice(beforeResume).find(event => event.type === 'command/done');
    assert.equal(resumeDone?.data.text, resumed.value.message);
    assert.match(resumed.value.message, /Browser control resumed/);
    assert.equal((await rpc('tabs')).value.handoff, null);
    assert.equal((await rpc('handoff')).value.handoff, null);
    const oldPreview = await rpc('annotate', { annotation: { token: restartedPreview.value.token, x: 0.5, y: 0.5, text: 'Old handoff pixels' } });
    assert.equal(oldPreview.ok, false); assert.match(oldPreview.error.message, /expired|replaced/);
    assert.equal((await rpc('capture', { pageId: resumePageId })).ok, true);
    const jsonStatus = JSON.parse((await command('/browser start --json')).text);
    assert.equal(jsonStatus.connected, true, 'Explicit JSON commands remain machine-readable');
    assert.equal((await rpc('stop')).ok, true);
    assert.equal((await rpc('stop')).ok, true, 'Sidebar stop is idempotent');
    assert.deepEqual((await rpc('handoff')).value, { connected: false, handoff: null });
    assert.match((await command('/browser permissions')).text, /^Browser: disconnected/);
    return { combinedDesktopBrowser: true, customBrowserScreenshot: true, customBrowserAnnotation: true, combinedBrowserScope: true,
      browserStartReadableHistory: true,
      browserSidebarStop: true,
      browserSidebarResume: true,
      browserCommandInput: true,
      combinedBrowserRevocation: true, capturePermissionsFollowNavigation: true, browserSessionResumed: reload,
      browserPermissionsSurvivedRestart: reload, browserFreshConnectionAfterRestart: reload };
  } finally {
    if (!interactiveReady) await cleanup();
  }
}
