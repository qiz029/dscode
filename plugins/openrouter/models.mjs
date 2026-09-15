import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// OpenRouter's public model listing: context sizes, input modalities, reasoning
// controls and list prices for every model it serves. The OpenRouter adapter
// resolves models from it and the session metrics price calls from it, so one
// table, kept for a day in DSH_HOME, backs both. The listing quotes USD per
// token; the table keeps USD per million.
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** How long a first model lookup waits for the listing before answering without it. */
export const FORCED_LOAD_TIMEOUT_MS = 10_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const FILE = 'openrouter-models.json';
const VERSION = 2;
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
let table = { fetchedAt: 0, models: {} };
let attemptedAt = 0, pending;

const perMillion = value => {
  const number = Number(value);
  return value != null && value !== '' && Number.isFinite(number) && number >= 0 ? number * 1e6 : undefined;
};
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const ratesOf = pricing => {
  const input = perMillion(pricing?.prompt), output = perMillion(pricing?.completion);
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cacheRead: perMillion(pricing.input_cache_read), cacheWrite: perMillion(pricing.input_cache_write) };
};

function reasoningOf(reasoning) {
  if (reasoning === null || typeof reasoning !== 'object') return undefined;
  const offered = Array.isArray(reasoning.supported_efforts) ? EFFORTS.filter(level => reasoning.supported_efforts.includes(level)) : undefined;
  return {
    mandatory: reasoning.mandatory === true,
    ...(offered?.length ? { efforts: offered } : {}),
    ...(EFFORTS.includes(reasoning.default_effort) ? { defaultEffort: reasoning.default_effort } : {}),
  };
}

/**
 * Models from an OpenRouter `/models` body.
 * @returns `{ [id]: { input, output, cacheRead?, cacheWrite?, tiers?, name?, contextWindow?, maxOutput?,
 *   inputModalities?, tools?, textOutput?, reasoning? } }` with prices in USD per million tokens;
 *   a tier applies once a request's prompt reaches its `minPromptTokens`.
 */
export function parseOpenRouterModels(body) {
  const models = {};
  for (const model of Array.isArray(body?.data) ? body.data : []) {
    const base = typeof model?.id === 'string' ? ratesOf(model.pricing) : undefined;
    if (!base) continue;
    const tiers = (Array.isArray(model.pricing.overrides) ? model.pricing.overrides : [])
      .map(tier => ({ minPromptTokens: Number(tier?.min_prompt_tokens), ...ratesOf({ ...model.pricing, ...tier }) }))
      .filter(tier => Number.isFinite(tier.minPromptTokens) && tier.input !== undefined)
      .sort((left, right) => left.minPromptTokens - right.minPromptTokens);
    // The routed endpoint can serve less than the model's nominal context.
    const windows = [model.context_length, model.top_provider?.context_length].map(positive).filter(Boolean);
    const input = model.architecture?.input_modalities, output = model.architecture?.output_modalities;
    const reasoning = reasoningOf(model.reasoning);
    models[model.id] = {
      ...base, ...(tiers.length ? { tiers } : {}),
      ...(typeof model.name === 'string' && model.name.length > 0 ? { name: model.name } : {}),
      ...(windows.length ? { contextWindow: Math.min(...windows) } : {}),
      ...(positive(model.top_provider?.max_completion_tokens) ? { maxOutput: model.top_provider.max_completion_tokens } : {}),
      ...(Array.isArray(input) ? { inputModalities: ['text', 'image'].filter(modality => input.includes(modality)) } : {}),
      ...(Array.isArray(model.supported_parameters) ? { tools: model.supported_parameters.includes('tools') } : {}),
      ...(Array.isArray(output) ? { textOutput: output.includes('text') } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }
  return models;
}

/** One model's entry, or undefined when the table does not list it. */
export function openRouterModel(id) {
  return Object.hasOwn(table.models, id) ? table.models[id] : undefined;
}

/** Every listed model as `[id, entry]` pairs, in listing order. */
export function listOpenRouterModels() {
  return Object.entries(table.models);
}

/** Prices for one model at a request's prompt size, or undefined when the table lists none. */
export function openRouterRates(model, promptTokens = 0) {
  const entry = openRouterModel(model);
  if (!entry) return undefined;
  return entry.tiers?.findLast(tier => promptTokens >= tier.minPromptTokens) ?? entry;
}

/** Version stamp for rows priced from the live table: the day it was fetched. */
export function openRouterPriceVersion() {
  return table.fetchedAt > 0 ? `openrouter-models-${new Date(table.fetchedAt).toISOString().slice(0, 10)}` : undefined;
}

/** Replace the table (and forget the last attempt); for tests and cache loads. */
export function setOpenRouterModels(models, fetchedAt = Date.now()) {
  table = { fetchedAt, models };
  attemptedAt = 0;
}

/**
 * Load the cached table, then refetch it once it is a day old. A failure keeps the
 * last table and waits ten minutes before trying again; never throws.
 */
export async function refreshOpenRouterModels({ home, fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const path = home ? join(home, FILE) : undefined;
  if (table.fetchedAt === 0 && path) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8'));
      if (cached?.version === VERSION && Number.isFinite(cached.fetchedAt) && cached.models && typeof cached.models === 'object') table = { fetchedAt: cached.fetchedAt, models: cached.models };
    } catch { /* no usable cache */ }
  }
  if (now - table.fetchedAt < MAX_AGE_MS || now - attemptedAt < RETRY_MS || typeof fetchImpl !== 'function') return table;
  if (pending) return pending;
  attemptedAt = now;
  pending = (async () => {
    try {
      const response = await fetchImpl(OPENROUTER_MODELS_URL, { headers: { Accept: 'application/json' } });
      if (!response.ok) return table;
      const models = parseOpenRouterModels(await response.json());
      if (Object.keys(models).length === 0) return table;
      table = { fetchedAt: now, models };
      if (path) {
        mkdirSync(home, { recursive: true });
        writeFileSync(`${path}.tmp`, JSON.stringify({ version: VERSION, ...table }));
        renameSync(`${path}.tmp`, path);
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
 * The table before a model lookup or a priced call: an empty table waits up to
 * `timeoutMs` for the listing, a stale one refreshes in the background. Waits at
 * most once per retry window, so an unreachable listing never stalls every call.
 */
export async function ensureOpenRouterModels({ timeoutMs = FORCED_LOAD_TIMEOUT_MS, ...options } = {}) {
  const refresh = refreshOpenRouterModels(options);
  if (Object.keys(table.models).length > 0) return table;
  let timer;
  await Promise.race([refresh, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); })]);
  clearTimeout(timer);
  return table;
}
