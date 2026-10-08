import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchOptions } from './config.mjs';
import { BrowserAccess, needsDeveloper } from './access.mjs';
import { checkFileArguments } from './files.mjs';
import { BROWSER_STDIO_MAX_BYTES } from './screenshots.mjs';

const entrypoint = () => fileURLToPath(new URL('./mcp-entry.mjs', import.meta.url));
const pagesOf = result => result.structuredContent?.pages;

/** One browser per agent session. All calls are ordered, including disposal. */
export class BrowserConnection {
  constructor({ home, sessionId, config, connect = connectChrome, access = new BrowserAccess(home), relay, fileRoots }) {
    Object.assign(this, launchOptions(home, sessionId, config));
    this.connect = connect;
    this.access = access;
    this.relay = relay;
    this.fileRoots = fileRoots;
    this.siteTools = new Map();
    this.owned = new Set();
    this.kept = new Map();
    this.pages = [];
    this.tail = Promise.resolve();
    this.closed = false;
    this.failure = undefined;
    this.handoff = null;
    this.observedAt = null;
    this.generation = 0;
  }

  async start(signal) {
    if (this.closed) throw Error('Browser connection is closed. Use browser_start to reconnect.');
    if (!this.starting) this.starting = (async () => {
      if (this.config.mode === 'extension') {
        if (!this.relay?.ready) throw Error('Use /browser pair, connect the DSCODE extension and share a tab, then start the browser.');
        this.args.push('--ws-endpoint', this.relay.endpoint);
        this.releaseRelayListener = this.relay.onClose(() => {
          this.failure = 'Browser extension disconnected or sharing was revoked. Use /browser stop, then /browser pair to share again. Do not replay an uncertain action.';
        });
      }
      if (this.profile) await mkdir(this.profile, { recursive: true, mode: 0o700 });
      const connection = await this.connect(this.args, signal);
      this.client = connection.client;
      this.transport = connection.transport;
      this.client.onclose = () => { if (!this.closed) this.failure = 'Browser connection ended. Call browser_stop then browser_start (or /browser stop and /browser start). Do not replay an uncertain action.'; };
      this.tools = (await this.client.listTools({}, { signal, timeout: 30000 })).tools;
      const result = await this.raw('list_pages', {}, signal);
      if (result.isError) throw Error(`Browser startup failed: ${result.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 4000)}`);
      this.observe(result);
      return this;
    })().catch(async error => { await this.close(); throw error; });
    return this.starting;
  }

  enqueue(action, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let abort;
    const cancelled = signal && new Promise((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    const detach = () => { if (abort) signal.removeEventListener('abort', abort); };
    const result = this.tail.then(() => {
      // Cancel queued work promptly, but retain its place until earlier work
      // settles. Once dispatched, the action and MCP own cancellation handling.
      detach();
      signal?.throwIfAborted();
      return action();
    });
    this.tail = result.catch(() => {});
    return cancelled ? Promise.race([result, cancelled]).finally(detach) : result;
  }

  async raw(name, args, signal) {
    if (this.closed || this.failure) throw Error(this.failure ?? 'Browser connection is closed.');
    signal?.throwIfAborted();
    const result = await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 60000 });
    // A successful refresh must replace cached observations. Other tools may
    // omit pages, but list_pages cannot authorize actions with stale metadata.
    if (name === 'list_pages' && !result.isError && !Array.isArray(pagesOf(result))) {
      // A restart invalidates page IDs even when its new list is unavailable.
      // Do not lose that generation signal by rejecting before observation.
      if (result.structuredContent?.reconnected) this.observe(result);
      throw Error('Browser page list is unavailable or malformed. Refresh browser status before continuing.');
    }
    return result;
  }

  observe(result) {
    if (result.structuredContent?.reconnected) {
      this.generation++;
      // IDs are generation-local; never transfer ownership to a newly numbered tab.
      this.owned.clear(); this.kept.clear();
      this.siteTools.clear();
      if (this.handoff) this.handoff.invalidated = true;
    }
    const pages = pagesOf(result);
    if (Array.isArray(pages)) {
      for (const [id, entry] of this.siteTools) {
        if (!pages.some(p => p.id === id && p.url === entry.url && p.documentId && p.documentId === entry.documentId)) this.siteTools.delete(id);
      }
      this.pages = pages;
      this.observedAt = new Date().toISOString();
      const live = new Set(pages.map(p => p.id));
      for (const id of this.owned) if (!live.has(id)) { this.owned.delete(id); this.kept.delete(id); }
    }
  }

  call(name, args, signal, reviewed) {
    return this.enqueue(async () => {
      if (this.closed || this.failure) throw Error(this.failure ?? 'Browser connection is closed.');
      if (name !== 'list_pages') this.assertAgentControl();
      if (!this.tools?.some(tool => tool.name === name)) throw Error(`Unknown browser tool: ${name}`);
      if (name.includes('webmcp') && !this.config.webmcp) throw Error('WebMCP is disabled. The user can enable /browser webmcp on after stopping session browsers.');
      // A refresh replaces the previous discovery even when it fails. Otherwise
      // a later execution could silently reuse definitions the agent could not
      // confirm in its most recent observation.
      if (name === 'list_webmcp_tools') this.siteTools.delete(args.pageId);
      if (args.pageId !== undefined) {
        // Chrome may restart while the MCP transport stays alive. Detect that
        // generation before forwarding an action that carries an old page ID.
        const listing = await this.raw('list_pages', {}, signal);
        this.observe(listing);
        if (listing.isError) return listing;
        if (listing.structuredContent?.reconnected) throw Error('Chrome restarted; previous page IDs are invalid. List pages and observe the intended page before acting. No action was replayed.');
        if (!this.pages.some(page => page.id === args.pageId)) throw Error('That browser page is closed or unavailable. List pages and choose a live page.');
      }
      await this.access.check(name, args, this.pages);
      const sourcePage = this.pages.find(p => p.id === args.pageId);
      const sourceUrl = sourcePage?.url, sourceDocument = sourcePage?.documentId, sourceGeneration = this.generation;
      if (reviewed && this.pages.find(p => p.id === args.pageId)?.url !== reviewed.url) throw Error('Browser page changed after the tool was proposed. Inspect it and submit a new action for review; nothing was executed.');
      if (name === 'execute_webmcp_tool') {
        const discovered = this.siteTools.get(args.pageId);
        if (!discovered || discovered.url !== this.pages.find(p => p.id === args.pageId)?.url) throw Error('Discover WebMCP tools on this page before executing one.');
        if (reviewed && reviewed.documentId !== discovered.documentId) throw Error('WebMCP document changed after review. Discover and review the action again.');
        if (reviewed && reviewed.definition !== discovered.definitions.get(args.toolName)) throw Error('WebMCP definition changed after review. Discover and review the action again.');
        try {
          const listed = await this.raw('list_webmcp_tools', { pageId: args.pageId }, signal);
          this.observe(listed);
          // Native WebMCP discovery omits page metadata. Re-observe after its
          // result, before dispatching the action, to bind it to this document.
          const verified = await this.raw('list_pages', {}, signal);
          this.observe(verified);
          await this.access.check(name, args, this.pages);
          const definition = listed.structuredContent?.webmcpTools?.find(t => t.name === args.toolName);
          if (listed.isError || listed.structuredContent?.reconnected || verified.isError || verified.structuredContent?.reconnected || !Array.isArray(pagesOf(verified)) || !definition ||
              this.siteTools.get(args.pageId) !== discovered ||
              JSON.stringify(definition) !== discovered.definitions.get(args.toolName)) {
            throw Error('WebMCP registration or page changed. Discover tools again and review the new definition; no action was executed.');
          }
        } catch (error) {
          this.siteTools.delete(args.pageId);
          throw error;
        }
        const input = args.input === undefined ? {} : JSON.parse(args.input);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('WebMCP input must be a JSON object.');
      }
      // Only the selected page returned by new_page is ours; a user's concurrent
      // new tab must never be inferred to be agent-owned from a list difference.
      // Files may change while this action waits in the queue or observes Chrome.
      // Recheck at dispatch as well as at tool admission.
      if (this.fileRoots) await checkFileArguments(args, this.fileRoots);
      // Admission and WebMCP/file validation can yield while another session
      // revokes access. Withholding output afterward cannot undo a dispatched
      // action, so authorize again after those awaited preparations.
      if (name !== 'list_pages') {
        await this.access.check(name, args, this.pages);
        this.assertAgentControl();
      }
      if (name === 'resize_page' && this.config.headless) {
        // Background headless tabs retain old layout dimensions until activated.
        // Use the supported tool rather than mutating upstream tool definitions.
        const selected = await this.raw('select_page', { pageId: args.pageId, bringToFront: true }, signal);
        this.observe(selected);
        if (selected.isError) return selected;
        if (this.generation !== sourceGeneration) throw Error('Chrome restarted before resizing. List pages and choose the intended page; resize was not sent.');
        await this.access.check(name, args, this.pages);
        this.assertAgentControl();
      }
      let result;
      try { result = await this.raw(name, args, signal); }
      catch (error) {
        if (name !== 'execute_webmcp_tool') throw error;
        this.siteTools.delete(args.pageId);
        if (this.owned.has(args.pageId)) this.keep(args.pageId, 'uncertain-webmcp');
        throw Error(`WebMCP execution response was not received. ${error.message} The action may already have completed; inspect the page and do not replay it. Discover tools again before requesting another action.`, { cause: error });
      }
      this.observe(result);
      if (!result.isError && name === 'new_page') {
        const page = pagesOf(result)?.find(p => p.selected);
        if (page) this.owned.add(page.id);
      }
      // Re-observe after the call as a navigation can finish while the tool is
      // producing its response. The response may still contain source-page
      // data: authorize every observed origin, not just the final destination.
      // This does not undo requests already made by the browser.
      if (name !== 'list_pages') {
        const target = name === 'new_page' ? pagesOf(result)?.find(p => p.selected)?.id : args.pageId;
        try {
          const listing = await this.raw('list_pages', {}, signal);
          this.observe(listing);
          if (listing.isError || listing.structuredContent?.reconnected) throw Error('Page list unavailable or Chrome restarted.');
        } catch (error) {
          if (name === 'execute_webmcp_tool') this.siteTools.delete(args.pageId);
          // new_page has no input pageId for the generic result hook to retain.
          // Preserve confirmed ownership before cleanup can erase this evidence.
          // observe() clears ownership on restart, so recycled IDs stay unowned.
          if (this.owned.has(target)) this.keep(target, 'unverified-action');
          throw Error(`Could not verify the page after the action. ${error.message} The action may already have completed; inspect browser status and do not replay it.`, { cause: error });
        }
        const page = this.pages.find(p => p.id === target);
        try {
          if (!page && name !== 'close_page') throw Error('Browser page unavailable after the action.');
          const resultUrl = pagesOf(result)?.find(p => p.id === target)?.url;
          const urls = new Set([sourceUrl, name === 'new_page' ? args.url : undefined, resultUrl, page?.url]);
          for (const url of urls) if (url !== undefined) await this.access.checkUrl(url, needsDeveloper(name, args));
        }
        catch (error) {
          if (name === 'execute_webmcp_tool') this.siteTools.delete(args.pageId);
          if (this.owned.has(target)) this.keep(target, 'site-permission');
          throw Error(`Page output withheld after navigation, closure or permission change. ${error.message} The action may already have completed; do not replay it.`, { cause: error });
        }
        if (name === 'list_webmcp_tools' && !result.isError && page) {
          const returnedPage = pagesOf(result)?.find(p => p.id === target);
          if (!sourceDocument || page.url !== sourceUrl || page.documentId !== sourceDocument ||
              (returnedPage && (returnedPage.url !== sourceUrl || returnedPage.documentId !== sourceDocument)) || this.generation !== sourceGeneration) {
            throw Error('Page changed or its document could not be verified during WebMCP discovery. Inspect the intended page and discover its tools again.');
          }
          const definitions = result.structuredContent?.webmcpTools;
          if (!Array.isArray(definitions)) throw Error('WebMCP discovery is unavailable. Use Chrome 150+ with WebMCP enabled, or ordinary DOM tools.');
          this.siteTools.set(target, { url: page.url, documentId: sourceDocument, definitions: new Map(definitions.map(t => [t.name, JSON.stringify(t)])) });
        }
      }
      return result;
    }, signal);
  }

  keep(pageId, reason = 'deliverable') {
    if (!this.owned.has(pageId)) throw Error('Only a tab created by this session can be marked for retention.');
    if (!this.kept.has(pageId)) this.kept.set(pageId, reason);
    return this.status();
  }

  waitForPage({ urlContains, excludePageIds = [], timeoutMs = 10000 }, signal) {
    if (typeof urlContains !== 'string' || !urlContains || urlContains.length > 2048) return Promise.reject(Error('Specify a URL substring of 1–2048 characters to identify the expected tab.'));
    if (!Array.isArray(excludePageIds) || !excludePageIds.every(Number.isSafeInteger)) return Promise.reject(Error('excludePageIds must contain live integer page IDs from before the action.'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(Error('Tab wait timeout must be 1–30000 milliseconds.'));
    return this.enqueue(async () => {
      this.assertAgentControl();
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      const activeSignal = AbortSignal.any([deadline.signal, ...(signal ? [signal] : [])]);
      try {
        while (true) {
          const listing = await this.raw('list_pages', {}, activeSignal);
          this.observe(listing);
          if (listing.isError) throw Error('Cannot refresh pages while waiting for a tab.');
          if (listing.structuredContent?.reconnected) throw Error('Chrome restarted while waiting; list pages again before choosing a target.');
          const matches = this.pages.filter(p => p.url.includes(urlContains) && !excludePageIds.includes(p.id));
          if (matches.length > 1) throw Error('Several tabs match. List pages and choose the intended page ID.');
          if (matches.length === 1) return { page: matches[0], ...this.status() };
          await delay(200, undefined, { signal: activeSignal });
        }
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (deadline.signal.aborted) throw Error('Timed out waiting for the expected tab. Inspect the page list and original action before retrying; do not repeat an uncertain click.', { cause: error });
        throw error;
      } finally { clearTimeout(timer); }
    }, signal);
  }

  assertAgentControl({ allowDisconnected = false } = {}) {
    if (!allowDisconnected && (this.closed || this.failure)) throw Error(this.failure ?? 'Browser connection is closed.');
    if (this.handoff) throw Error('Browser is handed to the user. Wait for the user to run /browser resume; do not operate or stop it through another tool.');
  }

  takeHandoff(pageId, reason, signal) {
    return this.enqueue(async () => {
      if (!Number.isSafeInteger(pageId)) throw Error('Handoff requires a live integer page ID.');
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw Error('Describe the human step in 1–500 characters.');
      if (this.handoff) return this.status();
      const listing = await this.raw('list_pages', {}, signal);
      this.observe(listing);
      if (listing.isError) throw Error('Cannot verify the handoff page. List pages before trying again.');
      if (listing.structuredContent?.reconnected) throw Error('Chrome restarted; list pages and choose the handoff page again.');
      const page = this.pages.find(p => p.id === pageId);
      if (!page) throw Error('The handoff page is closed or unavailable.');
      // Pause before focusing: a failed focus must not allow further actions
      // while the user may already be interacting with the page.
      this.handoff = { pageId, url: page.url, reason: reason.trim(), invalidated: false, focusError: null };
      if (this.owned.has(pageId)) this.kept.set(pageId, 'handoff');
      try {
        const focused = await this.raw('select_page', { pageId, bringToFront: true }, signal);
        this.observe(focused);
        if (focused.isError) this.handoff.focusError = 'Could not focus the page. Select it manually in Chrome.';
      } catch { this.handoff.focusError = 'Could not focus the page. Select it manually in Chrome.'; }
      return this.status();
    }, signal);
  }

  // Only the user command exposes this transition; it is not an agent tool.
  resume(signal) {
    return this.enqueue(async () => {
      if (!this.handoff) throw Error('There is no browser handoff to resume.');
      const listing = await this.raw('list_pages', {}, signal);
      this.observe(listing);
      if (listing.isError) throw Error('Cannot refresh browser pages; handoff remains paused.');
      const pageId = this.handoff.pageId;
      const resumedPageId = !this.handoff.invalidated && this.pages.some(p => p.id === pageId) ? pageId : null;
      this.handoff = null;
      if (resumedPageId !== null && this.kept.get(pageId) === 'handoff') this.kept.set(pageId, 'resumed-handoff');
      return { ...this.status(), resumedPageId, message: resumedPageId === null
        ? 'Browser control resumed. The original page is unavailable; choose a live page and take a new snapshot before acting.'
        : `Browser control resumed on page ${pageId}. Take a new snapshot before acting; the user may have changed the page.` };
    }, signal);
  }

  cleanup(signal) {
    return this.enqueue(async () => {
      if (this.handoff) return { closed: [], skipped: 'user-handoff', ...this.status() };
      const listing = await this.raw('list_pages', {}, signal);
      if (listing.isError) throw Error('Cannot verify live tabs; cleanup stopped.');
      this.observe(listing);
      const closed = [];
      for (const id of [...this.owned]) {
        if (this.kept.has(id)) continue;
        // Recheck between closes: Chrome can restart in the middle of a cleanup
        // batch and reuse IDs from the array captured by this loop.
        const live = await this.raw('list_pages', {}, signal);
        this.observe(live);
        if (live.isError) throw Error('Cannot verify live tabs; cleanup stopped.');
        if (live.structuredContent?.reconnected) break;
        if (!this.owned.has(id) || this.kept.has(id)) continue;
        try { await this.access.checkUrl(this.pages.find(p => p.id === id)?.url); }
        catch { this.kept.set(id, 'site-permission'); continue; }
        // User commands and completed previews can retain a tab while either
        // observation awaits I/O. Honor them before dispatching its close.
        if (!this.owned.has(id) || this.kept.has(id)) continue;
        // A timeout may have closed the tab. Preserve any remaining page rather
        // than silently retrying that close on the next turn's cleanup.
        this.kept.set(id, 'uncertain-close');
        const result = await this.raw('close_page', { pageId: id }, signal);
        this.observe(result);
        if (result.structuredContent?.reconnected) break;
        if (result.isError) throw Error('Tab cleanup failed; inspect browser status before retrying.');
        if (!this.pages.some(p => p.id === id)) closed.push(id);
        else this.kept.set(id, 'close-not-confirmed');
      }
      return { closed, ...this.status() };
    }, signal);
  }

  status() {
    return { mode: this.config.mode, profile: this.profile ?? null, connected: !!this.client && !this.closed && !this.failure, error: this.failure ?? null,
      headless: this.config.headless, webmcp: !!this.config.webmcp, observedAt: this.observedAt, handoff: this.handoff ? { ...this.handoff } : null,
      pages: this.pages.map(page => ({ ...page, owned: this.owned.has(page.id), kept: this.kept.has(page.id), retention: this.kept.get(page.id) ?? null })) };
  }

  async close() {
    this.closed = true;
    this.releaseRelayListener?.();
    this.relay?.close();
    // Closing the transport also interrupts an in-flight request. No replay.
    await this.client?.close().catch(() => {});
    await this.transport?.close().catch(() => {});
  }
}

export function browserProcessEnvironment(versions = process.versions) {
  // Desktop Hosts run under Electron's Node mode. The SDK's minimal environment
  // omits this flag; without it the child opens the desktop app instead of MCP.
  return { ...getDefaultEnvironment(), ...(versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
}

async function connectChrome(args, signal) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint(), ...args], env: browserProcessEnvironment(), stderr: 'pipe', maxBufferSize: BROWSER_STDIO_MAX_BYTES });
  const client = new Client({ name: 'dscode-browser', version: '1.0.0' });
  // Drain diagnostics without sending local browser state or paths into logs.
  transport.stderr?.on('data', () => {});
  try { await client.connect(transport, { signal, timeout: 30000 }); return { client, transport }; }
  catch (error) { await transport.close(); throw error; }
}
