import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// dscode: the Grok model catalog. The subscription rail serves its models from the same
// CLI proxy the official `grok` client uses, and that listing carries what a harness needs:
// the context window, the reasoning detents (xhigh/high/medium/low, which are DSCODE effort
// ids already), the backend-search flag and the compaction threshold. One table, kept for a
// day in DSH_HOME, backs /model, compaction and the status line.

export const GROK_MODELS_URL = "https://cli-chat-proxy.grok.com/v1/models";
/** How long a first model lookup waits for the listing before answering without it. */
export const GROK_MODELS_TIMEOUT_MS = 10_000;
/** How long a failed listing (or an unusable cache file) waits before the next attempt. */
export const GROK_MODELS_RETRY_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FILE = "grok-models.json";
const VERSION = 1;
/** Reasoning detents DSCODE names; the wire spells them the same way through this route. */
export const GROK_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
/** Media models the chat route must not offer to an agent. */
const NON_CHAT = /(?:imagine|video|image|audio|vision-gen)/i;
let table = { fetchedAt: 0, models: {} };
let cacheReadAt = 0;
let attemptedAt = 0, pending;

const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;

/**
 * Models from one `/models` body of the Grok CLI proxy, or of the public api.x.ai listing.
 * @returns `{ [id]: { name, description?, contextWindow?, maxOutput?, efforts?, defaultEffort?,
 *   backendSearch?, compactThresholdPercent?, compactionAtTokens? } }`
 */
export function parseGrokModels(body) {
  const models = {};
  for (const model of Array.isArray(body?.data) ? body.data : []) {
    const id = typeof model?.id === "string" ? model.id : typeof model?.model === "string" ? model.model : undefined;
    if (id === undefined || id.length === 0 || NON_CHAT.test(id)) continue;
    const efforts = (Array.isArray(model.reasoning_efforts) ? model.reasoning_efforts : [])
      .map(entry => typeof entry === "string" ? entry : entry?.id)
      .filter(level => GROK_EFFORTS.includes(level));
    const named = efforts.length > 0 ? GROK_EFFORTS.filter(level => efforts.includes(level)) : undefined;
    const defaultEffort = typeof model.reasoning_effort === "string" && GROK_EFFORTS.includes(model.reasoning_effort) ? model.reasoning_effort : undefined;
    const contextWindow = positive(model.context_window) ?? positive(model.context_length);
    models[id] = {
      name: typeof model.name === "string" && model.name.length > 0 ? model.name : id,
      ...typeof model.description === "string" && model.description.length > 0 ? { description: model.description } : {},
      ...contextWindow === undefined ? {} : { contextWindow },
      ...positive(model.max_completion_tokens) === undefined ? {} : { maxOutput: positive(model.max_completion_tokens) },
      ...named === undefined ? {} : { efforts: named }, ...defaultEffort === undefined ? {} : { defaultEffort },
      ...model.supports_backend_search === true ? { backendSearch: true } : {},
      ...positive(model.auto_compact_threshold_percent) === undefined ? {} : { compactThresholdPercent: positive(model.auto_compact_threshold_percent) },
      ...model.compaction_at_tokens === true ? { compactionAtTokens: true } : {},
    };
  }
  return models;
}

/** One model entry, or undefined when the table does not list it. */
export function grokModel(id) {
  return Object.hasOwn(table.models, id) ? table.models[id] : undefined;
}

/** Every listed model as `[id, entry]` pairs, in listing order. */
export function listGrokModels() {
  return Object.entries(table.models);
}

/** Replace the table (and forget the last attempt); for tests and cache loads. */
export function setGrokModels(models, fetchedAt = Date.now()) {
  table = { fetchedAt, models };
  cacheReadAt = 0;
  attemptedAt = 0;
}

/** The headers the official CLI sends; the proxy answers a request without them with its generic API rail. */
export function grokCliHeaders(token, version) {
  return { authorization: "Bearer " + token, accept: "application/json", "x-xai-token-auth": "xai-grok-cli", "x-grok-client-version": version };
}

/**
 * Load the cached table, then refetch it once it is a day old. A failure keeps the last
 * table and waits ten minutes before trying again; never throws.
 */
export async function refreshGrokModels({ home, token, version = "1.0.34", fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const path = home ? join(home, FILE) : undefined;
  if (table.fetchedAt === 0 && path && now - cacheReadAt >= GROK_MODELS_RETRY_MS) {
    cacheReadAt = now;
    try {
      const cached = JSON.parse(readFileSync(path, "utf8"));
      if (cached?.version === VERSION && Number.isFinite(cached.fetchedAt) && cached.models && typeof cached.models === "object") table = { fetchedAt: cached.fetchedAt, models: cached.models };
    } catch { /* no usable cache */ }
  }
  if (now - table.fetchedAt < MAX_AGE_MS || now - attemptedAt < GROK_MODELS_RETRY_MS || token === undefined || typeof fetchImpl !== "function") return table;
  if (pending) return pending;
  attemptedAt = now;
  pending = (async () => {
    try {
      const response = await fetchImpl(GROK_MODELS_URL, { headers: grokCliHeaders(token, version) });
      if (!response.ok) return table;
      const models = parseGrokModels(await response.json());
      if (Object.keys(models).length === 0) return table;
      table = { fetchedAt: now, models };
      if (path) {
        mkdirSync(home, { recursive: true });
        writeFileSync(path + ".tmp", JSON.stringify({ version: VERSION, ...table }));
        renameSync(path + ".tmp", path);
      }
      return table;
    } catch {
      return table;
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

/**
 * The table before a model lookup: an empty one waits up to `timeoutMs` for the listing,
 * a stale one refreshes in the background.
 */
export async function ensureGrokModels({ timeoutMs = GROK_MODELS_TIMEOUT_MS, ...options } = {}) {
  const refresh = refreshGrokModels(options);
  if (Object.keys(table.models).length > 0) return table;
  let timer;
  await Promise.race([refresh, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  clearTimeout(timer);
  return table;
}
