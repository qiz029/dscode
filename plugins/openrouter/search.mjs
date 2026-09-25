import { WebError } from '@deepseek-ai/dsh-web';

// Web search through OpenRouter's web plugin, and the provider `ctx.web` is pinned to:
// it searches with the session's own route, so an OpenRouter session never needs a
// DeepSeek key and a DeepSeek session never bills OpenRouter.
export const OPENROUTER_SEARCH_ID = 'openrouter';
export const ROUTED_SEARCH_ID = 'dscode-web';
const DEFAULT_MAX_RESULTS = 8;

/** Sources from the `url_citation` annotations of an OpenRouter message, de-duplicated by URL. */
export function citationSources(message) {
  const seen = new Set(), sources = [];
  for (const annotation of Array.isArray(message?.annotations) ? message.annotations : []) {
    const citation = annotation?.type === 'url_citation' ? annotation.url_citation : undefined;
    if (typeof citation?.url !== 'string' || citation.url.length === 0 || seen.has(citation.url)) continue;
    seen.add(citation.url);
    sources.push({
      url: citation.url,
      ...(typeof citation.title === 'string' && citation.title.length > 0 ? { title: citation.title } : {}),
      ...(typeof citation.content === 'string' && citation.content.length > 0 ? { snippet: citation.content } : {}),
    });
  }
  return sources;
}

const aborted = (signal, error) => new WebError('OpenRouter search was cancelled', 'WEB_ABORTED', { cause: error ?? signal?.reason });

/** Exa search through OpenRouter's `web` plugin on a small model whose answer is discarded. */
export class OpenRouterSearchProvider {
  id = OPENROUTER_SEARCH_ID;

  /** @param resolveOptions - `{ baseURL, model, resolveApiKey(), fetch? }` for the next search. */
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions;
  }

  available() {
    return URL.canParse(this.resolveOptions().baseURL);
  }

  async search(request, signal) {
    const options = this.resolveOptions();
    const apiKey = await options.resolveApiKey();
    if (signal?.aborted) throw aborted(signal);
    if (!apiKey) throw new WebError('OpenRouter search has no API key: run /login openrouter or set OPENROUTER_API_KEY.', 'WEB_PROVIDER_CREDENTIAL_MISSING');
    const body = {
      model: options.model,
      stream: false,
      messages: [{ role: 'user', content: `Search the web for: ${request.query}` }],
      plugins: [{ id: 'web', engine: 'exa', max_results: request.maxResults ?? DEFAULT_MAX_RESULTS }],
      reasoning: { effort: 'none' },
      max_tokens: 256,
    };
    let response, text;
    try {
      response = await (options.fetch ?? globalThis.fetch)(`${options.baseURL}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json', 'HTTP-Referer': 'https://github.com/qiz029/dscode', 'X-OpenRouter-Title': 'DSCODE' },
        body: JSON.stringify(body),
      });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw aborted(signal, error);
      throw new WebError(`OpenRouter search request failed: ${error instanceof Error ? error.message : String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
    }
    let json;
    try { json = JSON.parse(text); } catch { /* reported below */ }
    if (!response.ok || json?.error || !Array.isArray(json?.choices)) {
      const detail = typeof json?.error?.message === 'string' ? json.error.message : text.slice(0, 200);
      throw new WebError(`OpenRouter search failed (HTTP ${response.status}): ${detail}`, 'WEB_PROVIDER_ERROR');
    }
    return { sources: citationSources(json.choices[0]?.message), truncated: false };
  }
}

/**
 * The pinned search provider: OpenRouter for an OpenRouter session, DeepSeek for a
 * DeepSeek one, Exa for an OpenCode Go one (Go has no search of its own), and otherwise
 * whichever provider has a key (DeepSeek first).
 */
export class RoutedSearchProvider {
  id = ROUTED_SEARCH_ID;

  /**
   * @param routes - `openrouter` provider, `deepseek()` provider lookup, optional `exa` provider,
   *   `currentProvider()` of the calling session, and `hasKey(ref)` for credential presence.
   */
  constructor(routes) {
    this.routes = routes;
  }

  available() {
    return this.routes.openrouter.available() || this.routes.deepseek()?.available() === true;
  }

  async pick() {
    const { openrouter, deepseek: lookup, exa, currentProvider, hasKey } = this.routes;
    const deepseek = lookup();
    const route = currentProvider();
    if (route === 'openrouter') return openrouter;
    if (route === 'opencode-go' && exa) return exa;
    if (route === 'deepseek-official' && deepseek) return deepseek;
    if (deepseek && await hasKey('DEEPSEEK_API_KEY')) return deepseek;
    if (await hasKey('OPENROUTER_API_KEY')) return openrouter;
    return deepseek ?? openrouter;
  }

  async search(request, signal) {
    return (await this.pick()).search(request, signal);
  }
}
