// OpenRouter account facts for /openrouter and the footer balance. The inference key
// reads the account credits and its own limit and usage; an optional management key,
// which cannot call models, adds every key's usage and the last 30 days of spend.
// This directory also ships beside the TUI, so the module imports nothing.
export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
export const MANAGEMENT_REF = 'OPENROUTER_MANAGEMENT_KEY';

const finite = value => {
  const number = Number(value);
  return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : undefined;
};

export class OpenRouterAccountError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'OpenRouterAccountError';
    this.status = status;
  }
}

async function get(path, key, { fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(`${OPENROUTER_API}${path}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' }, signal });
  } catch (error) {
    throw new OpenRouterAccountError(`OpenRouter is unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) throw new OpenRouterAccountError(typeof body?.error?.message === 'string' ? body.error.message : `HTTP ${response.status}`, response.status);
  return body;
}

/** Account credits from a `/credits` body, or undefined when it carries none. */
export function creditsOf(body) {
  const total = finite(body?.data?.total_credits), used = finite(body?.data?.total_usage);
  if (total === undefined || used === undefined || total < 0 || used < 0) return undefined;
  return { total, used, remaining: Math.max(0, total - used) };
}

/** Remaining USD account credits from a `/credits` body: purchased minus used. */
export function parseOpenRouterCredits(body) {
  return creditsOf(body)?.remaining ?? null;
}

/** Remaining USD credit limit from a `/key` body; null when the key has no limit. */
export function parseOpenRouterKeyRemaining(body) {
  const remaining = body?.data?.limit_remaining;
  if (remaining == null) return null;
  const value = Number(remaining);
  return Number.isFinite(value) ? Math.max(0, value) : null;
}

function keyOf(raw) {
  return {
    label: typeof raw?.label === 'string' ? raw.label : undefined,
    name: typeof raw?.name === 'string' && raw.name.length > 0 ? raw.name : undefined,
    disabled: raw?.disabled === true,
    limit: finite(raw?.limit),
    limitRemaining: finite(raw?.limit_remaining),
    usage: finite(raw?.usage),
    usageDaily: finite(raw?.usage_daily),
    usageWeekly: finite(raw?.usage_weekly),
    usageMonthly: finite(raw?.usage_monthly),
  };
}

/**
 * Verify a management key before it is stored. Account activity is the reading OpenRouter
 * refuses an inference key; `/credits`, though documented as management-only, serves both.
 * @throws OpenRouterAccountError with a message fit for the key prompt.
 */
export async function verifyManagementKey(key, options) {
  try {
    await get('/activity', key, options);
  } catch (error) {
    if (error instanceof OpenRouterAccountError && (error.status === 401 || error.status === 403)) {
      throw new OpenRouterAccountError('This is not a management key: OpenRouter refused it for account data. Create one under Settings → Management keys.', error.status);
    }
    throw error;
  }
}

/** The `/activity` rows (last 30 completed UTC days) as totals and the top models with the providers that served them. */
export function summarizeActivity(rows, top = 5) {
  const models = new Map(), days = new Set();
  let usage = 0, requests = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row?.model !== 'string') continue;
    const cost = finite(row.usage) ?? 0, count = finite(row.requests) ?? 0;
    usage += cost;
    requests += count;
    if (typeof row.date === 'string') days.add(row.date);
    const entry = models.get(row.model) ?? { model: row.model, usage: 0, requests: 0, providers: new Map() };
    entry.usage += cost;
    entry.requests += count;
    const name = typeof row.provider_name === 'string' && row.provider_name.length > 0 ? row.provider_name : 'unknown';
    const served = entry.providers.get(name) ?? { name, usage: 0, requests: 0 };
    served.usage += cost;
    served.requests += count;
    entry.providers.set(name, served);
    models.set(row.model, entry);
  }
  const ranked = [...models.values()].sort((left, right) => right.usage - left.usage || right.requests - left.requests).slice(0, top)
    .map(entry => ({ ...entry, providers: [...entry.providers.values()].sort((left, right) => right.usage - left.usage) }));
  return { usage, requests, days: days.size, modelCount: models.size, models: ranked };
}

/**
 * Everything /openrouter shows. Each section settles on its own: `{ value }`, `{ error }`,
 * or undefined when the key it needs is missing.
 */
export async function loadOpenRouterAccount({ apiKey, managementKey, fetch, signal } = {}) {
  const options = { fetch, signal };
  const section = (key, run) => key ? run().then(value => ({ value }), error => ({ error: error instanceof Error ? error.message : String(error) })) : Promise.resolve(undefined);
  const [key, credits, keys, activity] = await Promise.all([
    section(apiKey, async () => keyOf((await get('/key', apiKey, options))?.data)),
    section(managementKey ?? apiKey, async () => {
      const credits = creditsOf(await get('/credits', managementKey ?? apiKey, options));
      if (!credits) throw new Error('OpenRouter returned no account credits');
      return credits;
    }),
    section(managementKey, async () => {
      const body = await get('/keys', managementKey, options);
      return (Array.isArray(body?.data) ? body.data : []).map(keyOf);
    }),
    section(managementKey, async () => summarizeActivity((await get('/activity', managementKey, options))?.data)),
  ]);
  return { hasApiKey: Boolean(apiKey), hasManagementKey: Boolean(managementKey), key, credits, keys, activity };
}

const money = value => Number.isFinite(value) ? `$${value.toFixed(2)}` : '$--';
const limitText = key => key.limit === undefined ? 'no limit' : `limit ${money(key.limit)}, ${money(key.limitRemaining)} left`;

/**
 * The panel's lines for a loaded account.
 * @returns `{ text, tone }` rows; tone is `title`, `value`, `dim` or `error`.
 */
export function openRouterAccountLines(account, { maxKeys = 5 } = {}) {
  const lines = [];
  const push = (text, tone = 'value') => lines.push({ text, tone });
  if (!account.hasApiKey) push('No OpenRouter API key: run /login openrouter.', 'error');
  if (account.credits?.value) {
    const { remaining, total, used } = account.credits.value;
    push(`Account balance  ${money(remaining)} · credits ${money(total)} · used ${money(used)}`, 'title');
  } else if (account.credits?.error) push(`Account balance unavailable: ${account.credits.error}`, 'error');
  else push('Account balance  $--', 'dim');
  if (account.key?.value) {
    const key = account.key.value;
    push(`This key  ${key.label ?? 'unnamed'} · ${limitText(key)}`, 'title');
    push(`  today ${money(key.usageDaily)} · week ${money(key.usageWeekly)} · month ${money(key.usageMonthly)}`, 'dim');
  } else if (account.key?.error) push(`This key unavailable: ${account.key.error}`, 'error');
  if (!account.hasManagementKey) push('API keys and 30-day spend  press m to add a management key', 'dim');
  if (account.keys?.value) {
    const keys = [...account.keys.value].sort((left, right) => (right.usageMonthly ?? 0) - (left.usageMonthly ?? 0));
    push(`API keys (${keys.length})`, 'title');
    for (const key of keys.slice(0, maxKeys)) {
      const current = account.key?.value?.label !== undefined && key.label === account.key.value.label;
      push(`  ${key.name ?? key.label ?? 'unnamed'}${current ? ' (this key)' : ''}${key.disabled ? ' · disabled' : ''} · today ${money(key.usageDaily)} · month ${money(key.usageMonthly)} · ${limitText(key)}`, key.disabled ? 'dim' : 'value');
    }
    if (keys.length > maxKeys) push(`  +${keys.length - maxKeys} more`, 'dim');
  } else if (account.keys?.error) push(`API keys unavailable: ${account.keys.error}`, 'error');
  if (account.activity?.value) {
    const activity = account.activity.value;
    push(`Last 30 days  ${money(activity.usage)} · ${activity.requests} requests · ${activity.modelCount} models`, 'title');
    for (const model of activity.models) {
      push(`  ${model.model} · ${money(model.usage)} · ${model.requests} req · ${model.providers.map(provider => `${provider.name} ${money(provider.usage)}`).join(', ')}`);
    }
  } else if (account.activity?.error) push(`Activity unavailable: ${account.activity.error}`, 'error');
  return lines;
}
