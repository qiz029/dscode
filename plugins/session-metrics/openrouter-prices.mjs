import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// OpenRouter list prices for every model it serves, read from its public model
// listing (no key needed) and kept for a day in DSH_HOME, so any OpenRouter model
// can be priced. The listing quotes USD per token; the table keeps USD per million.
export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const FILE = 'openrouter-prices.json';
let table = { fetchedAt: 0, models: {} };
let attemptedAt = 0, pending;

const perMillion = value => {
  const number = Number(value);
  return value != null && value !== '' && Number.isFinite(number) && number >= 0 ? number * 1e6 : undefined;
};
const ratesOf = pricing => {
  const input = perMillion(pricing?.prompt), output = perMillion(pricing?.completion);
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cacheRead: perMillion(pricing.input_cache_read), cacheWrite: perMillion(pricing.input_cache_write) };
};

/**
 * Per-model prices from an OpenRouter `/models` body.
 * @returns `{ [id]: { input, output, cacheRead?, cacheWrite?, tiers? } }` in USD per million tokens;
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
    models[model.id] = { ...base, ...(tiers.length ? { tiers } : {}) };
  }
  return models;
}

/** Prices for one model at a request's prompt size, or undefined when the table lists none. */
export function openRouterRates(model, promptTokens = 0) {
  const entry = table.models[model];
  if (!entry) return undefined;
  return entry.tiers?.findLast(tier => promptTokens >= tier.minPromptTokens) ?? entry;
}

/** Version stamp for rows priced from the live table: the day it was fetched. */
export function openRouterPriceVersion() {
  return table.fetchedAt > 0 ? `openrouter-models-${new Date(table.fetchedAt).toISOString().slice(0, 10)}` : undefined;
}

/** Replace the table (and forget the last attempt); for tests and cache loads. */
export function setOpenRouterPrices(models, fetchedAt = Date.now()) {
  table = { fetchedAt, models };
  attemptedAt = 0;
}

/**
 * Load the cached table, then refetch it once it is a day old. A failure keeps the
 * last table and waits ten minutes before trying again; never throws.
 */
export async function refreshOpenRouterPrices({ home, fetch: fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const path = home ? join(home, FILE) : undefined;
  if (table.fetchedAt === 0 && path) {
    try {
      const cached = JSON.parse(readFileSync(path, 'utf8'));
      if (Number.isFinite(cached?.fetchedAt) && cached.models && typeof cached.models === 'object') table = { fetchedAt: cached.fetchedAt, models: cached.models };
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
        writeFileSync(`${path}.tmp`, JSON.stringify(table));
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
