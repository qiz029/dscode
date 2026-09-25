import { WebError } from '@deepseek-ai/dsh-web';

// Web search for OpenCode Go sessions. Go has no search endpoint of its own; OpenCode's
// client searches through Exa's hosted MCP server, which answers without an API key, and
// DSCODE does the same so a Go session needs no DeepSeek or OpenRouter key to search.
// `EXA_API_KEY`, when set, moves the calls onto that Exa account.
export const EXA_SEARCH_ID = 'exa';
export const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';
const DEFAULT_MAX_RESULTS = 8;
const CONTEXT_CHARACTERS = 10_000;
const SNIPPET_CHARACTERS = 1_000;
const TIMEOUT_MS = 25_000;

/** The JSON-RPC result text of an MCP answer, sent as one JSON body or as SSE `data:` lines. */
export function mcpText(body) {
  const payloads = [body.trim(), ...body.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())];
  for (const payload of payloads) {
    if (!payload.startsWith('{')) continue;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    if (parsed?.error) throw new WebError(`Exa search failed: ${typeof parsed.error.message === 'string' ? parsed.error.message : 'unknown error'}`, 'WEB_PROVIDER_ERROR');
    const text = parsed?.result?.content?.find(item => typeof item?.text === 'string' && item.text.length > 0)?.text;
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * Sources from Exa's text answer: `Title:`/`URL:`/`Highlights:` records separated by `---`.
 * Records without a URL are dropped, and repeated URLs keep their first record.
 */
export function exaSources(text) {
  const seen = new Set(), sources = [];
  for (const record of text.split(/\n-{3,}\n/)) {
    const url = record.match(/^URL:\s*(\S+)/m)?.[1];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = record.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
    const cut = record.search(/^(?:Highlights|Text|Summary):/m);
    const snippet = cut < 0 ? '' : record.slice(record.indexOf(':', cut) + 1).replace(/\n\.\.\.\n/g, '\n').trim().slice(0, SNIPPET_CHARACTERS);
    sources.push({ url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}) });
  }
  return sources;
}

/** Exa's `web_search_exa` tool over its hosted MCP endpoint. */
export class ExaSearchProvider {
  id = EXA_SEARCH_ID;

  /** @param resolveOptions - `{ resolveApiKey(), userAgent, fetch? }` for the next search. */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }

  available() {
    return true;
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    // An unreadable key store falls back to the keyless endpoint rather than failing the search.
    const apiKey = await Promise.resolve(options.resolveApiKey?.()).catch(() => undefined);
    const url = new URL(EXA_MCP_URL);
    if (apiKey) url.searchParams.set('exaApiKey', apiKey);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response, body;
    try {
      response = await (options.fetch ?? globalThis.fetch)(url, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(options.userAgent ? { 'user-agent': options.userAgent } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: {
          query: request.query, type: 'auto', numResults: request.maxResults ?? DEFAULT_MAX_RESULTS, livecrawl: 'fallback', contextMaxCharacters: CONTEXT_CHARACTERS,
        } } }),
      });
      body = await response.text();
    } catch (error) {
      if (signal?.aborted) throw new WebError('Exa search was cancelled', 'WEB_ABORTED', { cause: error ?? signal.reason });
      if (timeout.aborted) throw new WebError(`Exa search timed out after ${TIMEOUT_MS / 1000}s`, 'WEB_PROVIDER_ERROR', { cause: error });
      throw new WebError(`Exa search request failed: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
    }
    if (!response.ok) throw new WebError(`Exa search failed (HTTP ${response.status}): ${body.slice(0, 200)}`, 'WEB_PROVIDER_ERROR');
    const text = mcpText(body);
    return { sources: text === undefined ? [] : exaSources(text), truncated: false };
  }
}
