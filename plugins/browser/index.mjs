import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createMcpToolDefinition } from './mcp-tools.mjs';
import { BrowserConnection } from './connection.mjs';
import { browserHome, readConfig, saveConfig } from './config.mjs';
import { checkFileArguments } from './files.mjs';
import { formatStatus } from './presentation.mjs';
import { BrowserAccess } from './access.mjs';
import { registerBrowserReview } from './review.mjs';
import { createExtensionRelay } from './extension-relay.mjs';

export const name = 'dscode-browser';
export const inject = ['tools', 'skills', 'commands', 'agents', 'systemPrompt'];
const source = readFileSync(new URL('./SKILL.md', import.meta.url), 'utf8');
export const instructions = source.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
const jsonTool = (name, description, parameters, execute) => defineTool({ name, description, parameters, execute,
  output: { schema: { type: 'object', properties: {}, additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
});

/** Register lazily: a normal coding session never starts Chrome or its MCP. */
export function apply(ctx, options = {}) {
  const home = options.home ?? browserHome();
  const states = new Map();
  const pending = new Map();
  const pairings = new Map();
  const pairingStarts = new Map();
  let disposed = false;
  const connect = options.connect;
  const current = agent => {
    const state = states.get(agent);
    if (!state) throw Error('Call browser_start first.');
    return state.browser;
  };
  const refreshTabs = async (browser, signal) => {
    const result = await browser.call('list_pages', {}, signal);
    if (result.isError) throw Error('Could not refresh browser tabs. Check the browser connection before refreshing again.');
    return browser.status();
  };
  async function stop(agent, protectHandoff = false) {
    pairingStarts.delete(agent);
    const startup = pending.get(agent);
    startup?.controller.abort(Error('Browser startup was cancelled.'));
    const state = states.get(agent);
    if (!state) { pairings.get(agent)?.close(); pairings.delete(agent); await startup?.promise.catch(() => {}); return; }
    const dispose = async () => {
      if (protectHandoff) state.browser.assertAgentControl({ allowDisconnected: true });
      if (states.get(agent) !== state) return;
      states.delete(agent);
      pairings.delete(agent);
      for (const unregister of state.disposers.reverse()) unregister();
      await state.browser.close();
    };
    // Agent stops must respect handoffs already queued by parallel tool calls.
    // User stops and process disposal may interrupt an in-flight operation.
    if (protectHandoff) await state.browser.enqueue(dispose);
    else await dispose();
    await startup?.promise.catch(() => {});
  }
  async function start(agent, signal) {
    if (!agent) throw Error('Browser use requires an agent session.');
    if (disposed) throw Error('Browser plugin has been disposed.');
    if (pending.has(agent)) return pending.get(agent).promise;
    if (states.has(agent)) return { ...current(agent).status(), instructions };
    const startup = { controller: new AbortController() };
    const activeSignal = AbortSignal.any([startup.controller.signal, ...(signal ? [signal] : [])]);
    const work = (async () => {
      const config = await readConfig(home);
      activeSignal.throwIfAborted();
      const relay = pairings.get(agent);
      if (config.mode === 'extension' && !relay?.ready) throw Error('Use /browser pair, connect the DSCODE extension and share a tab, then start the browser.');
      const artifacts = join(home, 'artifacts', agent.session.id.replace(/[^a-zA-Z0-9_-]/g, '_'));
      const fileRoots = [agent.session.header.cwd ?? process.cwd(), artifacts];
      const browser = new BrowserConnection({ home, sessionId: agent.session.id, config, connect, relay, fileRoots });
      const state = { browser, bindings: new Map(), disposers: [registerBrowserReview(agent, browser)] };
      states.set(agent, state);
      try {
        await mkdir(artifacts, { recursive: true, mode: 0o700 });
        browser.args.push('--filesystem-root', agent.session.header.cwd ?? process.cwd(), '--filesystem-root', artifacts);
        await browser.start(activeSignal);
        activeSignal.throwIfAborted();
        if (states.get(agent) !== state) throw Error('Browser startup was cancelled.');
        for (const tool of browser.tools) {
          const definition = createMcpToolDefinition(ctx, {
            name: `mcp__browser__${tool.name}`, rawName: tool.name,
            description: tool.description ?? tool.name, inputSchema: tool.inputSchema,
            call: async (args, exec) => {
              await checkFileArguments(args, fileRoots);
              return browser.call(tool.name, args, exec.signal, state.bindings.get(exec.callId));
            },
          });
          state.disposers.push(agent.ctx.tools.register(definition));
        }
        return { ...browser.status(), artifacts, tools: browser.tools.map(t => `mcp__browser__${t.name}`), instructions };
      } catch (error) {
        if (states.get(agent) === state) {
          states.delete(agent);
          for (const unregister of state.disposers.reverse()) unregister();
        }
        await browser.close();
        throw error;
      }
    })();
    startup.promise = work;
    pending.set(agent, startup);
    try { return await work; } finally { pending.delete(agent); }
  }
  ctx.skills.register({ name: 'browser-use', source: 'runtime', description: 'Operate websites and test local web apps with session-scoped Chrome, persistent login profiles, DOM snapshots, screenshots and DevTools.', content: instructions });
  ctx.systemPrompt.section({ name, order: 1073, text: 'For website interaction or local web UI verification, load the browser-use skill and call browser_start. Browser tools load for this agent only. Prefer purpose-built APIs/CLIs when available. Web search and desktop Computer Use are separate capabilities. Browser mode is selected by the user with /browser; never switch modes or bypass a browser denial through shell.' });
  ctx.tools.register(jsonTool('browser_start', 'Start or inspect this session browser and load its operating instructions and tools. Uses the user-selected profile; default is a dedicated persistent Chrome.', {}, (_args, exec) => start(exec.agent, exec.signal)));
  ctx.tools.register(jsonTool('browser_stop', 'Stop this session browser connection before a deliberate restart. Closes managed Chrome windows, retaining persistent login data; attached Chrome stays open. Do not stop a tab awaiting user input.', {}, async (_args, exec) => {
    if (!exec.agent) throw Error('Browser use requires an agent session.');
    await stop(exec.agent, true);
    return { connected: false };
  }));
  ctx.tools.register(jsonTool('browser_handoff', 'Hand a live tab to the user for login, 2FA or manual input. Focuses it, retains it and pauses browser automation until the user runs /browser resume. End the turn with the human step and resume command; never poll or bypass the pause.', {
    pageId: { type: 'integer', required: true, description: 'Live page ID from list_pages.' },
    reason: { type: 'string', required: true, description: 'The specific human step needed; no credentials. Maximum 500 characters.' },
  }, (args, exec) => current(exec.agent).takeHandoff(args.pageId, args.reason, exec.signal)));
  ctx.tools.register(jsonTool('browser_tabs', 'Inspect tabs, wait for an asynchronously opened tab, keep an agent-created deliverable, or clean up unmarked owned tabs. Waiting only reads page lists and never replays clicks. Never cleans up pre-existing or user-created tabs.', {
    action: { type: 'string', enum: ['status', 'wait', 'keep', 'cleanup'], required: true }, pageId: { type: 'integer', description: 'Required for keep; use a live page ID.' },
    urlContains: { type: 'string', description: 'For wait: required URL substring identifying the expected page.' },
    excludePageIds: { type: 'array', items: { type: 'integer' }, description: 'For wait: IDs listed before the action, to distinguish new tabs from existing ones.' },
    timeoutMs: { type: 'integer', description: 'For wait: 1–30000 milliseconds, default 10000.' },
  }, async (args, exec) => {
    const browser = current(exec.agent);
    if (args.action === 'keep') return browser.keep(args.pageId);
    if (args.action === 'wait') return browser.waitForPage(args, exec.signal);
    if (args.action === 'cleanup') return browser.cleanup(exec.signal);
    return refreshTabs(browser, exec.signal);
  }));
  ctx.commands.register({ name: 'browser', description: 'Browser status/start/stop, extension pair, site permissions, developer access, webmcp on/off, tabs, handoff/resume, cleanup, keep and use; append --json for structured output',
    input: { hint: 'status | start | stop | tabs | handoff <page-id> | resume | site <action> <origin> | use <mode> [profile/url]' },
    handler: async ({ agent, rawInput, signal }) => {
    try {
      const tokens = rawInput.trim().split(/\s+/).filter(Boolean);
      const json = tokens.at(-1) === '--json';
      if (json) tokens.pop();
      const [action = 'status', mode, value, extra] = tokens;
      if (extra) throw Error('Too many arguments.');
      let result;
      const access = states.get(agent)?.browser.access ?? new BrowserAccess(home);
      if (action === 'status' && !mode) result = { config: await readConfig(home), extensionReady: pairings.get(agent)?.ready ?? false, permissions: await access.status(), home };
      else if (action === 'pair' && !mode) {
        if (!agent) throw Error('Extension pairing requires an agent session.');
        if (states.has(agent) || pending.has(agent)) throw Error('Stop this session browser before pairing again.');
        const pairing = {};
        pairingStarts.set(agent, pairing);
        let relay;
        try {
          if ((await readConfig(home)).mode !== 'extension') throw Error('Select /browser use extension first.');
          if (disposed || pairingStarts.get(agent) !== pairing) throw Error('Extension pairing was cancelled.');
          pairings.get(agent)?.close();
          relay = await createExtensionRelay();
          if (disposed || pairingStarts.get(agent) !== pairing) { relay.close(); throw Error('Extension pairing was cancelled.'); }
        } finally { if (pairingStarts.get(agent) === pairing) pairingStarts.delete(agent); }
        pairings.set(agent, relay);
        result = { mode: 'extension', pairingUrl: relay.pairingUrl,
          extensionPath: fileURLToPath(new URL('../../extensions/browser', import.meta.url)),
          message: 'Load the DSCODE Browser extension, paste this pairing link into its popup on the tab to share, then /browser start. Link expires in five minutes. Stop all sharing in the extension to revoke control.' };
      }
      else if (action === 'permissions' && !mode) result = { permissions: await access.status() };
      else if (action === 'site' && ['allow', 'block', 'forget', 'once'].includes(mode) && value) {
        if (mode === 'once' && !states.has(agent)) throw Error('Start the browser before allowing a site for this browser session.');
        result = { permissions: await access.update(mode, value), message: 'Site permissions updated. Tool-action approvals still apply.' };
      } else if (action === 'developer' && ['on', 'off'].includes(mode) && !value) {
        result = { permissions: await access.update('developer-mode', mode), message: `Developer mode ${mode}. Each site needs its own developer grant.` };
      } else if (action === 'developer' && ['allow', 'block'].includes(mode) && value) {
        result = { permissions: await access.update(`developer-${mode}`, value), message: 'Developer site permission updated. Ordinary site permission is still required.' };
      } else if (action === 'webmcp' && ['on', 'off'].includes(mode) && !value) {
        if (states.size || pending.size || ctx.agents.list().some(a => a.status === 'running')) throw Error('Stop all session browsers and wait for agents to become idle before changing WebMCP.');
        result = { config: await saveConfig(home, { ...await readConfig(home), webmcp: mode === 'on' }), message: `WebMCP ${mode}. Start a browser to apply. Attached Chrome requires Chrome 150+ started with --enable-features=WebMCP.` };
      }
      else if (action === 'start' && !mode) { const { instructions: _instructions, ...status } = await start(agent, signal); result = status; }
      else if (action === 'stop' && !mode) { await stop(agent); result = { connected: false, message: 'Browser stopped. Persistent login data is retained.' }; }
      else if (action === 'tabs' && !mode) result = await refreshTabs(current(agent), signal);
      else if (action === 'cleanup' && !mode) result = await current(agent).cleanup(signal);
      else if (action === 'keep' && mode && !value) result = current(agent).keep(Number(mode));
      else if (action === 'handoff' && mode && !value) result = await current(agent).takeHandoff(Number(mode), 'Complete your manual browser step.', signal);
      else if (action === 'resume' && !mode) result = await current(agent).resume(signal);
      else if (action === 'use') {
        if (states.size || pending.size || pairingStarts.size || [...pairings.values()].some(p => !p.closed)) throw Error('Stop all session browsers and extension pairings before changing browser defaults.');
        if (ctx.agents.list().some(a => a.status === 'running')) throw Error('Wait until agents are idle before changing browser defaults.');
        if (!['persistent', 'isolated', 'connect', 'auto', 'extension'].includes(mode) || (value && !['persistent', 'connect'].includes(mode))) throw Error('Usage: /browser use persistent [profile] | isolated | connect <loopback-url> | auto | extension');
        const saved = await readConfig(home);
        const launch = ['persistent', 'isolated'].includes(mode)
          ? { headless: saved.headless, ...(saved.executablePath !== undefined ? { executablePath: saved.executablePath } : {}) } : {};
        result = { config: await saveConfig(home, { mode, ...launch, ...(saved.webmcp !== undefined ? { webmcp: saved.webmcp } : {}), ...(mode === 'persistent' && value ? { profile: value } : {}), ...(mode === 'connect' ? { url: value } : {}) }), message: 'Saved. Use /browser start or ask the agent to use the browser.' };
      } else throw Error('Usage: /browser status|start|stop|pair|tabs|handoff <id>|resume|cleanup|keep <id>|use <mode>|permissions|site allow|once|block|forget <origin>|developer on|off|allow|block [origin]|webmcp on|off [--json]');
      // Permission/configuration operations do not return a connection snapshot.
      // Project the current cached state after their awaits, without contacting Chrome.
      if (result.connected === undefined) result = { ...(states.get(agent)?.browser.status() ?? { connected: false }), ...result };
      return { kind: 'success', text: json ? JSON.stringify(result, null, 2) : formatStatus(result) };
    } catch (error) { return { kind: 'error', text: `Browser: ${error.message}` }; }
  } });
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (!states.has(agent) || pending.has(agent)) return;
    try { await current(agent).cleanup(); }
    catch (error) { ctx.logger?.warn(`Browser tab cleanup stopped: ${error.message}`); }
  });
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (states.get(exec.agent)?.browser.handoff && (exec.name === 'browser_stop' ||
        (exec.name.startsWith('mcp__browser__') && exec.name !== 'mcp__browser__list_pages'))) {
      return { kind: 'deny', reason: 'Browser is handed to the user. Wait for /browser resume before reading or operating pages.' };
    }
    const browser = states.get(exec.agent)?.browser;
    if (browser && exec.name.startsWith('mcp__browser__')) {
      try { await browser.access.check(exec.name.slice('mcp__browser__'.length), exec.arguments ?? {}, browser.pages); }
      catch (error) { return { kind: 'deny', reason: error.message }; }
      if (exec.callId && Number.isSafeInteger(exec.arguments?.pageId)) {
        const page = browser.pages.find(p => p.id === exec.arguments.pageId);
        if (page) states.get(exec.agent).bindings.set(exec.callId, { url: page.url, documentId: page.documentId,
          definition: browser.siteTools.get(page.id)?.definitions.get(exec.arguments.toolName) });
      }
    }
    return next();
  }, { prepend: true });
  ctx.on('tools/result', (exec, result) => {
    states.get(exec.agent)?.bindings.delete(exec.callId);
    // Cleanup must not perform a rejected close, nor erase the visible state
    // of an uncertain action before the user/agent can inspect it.
    if (!result.isError || !exec.name.startsWith('mcp__browser__')) return;
    const browser = states.get(exec.agent)?.browser;
    const id = exec.arguments?.pageId;
    if (browser?.owned.has(id)) browser.keep(id, 'failed-or-denied-action');
  });
  ctx.on('agent/disposed', ({ agent }) => stop(agent));
  ctx.effect(() => async () => {
    disposed = true;
    pairingStarts.clear();
    await Promise.allSettled([...new Set([...states.keys(), ...pending.keys(), ...pairings.keys()])].map(agent => stop(agent)));
  });
}
