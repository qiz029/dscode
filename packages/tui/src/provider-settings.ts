/**
 * Provider settings adapter for the TUI `/model` provider-management panel:
 * the same-process equivalent of the web host's Models page join
 * (`packages/client/ui-settings-models`), reading the advisory `ctx.llm`
 * registry, the redacted `ctx.settings` descriptors, and the value-free
 * `ctx.credentials` facts directly. Secrets never cross this module: settings
 * are read with `redactSecrets: true`, credentials are only ever described
 * (never resolved), and every message is single-line without embedding key
 * data.
 *
 * @module @deepseek-ai/dsh-tui/provider-settings
 */

import type { Context } from '@deepseek-ai/cordis'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'

/* ------------------------------------------------------------------ *
 * Structural service faces. Branding is erased at runtime, so credential
 * refs and settings namespaces are plain strings here; they originate only
 * from trusted settings descriptors or the validated derivation below.
 * Declaring the faces locally keeps this a dependency-free adapter over
 * `ctx.get(...)` — the settings and credentials packages are never imported.
 * ------------------------------------------------------------------ */

/** The subset of the `llm` service this module reads. */
interface LlmFace {
  /** Registered provider routes with a live adapter (`listProviders()`). */
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  /** Declared configurable-provider directory; absent on an older service. */
  listConfigurableProviders?(): readonly {
    readonly provider: string
    readonly displayName: string
    readonly settingsNs: string
    readonly settingsPath: readonly string[]
    readonly declared?: boolean
    /** Configuration diagnostic for repair; unaffected models may remain serviceable. */
    readonly error?: string
  }[]
  /**
   * Registered endpoint model discovery; absent on an older service. The
   * request is a draft (provider route and/or baseURL, optional one-shot
   * key); the reply is candidate metadata for adoption, never a write.
   */
  discoverModels?(
    settingsNs: string,
    request: { readonly provider?: string; readonly baseURL?: string; readonly api?: string; readonly apiKey?: string },
    signal?: AbortSignal,
  ): Promise<readonly {
    readonly id: string
    readonly name?: string
    readonly contextWindow?: number
    readonly maxTokens?: number
  }[]>
}

/** One redacted settings descriptor (subset of `SettingsDescriptor`). */
interface SettingsDescriptorFace {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
  readonly base?: unknown
  readonly user?: unknown
}

/** One path-addressed edit to a stored section (subset of `SettingsPathOp`). */
interface SettingsPathOpFace {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** The subset of the `settings` service this module reads and writes. */
interface SettingsFace {
  readonly writable: boolean
  describe(options?: { readonly redactSecrets?: boolean }): readonly SettingsDescriptorFace[]
  mutate(ns: string, ops: readonly SettingsPathOpFace[], expectedRevision?: number): Promise<void>
}

/** Value-free facts about one credential reference (subset of `CredentialInfo`). */
interface CredentialFactsFace {
  readonly configured: boolean
  readonly source?: string
  readonly writable: boolean
}

/** Event subscription face used for the official Models invalidation trio. */
interface ProviderEventsFace {
  on(event: string, listener: (...args: unknown[]) => void): () => void
}

/** One resolved credential value; never rendered, never persisted by callers. */
interface CredentialValueFace {
  readonly value: string
  readonly source: string
}

/** The subset of the `credentials` service this module reads and writes. */
interface CredentialsFace {
  describe(ref: string): Promise<CredentialFactsFace>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  /** Same-process value resolution; absent on an older service. */
  resolve?(ref: string): Promise<CredentialValueFace | undefined>
}

/* ------------------------------------------------------------------ *
 * Pure helpers.
 * ------------------------------------------------------------------ */

/** Human text for a rejection value (mirrors the web page's `messageOf`). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Collapse every whitespace/control run to one space so a notice stays one line. */
function singleLine(message: string): string {
  return message.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Keep a misbehaving credential provider from reflecting the submitted secret. */
function credentialWriteMessage(error: unknown, secret: string): string {
  const message = singleLine(messageOf(error))
  return message.includes(secret) ? 'credentials service rejected the API key' : message
}

/** Obvious shell-assignment paste; mirrors the official Web Models editor. */
export const ENV_ASSIGNMENT = /^[A-Z][A-Z0-9_]*=[^=]/

/** Whether the whole draft is wrapped in one matching quote pair. */
export function hasWrappingQuotes(value: string): boolean {
  const first = value[0]
  return (first === '"' || first === '\'' || first === '`') && value.length > 1 && value.endsWith(first)
}

/** Read the value at a path through plain objects; undefined when any segment misses. */
function getPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Whether a path resolves to a defined value (the empty path reads the root). */
function hasPath(value: unknown, path: readonly string[]): boolean {
  return path.length === 0 ? value !== undefined : getPath(value, path) !== undefined
}

/** The credential reference a resolved profile names (its `apiKeyEnv` field). */
function profileRefOf(profile: unknown): string | undefined {
  if (typeof profile !== 'object' || profile === null) return undefined
  const ref = (profile as { readonly apiKeyEnv?: unknown }).apiKeyEnv
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/** Extract only fields the terminal can round-trip without touching provider-specific extras. */
function configurationOf(profile: unknown): ProviderConfiguration {
  if (typeof profile !== 'object' || profile === null) return { models: [] }
  const record = profile as Record<string, unknown>
  const source = Array.isArray(record.models) ? record.models : []
  const models = source.flatMap((value): ProviderModelSettings[] => {
    if (typeof value !== 'object' || value === null) return []
    const entry = value as Record<string, unknown>
    if (typeof entry.id !== 'string' || entry.id.trim() === '') return []
    // Fields the editor does not understand ride along untouched: dropping
    // them here would let the next save strip hand-written reasoningEfforts
    // or compat declarations out of the stored profile.
    const { id: _id, name: _name, contextWindow: _contextWindow, maxTokens: _maxTokens, ...extras } = entry
    return [{
      id: entry.id,
      ...(typeof entry.name === 'string' && entry.name.trim() !== '' ? { name: entry.name } : {}),
      ...(typeof entry.contextWindow === 'number' && Number.isFinite(entry.contextWindow) ? { contextWindow: entry.contextWindow } : {}),
      ...(typeof entry.maxTokens === 'number' && Number.isFinite(entry.maxTokens) ? { maxTokens: entry.maxTokens } : {}),
      ...Object.keys(extras).length > 0 ? { extras } : {},
    }]
  })
  return {
    ...(typeof record.baseURL === 'string' && record.baseURL.trim() !== '' ? { baseURL: record.baseURL } : {}),
    ...(typeof record.api === 'string' && record.api.trim() !== '' ? { api: record.api } : {}),
    models,
  }
}

/* ------------------------------------------------------------------ *
 * Exported contracts.
 * ------------------------------------------------------------------ */

/**
 * The conventional credential reference for a provider route: `<ROUTE>_API_KEY`
 * with the route uppercased and every non-alphanumeric run collapsed to one
 * underscore — the exact derivation the official Models page uses
 * (`deriveKeyRef` in `ui-settings-models`), so a key saved here is found there.
 * @param provider - provider route id (e.g. `pi-ai`, `minimax-cn`).
 * @returns the derived reference name (e.g. `PI_AI_API_KEY`).
 */
export function deriveCredentialRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Value-free facts about one credential reference — never the value. */
export interface ProviderCredentialFacts {
  /** Whether the reference currently resolves to a stored value. */
  readonly configured: boolean
  /** Source layer supplying the value; absent while unconfigured. */
  readonly source?: string
  /** Whether a write through this panel would currently succeed. */
  readonly writable: boolean
}

/**
 * One row's credential state: value-free facts once the reference was
 * described, a bounded error when that describe failed (the row itself is
 * never dropped), or `undefined` when the row names no reference to describe —
 * an unmanaged active provider, a dormant route, or a profile authenticating
 * through the provider's own path.
 */
export type ProviderCredentialView =
  | ({ readonly kind: 'facts' } & ProviderCredentialFacts)
  | { readonly kind: 'error'; readonly message: string }

/** One explicit model enabled for a provider profile. */
export interface ProviderModelSettings {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  /**
   * Remaining entry fields the editor does not model (`reasoningEfforts`,
   * `compat`, `input`, …), carried verbatim so a save preserves them.
   * Populated by {@link loadProviderSettings}; never contains the four
   * modelled keys.
   */
  readonly extras?: Readonly<Record<string, unknown>>
}

/** The small, portable subset of a provider profile the terminal edits. */
export interface ProviderConfiguration {
  readonly baseURL?: string
  /**
   * Wire protocol the stored profile names (e.g. `openai-responses`), when it
   * names one. Load-only: the editor never writes it, but endpoint discovery
   * passes it so the listing speaks the same protocol as real requests.
   */
  readonly api?: string
  readonly models: readonly ProviderModelSettings[]
}

/** One model an endpoint reported about itself (mirrors `LlmDiscoveredModel`). */
export interface DiscoveredModelView {
  /** Model id the endpoint accepts. */
  readonly id: string
  /** Human-readable name when the endpoint supplies one. */
  readonly name?: string
  /** Context window when disclosed; adoption still owes it if absent. */
  readonly contextWindow?: number
  /** Output cap when disclosed. */
  readonly maxTokens?: number
}

/**
 * The seven canonical reasoning levels a reasoningEfforts key may name -
 * pi-ai's THINKING_LEVELS. A pi-ai upgrade that adds or removes one fails
 * upstream's own drift gate; this mirror exists so the terminal editor can
 * validate drafts without importing the pi-ai package.
 */
export const REASONING_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * One stored reasoningEfforts declaration: a display-level to wire-value map
 * (null sends no reasoning parameter), an explicit false disabling the
 * picker, or undefined leaving the entry to inherit.
 */
export type ReasoningEffortsValue = Record<string, string | null> | false | undefined

/** Whether a raw extras value is a declared efforts dict (non-empty, non-false). */
export function isDeclaredReasoningEfforts(value: unknown): value is Record<string, string | null> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

/**
 * Parse the setup page's compact efforts draft into a storable declaration.
 * Grammar: empty = clear back to inherit; the single token "false" = disable
 * the picker; otherwise space-separated level:wire pairs where level is one
 * of REASONING_EFFORT_LEVELS and wire is any non-empty string or the literal
 * "null" (send no parameter).
 */
export function parseReasoningEffortsDraft(draft: string):
  | { readonly ok: true; readonly value: ReasoningEffortsValue }
  | { readonly ok: false; readonly error: string } {
  const text = draft.trim()
  if (text === '') return { ok: true, value: undefined }
  if (text === 'false') return { ok: true, value: false }
  const value: Record<string, string | null> = {}
  for (const token of text.split(/\s+/u)) {
    const split = token.indexOf(':')
    if (split <= 0 || split === token.length - 1) {
      return { ok: false, error: 'each entry needs level:wire, got "' + token + '"' }
    }
    const level = token.slice(0, split)
    const wire = token.slice(split + 1)
    if (!(REASONING_EFFORT_LEVELS as readonly string[]).includes(level)) {
      return { ok: false, error: '"' + level + '" is not a level; use one of ' + REASONING_EFFORT_LEVELS.join('/') }
    }
    if (level in value) {
      return { ok: false, error: 'level "' + level + '" appears twice' }
    }
    value[level] = wire === 'null' ? null : wire
  }
  return { ok: true, value }
}

/** Serialize a stored declaration back to the compact draft form (stored key order preserved). */
export function serializeReasoningEfforts(value: unknown): string {
  if (value === false) return 'false'
  if (!isDeclaredReasoningEfforts(value)) return ''
  return Object.entries(value)
    .map(([level, wire]) => level + ':' + (wire === null ? 'null' : String(wire)))
    .join(' ')
}

/**
 * One provider row in the TUI provider-management panel: the configurable
 * directory entry joined with its settings profile and credential facts.
 * Every mutation below addresses this row, and the caller passes the row back
 * after re-loading so the revision/ref facts are current.
 */
export interface ProviderTargetView {
  /** Provider route id (`GenerateOptions.provider`). */
  readonly provider: string
  /** Human-readable provider name. */
  readonly displayName: string
  /** Whether an adapter currently serves this route. */
  readonly active: boolean
  /** User-settings namespace whose section configures this provider; '' when unmanaged. */
  readonly settingsNs: string
  /** Path from that section's root to this provider's profile; [] when the whole section is the profile. */
  readonly settingsPath: readonly string[]
  /** Revision of the owning settings section at load (0 when no namespace resolved). */
  readonly settingsRevision: number
  /** Whether the resolved profile exists (the whole section, or at `settingsPath`). */
  readonly configured: boolean
  /** Whether only the user settings layer carries the profile, so removal restores the base. */
  readonly removable: boolean
  /** The credential reference the resolved profile names, when one does. */
  readonly credentialRef?: string
  /** The conventional reference a save uses for a dormant or ref-less profile. */
  readonly suggestedRef: string
  /** Credential facts, a bounded describe error, or undefined when there is no ref to describe. */
  readonly credential: ProviderCredentialView | undefined
  /** Endpoint and explicit model overrides visible to the provider editor. */
  readonly configuration: ProviderConfiguration
  /** The owning adapter reports this route as hand-declared (absent when it draws no distinction). */
  readonly declared?: boolean
  /**
   * Configuration diagnostic the adapter reported for this route (catalog or
   * profile damage): the row stays listed and repairable instead of the whole
   * provider vanishing; absent when the route reads clean.
   */
  readonly diagnostic?: string
}

/** The resolved provider/settings/credential join. */
export interface ProviderSettingsDirectory {
  /** Provider rows: configurable-directory order first, active-unmanaged rows after. */
  readonly rows: readonly ProviderTargetView[]
  /** Whether the settings provider accepts writes (mirrors the web page's flag). */
  readonly writable: boolean
  /** Non-fatal join failures (settings/directory reads), for a degradation notice. */
  readonly failures: readonly string[]
}

/** Events that invalidate the official Models provider/settings/credential join. */
const PROVIDER_SETTINGS_EVENTS = [
  'credentials/reference-updated',
  'settings/document-updated',
  'llm/adapters-updated',
] as const

/** Subscribe to the same provider-directory invalidations as the official Web Models page. */
export function subscribeProviderSettings(ctx: Context, listener: () => void): () => void {
  const events = ctx as unknown as ProviderEventsFace
  const disposers = PROVIDER_SETTINGS_EVENTS.map(event => events.on(event, () => listener()))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** A single-line, bounded error from the provider-management adapter. */
export class ProviderSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderSettingsError'
  }
}

/* ------------------------------------------------------------------ *
 * Load.
 * ------------------------------------------------------------------ */

/**
 * Join the configurable-provider directory, the redacted settings
 * namespaces, and the referenced credentials into panel rows, web-parity:
 * - directory entries merge with `listProviders()` to mark each live or
 *   dormant, and routes registered without a directory declaration appear as
 *   read-only/unmanaged rows (no settings address);
 * - a whole-section entry is configured whenever its namespace resolves;
 *   a path-addressed one only when the profile resolves there;
 * - a row is removable when the user layer alone carries its profile;
 * - only refs named by resolved profiles are described, and a per-ref failure
 *   degrades to that row's bounded error instead of losing it.
 * Absent `settings`/`credentials` services are tolerated the same way.
 * @param ctx - context carrying the `llm` service (settings/credentials optional).
 * @returns the resolved directory; empty rows when `llm` is unavailable.
 */
export async function loadProviderSettings(ctx: Context): Promise<ProviderSettingsDirectory> {
  const llm = ctx.get('llm') as LlmFace | undefined
  if (llm === undefined) return { rows: [], writable: false, failures: [] }
  // Call listProviders/listConfigurableProviders AS METHODS: destructured off
  // the service they lose `this` and throw on the first read (same lesson as
  // loadModelDirectory).
  const registered = llm.listProviders()
  const failures: string[] = []
  const directoryEntries: Array<{
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
    error?: string
  }> = []
  if (llm.listConfigurableProviders !== undefined) {
    try {
      directoryEntries.push(...llm.listConfigurableProviders())
    } catch (error) {
      failures.push(`configurable-provider directory failed: ${singleLine(messageOf(error))}`)
    }
  }
  const settings = ctx.get('settings') as SettingsFace | undefined
  let descriptors: readonly SettingsDescriptorFace[] = []
  let writable = false
  if (settings !== undefined) {
    try {
      descriptors = settings.describe({ redactSecrets: true })
      writable = settings.writable === true
    } catch (error) {
      failures.push(`settings describe failed: ${singleLine(messageOf(error))}`)
    }
  }
  const namespaces = new Map(descriptors.map(descriptor => [descriptor.ns, descriptor] as const))
  const active = new Set(registered.map(provider => provider.id))
  const declared = new Set(directoryEntries.map(entry => entry.provider))
  // Directory order first, then registered-but-undeclared routes (web parity:
  // they exist and serve models, just with no settings address).
  const bases: Array<{
    provider: string
    displayName: string
    active: boolean
    settingsNs: string
    settingsPath: readonly string[]
    declared?: boolean
    error?: string
  }> = [
    ...directoryEntries.map(entry => ({
      provider: entry.provider,
      displayName: entry.displayName,
      active: active.has(entry.provider),
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath,
      ...entry.declared === undefined ? {} : { declared: entry.declared },
      ...entry.error === undefined ? {} : { error: singleLine(entry.error) },
    })),
    ...registered
      .filter(provider => !declared.has(provider.id))
      .map(provider => ({
        provider: provider.id,
        displayName: provider.name,
        active: true,
        settingsNs: '',
        settingsPath: [] as readonly string[],
      })),
  ]
  const rows: Array<Omit<ProviderTargetView, 'credential'>> = bases.map((base) => {
    const namespace = base.settingsNs.length === 0 ? undefined : namespaces.get(base.settingsNs)
    const profile = namespace === undefined
      ? undefined
      : base.settingsPath.length === 0
        ? namespace.value
        : getPath(namespace.value, base.settingsPath)
    const configured = namespace !== undefined
      && (base.settingsPath.length === 0 || profile !== undefined)
    const removable = namespace !== undefined
      && base.settingsPath.length > 0
      && hasPath(namespace.user, base.settingsPath)
      && !hasPath(namespace.base, base.settingsPath)
    const credentialRef = profileRefOf(profile)
    return {
      provider: base.provider,
      displayName: base.displayName,
      active: base.active,
      settingsNs: base.settingsNs,
      settingsPath: base.settingsPath,
      settingsRevision: namespace?.revision ?? 0,
      configured,
      removable,
      configuration: configurationOf(profile),
      ...credentialRef === undefined ? {} : { credentialRef },
      suggestedRef: deriveCredentialRef(base.provider),
      ...base.declared === undefined ? {} : { declared: base.declared },
      ...base.error === undefined ? {} : { diagnostic: base.error },
    }
  })
  const refs = [...new Set(rows.flatMap(row => row.credentialRef === undefined ? [] : [row.credentialRef]))]
  const credentialViews = new Map<string, ProviderCredentialView>()
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  if (refs.length > 0) {
    if (credentials === undefined) {
      for (const ref of refs) {
        credentialViews.set(ref, { kind: 'error', message: 'credentials service is unavailable' })
      }
    } else {
      await Promise.all(refs.map(async (ref) => {
        try {
          const facts = await credentials.describe(ref)
          credentialViews.set(ref, {
            kind: 'facts',
            configured: facts.configured,
            writable: facts.writable,
            ...facts.source === undefined ? {} : { source: facts.source },
          })
        } catch (error) {
          credentialViews.set(ref, { kind: 'error', message: singleLine(messageOf(error)) })
        }
      }))
    }
  }
  return {
    rows: rows.map(row => ({
      ...row,
      credential: row.credentialRef === undefined
        ? undefined
        : credentialViews.get(row.credentialRef) ?? { kind: 'error', message: 'credential describe returned no view' },
    })),
    writable,
    failures,
  }
}

/* ------------------------------------------------------------------ *
 * Writes. Official web ordering is kept: settings.mutate first whenever a
 * profile/path or apiKeyEnv must be materialized, then credentials.set; a
 * removal unsets the managed credential before the profile. All operations
 * are idempotent, so re-running one after a partial failure is safe.
 * ------------------------------------------------------------------ */

/**
 * Store a provider API key, web-parity: validate with `normalizeApiKey`
 * (single-line, actionable errors that never echo the key), materialize the
 * profile/`apiKeyEnv` through `settings.mutate` first when the resolved
 * profile names no reference (dormant route or ref-less profile), then store
 * under the trusted named ref or the derived conventional ref. An existing
 * whole-section DeepSeek whose resolved profile already names
 * `DEEPSEEK_API_KEY` needs no settings mutation. Env-supplied read-only keys
 * are refused before any service call.
 * @param ctx - context carrying `settings` (when materializing) and `credentials`.
 * @param target - the joined row to write through.
 * @param rawKey - the key exactly as typed; surrounding whitespace is trimmed.
 * @throws {@link ProviderSettingsError} with a single-line, key-free message.
 */
export async function saveProviderCredential(ctx: Context, target: ProviderTargetView, rawKey: string): Promise<void> {
  const trimmed = rawKey.trim()
  if (ENV_ASSIGNMENT.test(trimmed) || hasWrappingQuotes(trimmed)) {
    throw new ProviderSettingsError('paste only the API key, without an environment-variable name or wrapping quotes')
  }
  const checked = normalizeApiKey(rawKey)
  if (!checked.ok) {
    throw new ProviderSettingsError(checked.reason === 'empty'
      ? 'the API key is empty after trimming surrounding whitespace'
      : 'the API key contains characters an HTTP header cannot carry; type a plain printable-ASCII key')
  }
  if (target.settingsNs.length === 0) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no managed settings namespace; configure it in settings.yaml`)
  }
  if (target.credential?.kind === 'facts' && target.credential.writable === false) {
    throw new ProviderSettingsError(`the key for provider "${target.provider}" is supplied read-only by the environment; unset it in the shell instead of overwriting it here`)
  }
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  if (credentials === undefined) {
    throw new ProviderSettingsError('credentials service is unavailable; cannot store the API key')
  }
  const ref = target.credentialRef ?? deriveCredentialRef(target.provider)
  if (target.credentialRef === undefined) {
    const settings = ctx.get('settings') as SettingsFace | undefined
    if (settings === undefined) {
      throw new ProviderSettingsError('settings service is unavailable; cannot materialize the credential reference')
    }
    try {
      await settings.mutate(target.settingsNs, [{ op: 'set', path: [...target.settingsPath, 'apiKeyEnv'], value: ref }])
    } catch (error) {
      throw new ProviderSettingsError(singleLine(messageOf(error)))
    }
  }
  try {
    await credentials.set(ref, checked.value)
  } catch (error) {
    throw new ProviderSettingsError(credentialWriteMessage(error, checked.value))
  }
}

/** Save the endpoint and an explicit model allow-list without rebuilding the profile. */
export async function saveProviderConfiguration(
  ctx: Context,
  target: ProviderTargetView,
  configuration: ProviderConfiguration,
): Promise<void> {
  if (target.settingsNs.length === 0) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no managed settings namespace; configure it in settings.yaml`)
  }
  const settings = ctx.get('settings') as SettingsFace | undefined
  if (settings === undefined || settings.writable !== true) {
    throw new ProviderSettingsError('settings are read-only; provider configuration cannot be changed here')
  }
  const baseURL = configuration.baseURL?.trim()
  if (baseURL !== undefined && baseURL !== '') {
    try {
      const parsed = new URL(baseURL)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol')
    } catch {
      throw new ProviderSettingsError('base URL must be an absolute http or https URL')
    }
  }
  const seen = new Set<string>()
  const models = configuration.models.map((model) => {
    const id = model.id.trim()
    if (id === '' || seen.has(id)) throw new ProviderSettingsError('each selected model must have a unique non-empty id')
    seen.add(id)
    for (const [label, value] of [['context window', model.contextWindow], ['output window', model.maxTokens]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new ProviderSettingsError(`${label} must be a positive integer`)
      }
    }
    return {
      id,
      // Editor-invisible fields ride along after the id; the modelled keys
      // spread last so a panel edit (or clear) always wins over a carried
      // value. extras never contains those keys — see configurationOf.
      ...model.extras,
      ...(model.name === undefined || model.name.trim() === '' ? {} : { name: model.name.trim() }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }
  })
  const root = target.settingsPath
  const ops: SettingsPathOpFace[] = [
    baseURL === undefined || baseURL === ''
      ? { op: 'unset', path: [...root, 'baseURL'] }
      : { op: 'set', path: [...root, 'baseURL'], value: baseURL },
    // An explicit empty list is deliberate: it prevents a provider's shipped
    // catalog from silently becoming the active selection.
    { op: 'set', path: [...root, 'models'], value: models },
  ]
  try {
    await settings.mutate(target.settingsNs, ops, target.settingsRevision)
  } catch (error) {
    throw new ProviderSettingsError(singleLine(messageOf(error)))
  }
}

/**
 * Interrogate a provider endpoint for the models it really serves, through
 * the model-discovery capability the provider's settings namespace
 * registered — the same pipe the official Web Models page uses. The request
 * is a draft: a typed key forces direct endpoint interrogation (gateway
 * truth), while an empty key lets the harness resolve the route's stored
 * credential; with neither baseURL nor route the adapter answers from its
 * own knowledge.
 * @param ctx - context carrying the `llm` service (optional discovery).
 * @param target - provider row whose settings namespace serves the draft.
 * @param request - typed key and/or endpoint override for this one probe.
 * @param signal - caller cancellation (panel navigation aborts the probe).
 * @returns the advertised models in endpoint order, deduplicated.
 */
export async function discoverProviderModels(
  ctx: Context,
  target: ProviderTargetView,
  request: { readonly apiKey?: string; readonly baseURL?: string },
  signal?: AbortSignal,
): Promise<readonly DiscoveredModelView[]> {
  if (target.settingsNs.length === 0) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no managed settings namespace; its models cannot be discovered here`)
  }
  const llm = ctx.get('llm') as LlmFace | undefined
  if (llm?.discoverModels === undefined) {
    throw new ProviderSettingsError('model discovery is unavailable in this profile; enter models by hand')
  }
  const typedKey = request.apiKey?.trim()
  const baseURL = request.baseURL?.trim()
  const hasUrl = baseURL !== undefined && baseURL !== ''
  let oneShotKey = typedKey
  // A filled endpoint means the user wants THAT endpoint's real list: sending
  // the route id alongside would make the adapter short-circuit to its
  // installed catalog (official providers) and ignore the URL entirely. The
  // probe therefore goes out as a draft — with the typed key, or with the
  // stored credential resolved once for this request (never displayed,
  // never persisted; exactly what provider-mode resolution does internally).
  if (hasUrl && (oneShotKey === undefined || oneShotKey === '')) {
    const credentialsService = ctx.get('credentials') as CredentialsFace | undefined
    const ref = target.credentialRef ?? target.suggestedRef
    if (credentialsService?.resolve !== undefined && ref !== undefined) {
      try {
        // Call resolve AS A METHOD on the service: destructured off it the
        // call loses `this` and throws on the provider's first field read
        // (the same lesson loadProviderSettings documents for listProviders).
        const resolved = await credentialsService.resolve(ref)
        oneShotKey = resolved?.value
      } catch {
        // A failed resolution degrades to an unauthenticated probe; the
        // endpoint's own 401 names the problem better than we can.
      }
    }
  }
  const draft = hasUrl
    ? {
      ...(oneShotKey !== undefined && oneShotKey !== '' ? { apiKey: oneShotKey } : {}),
      baseURL: baseURL,
      ...target.configuration.api === undefined ? {} : { api: target.configuration.api },
    }
    : {
      // No endpoint override: the route's own knowledge answers (the official
      // catalog for builtin providers — richer than any listing).
      provider: target.provider,
    }
  try {
    const discovered = signal === undefined
      ? await llm.discoverModels(target.settingsNs, draft)
      : await llm.discoverModels(target.settingsNs, draft, signal)
    // Defensive dedupe in endpoint order (the service dedupes too; an older
    // one must not leak duplicate rows into the checkable list).
    const seen = new Set<string>()
    const rows: DiscoveredModelView[] = []
    for (const model of discovered) {
      if (typeof model.id !== 'string' || model.id.trim() === '' || seen.has(model.id)) continue
      seen.add(model.id)
      rows.push({
        id: model.id,
        ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      })
    }
    return rows
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new ProviderSettingsError(singleLine(messageOf(error)))
  }
}

/**
 * Remove the currently named credential without touching the provider
 * profile. Only the resolved profile's own reference is unset; a dormant or
 * ref-less row (nothing to remove), an already-absent key, and an
 * env-supplied read-only key are rejected safely before any service call.
 * @param ctx - context carrying the `credentials` service.
 * @param target - the joined row whose named credential to unset.
 * @throws {@link ProviderSettingsError} with a single-line, key-free message.
 */
export async function unsetProviderCredential(ctx: Context, target: ProviderTargetView): Promise<void> {
  const ref = target.credentialRef
  if (ref === undefined) {
    throw new ProviderSettingsError(`provider "${target.provider}" names no credential reference to remove`)
  }
  const facts = target.credential
  if (facts?.kind === 'facts' && facts.configured === false) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no configured credential to remove`)
  }
  if (facts?.kind === 'facts' && facts.writable === false) {
    throw new ProviderSettingsError(`the key for provider "${target.provider}" is supplied read-only by the environment; unset it in the shell instead`)
  }
  const credentials = ctx.get('credentials') as CredentialsFace | undefined
  if (credentials === undefined) {
    throw new ProviderSettingsError('credentials service is unavailable; cannot remove the API key')
  }
  try {
    await credentials.unset(ref)
  } catch (error) {
    throw new ProviderSettingsError(singleLine(messageOf(error)))
  }
}

/**
 * Remove a user-added provider profile, web-parity: only `removable` rows may
 * be removed; a page-managed credential — the derived ref, configured and
 * writable — is unset first (so a second-step failure leaves the row visible
 * and the operation retryable), then `settings.mutate` unsets
 * `target.settingsPath`. Both steps are idempotent. A hand-named credential
 * ref may be shared elsewhere and is left alone.
 * @param ctx - context carrying `credentials` and `settings`.
 * @param target - the joined row to remove.
 * @throws {@link ProviderSettingsError} with a single-line, key-free message.
 */
export async function removeProviderSettings(ctx: Context, target: ProviderTargetView): Promise<void> {
  if (!target.removable) {
    throw new ProviderSettingsError(`provider "${target.provider}" is not removable from the user settings layer`)
  }
  if (target.settingsNs.length === 0) {
    throw new ProviderSettingsError(`provider "${target.provider}" has no managed settings profile to remove`)
  }
  const managedRef = target.credentialRef === target.suggestedRef
    && target.credential?.kind === 'facts'
    && target.credential.configured === true
    && target.credential.writable === true
    ? target.credentialRef
    : undefined
  if (managedRef !== undefined) {
    const credentials = ctx.get('credentials') as CredentialsFace | undefined
    if (credentials === undefined) {
      throw new ProviderSettingsError('credentials service is unavailable; cannot remove the managed API key')
    }
    try {
      await credentials.unset(managedRef)
    } catch (error) {
      throw new ProviderSettingsError(singleLine(messageOf(error)))
    }
  }
  const settings = ctx.get('settings') as SettingsFace | undefined
  if (settings === undefined) {
    throw new ProviderSettingsError('settings service is unavailable; cannot remove the provider profile')
  }
  try {
    await settings.mutate(target.settingsNs, [{ op: 'unset', path: [...target.settingsPath] }])
  } catch (error) {
    throw new ProviderSettingsError(singleLine(messageOf(error)))
  }
}
