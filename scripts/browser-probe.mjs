import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { BrowserPreview } from '../plugins/browser/preview.mjs';
import { browserForAgent } from '../plugins/browser/review.mjs';
export const name = 'browser-probe';
export const inject = ['agents', 'llm', 'tools', 'permissionPresets', 'commands', 'skills'];
export function apply(ctx, config = {}) {
  const run = scope => { void probe(scope, config).catch(error => { console.error(error.stack); ctx.get('appExit')(1); }); };
  if (config.preset === null) run(ctx);
  else ctx.inject(['agentPresets'], run);
}
async function probe(ctx, { preset = 'dscode' } = {}) {
  await ctx.get('loader').await();
  let calls = 0, approvals = 0, pageId, scenario = 'normal';
  const results = [];
  const annotationInputs = [];
  ctx.on('approval/request', (req, next) => {
    if (req.toolName !== 'browser_stop' && !req.toolName?.startsWith('mcp__browser__')) return next();
    approvals++;
    if (scenario === 'refusal' && req.toolName === 'mcp__browser__close_page') return Promise.resolve('rejected');
    return Promise.resolve('allowed-once');
  }, { prepend: true });
  ctx.on('tools/result', (exec, result) => {
    if (!['browser_start', 'browser_stop', 'browser_tabs', 'browser_handoff'].includes(exec.name) && !exec.name.startsWith('mcp__browser__')) return;
    results.push({ name: exec.name, result });
    if (exec.name === 'mcp__browser__new_page') pageId = result.value?.structuredContent?.pages.find(p => p.selected)?.id;
  });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: model === 'text-only' ? ['text'] : ['text', 'image'], context: { contextWindow: 100000 } }; }
    async *stream(options) {
      for (const message of options.messages ?? []) if (message.role === 'user' && message.content.some(b => b.type === 'text' && b.text.startsWith('Browser annotation from the user'))) annotationInputs.push(message);
      if (!options.purpose) {
        assert(options.tools.some(t => t.name === 'browser_start'));
        if (!calls && scenario !== 'resumed') assert(!options.tools.some(t => t.name.startsWith('mcp__browser__')));
        const steps = scenario === 'site-denial' ? [
          ['browser_start', {}],
          ['mcp__browser__new_page', { url: 'https://ungranted.invalid', background: true }],
          ['browser_stop', {}],
        ] : scenario === 'handoff' ? [
          ['browser_start', {}],
          ['mcp__browser__new_page', { url: 'about:blank', background: true }],
          ['browser_handoff', { pageId, reason: 'Complete the manual fixture step.' }],
          ['mcp__browser__take_snapshot', { pageId }],
          ['browser_stop', {}],
        ] : scenario === 'resumed' ? [
          ['mcp__browser__take_snapshot', { pageId }],
          ['browser_stop', {}],
        ] : scenario === 'refusal' ? [
          ['browser_start', {}],
          ['mcp__browser__new_page', { url: 'about:blank', background: true }],
          ['mcp__browser__close_page', { pageId }],
        ] : [
          ['browser_start', {}],
          ['mcp__browser__new_page', { url: 'about:blank', background: true }],
          ['mcp__browser__take_snapshot', { pageId }],
          ['mcp__browser__take_screenshot', { pageId }],
          ['browser_tabs', { action: 'keep', pageId }],
          ['browser_stop', {}],
        ];
        const step = steps[calls++];
        if (step) {
          assert(options.tools.some(t => t.name === step[0]), `missing ${step[0]}`);
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `browser-${calls}`, name: step[0], arguments: JSON.stringify(step[1]) } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } }; return;
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Browser fixture completed.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['browser-fixture'], new Adapter());
  const make = (sessionId, model = 'fixture') => ctx.agents.create({ sessionId, meta: { cwd: process.cwd(), ...(preset ? { agentPreset: preset } : {}) }, agentOptions: { provider: 'browser-fixture', model }, setup: async (agentCtx, agent) => {
    if (preset) await ctx.agentPresets.mount(agentCtx, preset);
    installModelSelection(agentCtx, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
  } });
  const { agent } = await make('browser-fixture-session');
  const { agent: other } = await make('browser-other-session', 'text-only');
  assert((await ctx.skills.snapshot({ scope: agent })).skills.some(s => s.name === 'browser-use'));
  ctx.permissionPresets.set(agent.session, 'workspace-write');
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Open a disposable blank page, inspect it and take a screenshot, then keep it.' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  const failures = () => JSON.stringify(results.filter(r => r.result.isError));
  assert.equal(results.length, 6, failures());
  assert(results.every(r => !r.result.isError), failures());
  assert.equal(approvals, 3, 'new page, screenshot and stopping managed Chrome require approval; snapshot is read-only');
  assert(!ctx.tools.schemas(other).some(t => t.name.startsWith('mcp__browser__')), 'tools must not leak to another agent');
  const screenshot = results.find(r => r.name === 'mcp__browser__take_screenshot').result;
  assert(screenshot.content.some(b => b.type === 'image'), 'screenshot admitted to durable model context');
  const slash = async text => (await ctx.commands.execute(agent, text, [], new AbortController().signal)).result;
  assert(!ctx.tools.schemas(agent).some(t => t.name.startsWith('mcp__browser__')));
  const savedLaunch = JSON.parse((await slash('/browser status --json')).text).config;
  for (const [command, mode, profile] of [
    ['/browser use persistent launch-fixture --json', 'persistent', 'launch-fixture'],
    ['/browser use isolated --json', 'isolated', undefined],
  ]) {
    const changed = await slash(command);
    assert.equal(changed.kind, 'success', changed.text);
    const config = JSON.parse(changed.text).config;
    assert.equal(config.mode, mode); assert.equal(config.profile, profile);
    assert.equal(config.headless, savedLaunch.headless);
    assert.equal(config.executablePath, savedLaunch.executablePath);
  }
  assert.equal((await slash('/browser start')).kind, 'success');
  assert.equal((await slash('/browser tabs')).kind, 'success');
  const listingBrowser = browserForAgent(agent), nativeCall = listingBrowser.client.callTool;
  listingBrowser.client.callTool = async (request, ...rest) => request.name === 'list_pages'
    ? { isError: true, content: [{ type: 'text', text: 'Fixture page list unavailable' }] }
    : nativeCall.call(listingBrowser.client, request, ...rest);
  try {
    for (const command of ['/browser tabs', '/browser tabs --json']) {
      const failed = await slash(command);
      assert.equal(failed.kind, 'error');
      assert.match(failed.text, /Could not refresh browser tabs/);
    }
    const failed = await ctx.tools.execute({ name: 'browser_tabs', arguments: { action: 'status' }, agent,
      callId: 'tabs-refresh-error', signal: AbortSignal.timeout(10000) });
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /Could not refresh browser tabs/);
  } finally { listingBrowser.client.callTool = nativeCall; }
  const recoveredTabs = await ctx.tools.execute({ name: 'browser_tabs', arguments: { action: 'status' }, agent,
    callId: 'tabs-refresh-recovered', signal: AbortSignal.timeout(10000) });
  assert.equal(recoveredTabs.isError, false);
  assert(recoveredTabs.value.pages.length > 0);
  console.log('BROWSER_TAB_REFRESH_ERROR_PASSED: commands and native tool execution report page-list errors; fresh refresh recovers.');
  const previewPages = JSON.parse((await slash('/browser tabs --json')).text).pages;
  const preview = new BrowserPreview(browserForAgent(agent));
  const frame = await preview.capture(previewPages[0].id);
  assert(frame.image.data && frame.width > 0 && frame.height > 0);
  const annotation = { token: frame.token, x: 0.5, y: 0.5, text: 'Inspect the marked fixture point.' };
  const annotated = await preview.annotate(annotation, ctx, agent);
  assert.equal(annotated.sent, true);
  assert.equal(annotated.imageInput, true);
  assert.match(annotated.message, /with the captured page image/);
  await agent.whenIdle();
  assert(annotationInputs.some(message => message.content.some(b => b.type === 'image')), 'annotation screenshot must reach the image-capable model');
  await assert.rejects(preview.annotate(annotation, ctx, agent), /expired|replaced/, 'annotation receipt cannot be replayed');
  assert.equal((await slash('/browser stop')).kind, 'success');
  assert(!ctx.tools.schemas(agent).some(t => t.name.startsWith('mcp__browser__')));
  ctx.permissionPresets.set(other.session, 'workspace-write');
  calls = 0; pageId = undefined; results.length = 0;
  other.followup(createUserMessage({ content: [{ type: 'text', text: 'Inspect a disposable blank page and check screenshot behavior for this text-only model.' }], source: { kind: 'user' } }));
  await other.whenIdle();
  assert.equal(results.length, 6, failures());
  assert(results.every(r => !r.result.isError), failures());
  const textShot = results.find(r => r.name === 'mcp__browser__take_screenshot').result;
  assert(!textShot.content.some(b => b.type === 'image'));
  assert(textShot.content.some(b => b.type === 'text' && b.text.includes('does not declare image input')));
  const otherSlash = async text => (await ctx.commands.execute(other, text, [], new AbortController().signal)).result;
  assert.equal((await otherSlash('/browser start')).kind, 'success');
  const otherPages = JSON.parse((await otherSlash('/browser tabs --json')).text).pages;
  const textPreview = new BrowserPreview(browserForAgent(other));
  const textFrame = await textPreview.capture(otherPages[0].id);
  annotationInputs.length = 0;
  const textAnnotation = await textPreview.annotate({ token: textFrame.token, x: 0.5, y: 0.5, text: 'Inspect this text-only fixture point.' }, ctx, other);
  assert.equal(textAnnotation.imageInput, false);
  assert.match(textAnnotation.message, /model will receive text only/);
  assert.match(textAnnotation.message, /screenshot is saved in the conversation/);
  await other.whenIdle();
  assert(annotationInputs.length > 0, 'text-only annotation must reach the model');
  assert(annotationInputs.every(message => message.content.every(block => block.type !== 'image')), 'text-only annotation must not project image input');
  assert.equal((await otherSlash('/browser stop')).kind, 'success');
  const { agent: refusal } = await make('browser-refusal-session');
  const { agent: siteDenied } = await make('browser-site-denial');
  ctx.permissionPresets.set(siteDenied.session, 'workspace-write');
  calls = 0; pageId = undefined; results.length = 0; scenario = 'site-denial';
  const beforeSiteDenial = approvals;
  siteDenied.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise the ungranted-site boundary; do not grant access.' }], source: { kind: 'user' } }));
  await siteDenied.whenIdle();
  assert.equal(results.length, 3, failures());
  assert.equal(results[1].result.isError, true);
  assert.match(JSON.stringify(results[1].result), /needs user permission/);
  assert.equal(approvals - beforeSiteDenial, 1, 'site denial precedes tool-action approval; only stopping Chrome is reviewed');
  ctx.permissionPresets.set(refusal.session, 'workspace-write');
  calls = 0; pageId = undefined; results.length = 0; scenario = 'refusal';
  refusal.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise the disposable tab close approval fixture.' }], source: { kind: 'user' } }));
  await refusal.whenIdle();
  assert.equal(results.length, 3);
  assert.equal(results.at(-1).result.isError, true, 'fixture refusal must reach the tool caller');
  const afterDenial = (await ctx.commands.execute(refusal, '/browser tabs --json', [], new AbortController().signal)).result;
  assert.equal(afterDenial.kind, 'success');
  assert(JSON.parse(afterDenial.text).pages.some(p => p.id === pageId && p.kept), 'turn cleanup must preserve the refused-close tab');
  await ctx.commands.execute(refusal, '/browser stop', [], new AbortController().signal);
  const { agent: handoff } = await make('browser-handoff-session');
  ctx.permissionPresets.set(handoff.session, 'workspace-write');
  calls = 0; pageId = undefined; results.length = 0; scenario = 'handoff';
  const beforeHandoffApprovals = approvals;
  handoff.followup(createUserMessage({ content: [{ type: 'text', text: 'Hand a blank page to the human; verify the handoff lock blocks subsequent automation.' }], source: { kind: 'user' } }));
  await handoff.whenIdle();
  assert.equal(results.length, 5, failures());
  assert(results.slice(0, 3).every(r => !r.result.isError), failures());
  assert(results.slice(3).every(r => r.result.isError), 'read and stop must both be blocked during user handoff');
  assert.equal(approvals - beforeHandoffApprovals, 1, 'only the new page needs approval; paused tools must be rejected before prompting');
  const handoffCommand = async text => (await ctx.commands.execute(handoff, text, [], new AbortController().signal)).result;
  assert.match((await handoffCommand('/browser status')).text, /waiting for you/);
  const handed = JSON.parse((await handoffCommand('/browser tabs --json')).text);
  assert.equal(handed.handoff.pageId, pageId);
  assert(handed.pages.some(p => p.id === pageId && p.kept));
  assert.equal(JSON.parse((await handoffCommand('/browser resume --json')).text).resumedPageId, pageId);
  calls = 0; results.length = 0; scenario = 'resumed';
  handoff.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue after my browser step; inspect the page again, then stop.' }], source: { kind: 'user' } }));
  await handoff.whenIdle();
  assert.equal(results.length, 2, failures());
  assert(results.every(r => !r.result.isError), failures());
  console.log('BROWSER_RUNTIME_PROBE_PASSED: native skill, lazy scoped tools, approvals and refused-close retention, durable images, text-only model fallback, handoff pause/resume across turns, commands and disposal.');
  ctx.get('appExit')(0);
}
