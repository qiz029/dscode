// Model providers `/provider` switches between. DeepSeek's official API is the
// native `llm-deepseek` route; OpenRouter is DSCODE's own adapter
// (plugins/openrouter), which serves OpenRouter's live model listing and is always
// registered, as are the Grok and OpenCode Go routes. This module ships beside the TUI too, so it imports nothing.

export const PROVIDERS = Object.freeze([
  { id: 'deepseek-official', name: 'DeepSeek', aliases: ['deepseek', 'deepseek-official', 'official'], credentialRef: 'DEEPSEEK_API_KEY', defaultModel: 'deepseek-flash' },
  // The optional management key reads account data only; it cannot call models.
  { id: 'openrouter', name: 'OpenRouter', aliases: ['openrouter', 'open-router'], credentialRef: 'OPENROUTER_API_KEY', managementRef: 'OPENROUTER_MANAGEMENT_KEY', defaultModel: 'deepseek/deepseek-v4-flash' },
  // The Grok subscription rail: the token is the local 'grok login', read-only (plugins/grok).
  { id: 'grok', name: 'Grok', aliases: ['grok', 'xai', 'x-ai'], credentialRef: 'GROK_CLI_TOKEN', defaultModel: 'grok-4.6' },
  // The OpenCode Go subscription: its chat-completions models, authorised only by an OpenCode
  // account login. `login` names the command that sets the credential up; there is no key to paste.
  { id: 'opencode-go', name: 'OpenCode Go', aliases: ['opencode-go', 'opencode', 'go'], credentialRef: 'OPENCODE_OAUTH', login: '/opencode login', defaultModel: 'kimi-k3' },
]);

// The pi-ai adapter served OpenRouter until 0.7.6, from this settings section.
const PI_AI_NS = 'llm-pi-ai';

// OpenRouter serves DeepSeek V4 thinking as none/high/xhigh. DeepSeek itself
// answers `low` as high and `max` as xhigh, so the route offers the official
// low/high/max detents (and Ultra on top of max) with the wire spelling OpenRouter
// accepts; session cards and delegated children that ask for `low` keep working.
export const OPENROUTER_EFFORTS = Object.freeze({ off: 'none', low: 'high', high: 'high', max: 'xhigh' });

/** The DeepSeek models the OpenRouter route serves, with their official-route counterparts. */
export const OPENROUTER_MODELS = Object.freeze([
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', official: ['deepseek-flash', 'deepseek-v4-flash'] },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', official: ['deepseek-v4-pro'] },
  { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', official: ['deepseek-v4-flash-vision-exp'] },
]);

/**
 * Remove the `openrouter` profile earlier builds wrote into the pi-ai section. The
 * pi-ai adapter is no longer mounted, so the profile is inert, and it would claim the
 * route a second time if that adapter were ever mounted again.
 * Never throws: /model and /provider must open regardless.
 * @returns whether the settings changed.
 */
export async function migrateOpenRouterProfile(settings) {
  try {
    const descriptor = settings?.describe?.({ redactSecrets: true }).find(entry => entry.ns === PI_AI_NS);
    if (!descriptor || settings.writable !== true || descriptor.value?.providers?.openrouter === undefined) return false;
    await settings.mutate(PI_AI_NS, [{ op: 'unset', path: ['providers', 'openrouter'] }], descriptor.revision);
    return true;
  } catch {
    return false;
  }
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

// OpenCode Go names DeepSeek models by the official ids, without OpenRouter's vendor segment.
const OPENCODE_GO_OFFICIAL = Object.freeze({ 'deepseek-flash': 'deepseek-v4-flash' });

function counterpart(from, model, to) {
  if (from === to) return model;
  if (from === 'deepseek-official' && to === 'openrouter') return OPENROUTER_MODELS.find(entry => entry.official.includes(model))?.id;
  if (from === 'openrouter' && to === 'deepseek-official') return OPENROUTER_MODELS.find(entry => entry.id === model)?.official[0];
  if (from === 'deepseek-official' && to === 'opencode-go') return OPENCODE_GO_OFFICIAL[model] ?? model;
  if (from === 'opencode-go' && to === 'deepseek-official') return model;
  // OpenRouter's `vendor/model` ids mostly end in Go's own id.
  if (from === 'openrouter' && to === 'opencode-go') return model.slice(model.indexOf('/') + 1);
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
 * @returns `saved`, `env`, `account` (signed in with an account instead of a key), `missing`,
 *   `readonly` (an empty read-only source), `error`, or `unavailable` (no row).
 */
export function credentialState(row) {
  if (!row) return 'unavailable';
  const credential = row.credential;
  if (credential?.kind === 'error') return 'error';
  if (credential?.kind !== 'facts') return 'missing';
  if (credential.configured) return credential.source === 'env' ? 'env' : credential.source === 'account' ? 'account' : 'saved';
  return credential.writable ? 'missing' : 'readonly';
}

/**
 * Prepare a provider before a switch. Both routes are always registered; switching
 * to OpenRouter only clears the inert pi-ai profile earlier builds wrote.
 * @param settings - the host settings service.
 * @returns whether the settings changed.
 */
export async function ensureProviderRoute(settings, provider) {
  return provider === 'openrouter' ? migrateOpenRouterProfile(settings) : false;
}

/** Wait for a route's models to reach the model directory. */
export async function waitForModels(loadModels, provider, { attempts = 30, delayMs = 100 } = {}) {
  let directory;
  for (let attempt = 0; attempt < attempts; attempt++) {
    directory = await loadModels();
    if (directory.rows.some(row => row.provider === provider)) return directory;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return directory;
}
