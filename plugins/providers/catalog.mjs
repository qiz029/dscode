// Model providers `/provider` switches between. DeepSeek's official API is the
// native `llm-deepseek` route; OpenRouter reaches the same DeepSeek models
// through pi-ai's catalog route, which the base composition mounts dormant until
// a `llm-pi-ai:` settings section declares it.

export const PROVIDERS = Object.freeze([
  { id: 'deepseek-official', name: 'DeepSeek', aliases: ['deepseek', 'deepseek-official', 'official'], credentialRef: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-flash' },
  { id: 'openrouter', name: 'OpenRouter', aliases: ['openrouter', 'open-router'], credentialRef: 'OPENROUTER_API_KEY', defaultModel: 'deepseek/deepseek-v4-flash' },
]);

const PI_AI_NS = 'llm-pi-ai';

// OpenRouter serves DeepSeek V4 thinking as none/high/xhigh. DeepSeek itself
// answers `low` as high and `max` as xhigh, so the route offers the official
// low/high/max detents (and Ultra on top of max) with the wire spelling OpenRouter
// accepts; session cards and delegated children that ask for `low` keep working.
const OPENROUTER_EFFORTS = Object.freeze({ off: 'none', low: 'high', high: 'high', max: 'xhigh' });

/** The DeepSeek models the OpenRouter route declares, with their official-route counterparts. */
export const OPENROUTER_MODELS = Object.freeze([
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', official: ['deepseek-flash', 'deepseek-v4-flash'] },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', official: ['deepseek-v4-pro'] },
  { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', official: ['deepseek-v4-flash-vision-exp'] },
]);

/** The `llm-pi-ai` profile `/provider openrouter` writes: installed-catalog models narrowed to DeepSeek. */
export function openRouterProfile() {
  return {
    displayName: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    // Like the official route, requests default to high; it also gives /effort the DSCODE detent bar.
    reasoning: 'high',
    models: OPENROUTER_MODELS.map(({ id, name }) => ({ id, name, reasoningEfforts: { ...OPENROUTER_EFFORTS } })),
  };
}

export function providerSpec(id) {
  return PROVIDERS.find(provider => provider.id === id);
}

/**
 * Resolve a `/provider` or `/login` argument.
 * @param raw - text after the command name.
 * @returns a provider id, `undefined` for no argument, or `null` when unrecognized. Callers must not echo the text: it may be a pasted key.
 */
export function providerArgument(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') return undefined;
  return PROVIDERS.find(provider => provider.aliases.includes(value))?.id ?? null;
}

/** Split a `provider/model` label at the first slash: OpenRouter model ids carry their own `vendor/` segment. */
export function splitModelLabel(label) {
  const text = typeof label === 'string' ? label : '';
  const cut = text.indexOf('/');
  return cut > 0 ? { provider: text.slice(0, cut), model: text.slice(cut + 1) } : { provider: '', model: text };
}

/** The switchable provider a label names, defaulting to DeepSeek for unknown or bare labels. */
export function providerOfLabel(label) {
  return providerSpec(splitModelLabel(label).provider)?.id ?? PROVIDERS[0].id;
}

/** Provider id leading a footer header (`provider: model @ effort`), if any. */
export function providerOfHeader(header) {
  return typeof header === 'string' ? header.match(/^([^\s:/]+): /)?.[1] : undefined;
}

function counterpart(from, model, to) {
  if (from === to) return model;
  if (from === 'deepseek-official' && to === 'openrouter') return OPENROUTER_MODELS.find(entry => entry.official.includes(model))?.id;
  if (from === 'openrouter' && to === 'deepseek-official') return OPENROUTER_MODELS.find(entry => entry.id === model)?.official[0];
  return undefined;
}

/**
 * The model a provider switch lands on: the current model's counterpart, else the
 * provider default, else its first model. The effort carries over only when the
 * target offers it; otherwise the model's own default applies.
 * @param rows - model directory rows (`provider`, `model`, `reasoning`).
 * @returns `{ row, effort }`, or `undefined` when the provider serves no model yet.
 */
export function pickModel(rows, provider, currentLabel, effort) {
  const candidates = rows.filter(row => row.provider === provider);
  if (candidates.length === 0) return undefined;
  const current = splitModelLabel(currentLabel);
  const wanted = counterpart(current.provider, current.model, provider);
  const row = candidates.find(candidate => candidate.model === wanted)
    ?? candidates.find(candidate => candidate.model === providerSpec(provider)?.defaultModel)
    ?? candidates[0];
  const offered = row.reasoning?.efforts.map(level => level.id) ?? [];
  return { row, effort: effort && offered.includes(effort) ? effort : undefined };
}

/**
 * Credential status of a provider-settings row.
 * @returns `saved`, `env`, `missing`, `readonly` (an empty read-only source), `error`, or `unavailable` (no row).
 */
export function credentialState(row) {
  if (!row) return 'unavailable';
  const credential = row.credential;
  if (credential?.kind === 'error') return 'error';
  if (credential?.kind !== 'facts') return 'missing';
  if (credential.configured) return credential.source === 'env' ? 'env' : 'saved';
  return credential.writable ? 'missing' : 'readonly';
}

/**
 * Declare a provider's route before it is used. Only OpenRouter needs one; a
 * profile the user already has (their own models or endpoint) is left alone.
 * @param settings - the host settings service.
 * @returns whether the settings changed.
 */
export async function ensureProviderRoute(settings, provider) {
  if (provider !== 'openrouter') return false;
  if (typeof settings?.describe !== 'function' || typeof settings.mutate !== 'function') throw new Error('settings are unavailable; OpenRouter cannot be configured in this profile');
  const descriptor = settings.describe({ redactSecrets: true }).find(entry => entry.ns === PI_AI_NS);
  if (!descriptor) throw new Error('the OpenRouter adapter (llm-pi-ai) is not mounted in this profile');
  if (descriptor.value?.providers?.openrouter !== undefined) return false;
  if (settings.writable !== true) throw new Error('settings are read-only; OpenRouter cannot be configured here');
  await settings.mutate(PI_AI_NS, [{ op: 'set', path: ['providers', 'openrouter'], value: openRouterProfile() }], descriptor.revision);
  return true;
}

/** Wait for a freshly declared route to reach the model directory. */
export async function waitForModels(loadModels, provider, { attempts = 30, delayMs = 100 } = {}) {
  let directory;
  for (let attempt = 0; attempt < attempts; attempt++) {
    directory = await loadModels();
    if (directory.rows.some(row => row.provider === provider)) return directory;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return directory;
}
