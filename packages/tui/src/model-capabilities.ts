/**
 * Same-id reasoning-capability inheritance for hand-declared pi-ai routes:
 * the model catalog inherits capabilities by route key, not by model id, so a
 * relay route listing `gpt-5.5` reads nothing from the installed `openai`
 * catalog entry and materializes as `reasoning: false` until its settings
 * entry declares `reasoningEfforts`. This adapter closes that gap without
 * touching upstream: whenever a pi-ai profile's model entry carries no
 * declaration and its live row advertises no efforts, but the same model id
 * is declared (in a sibling settings entry) or advertised (on another route)
 * elsewhere, the declaration is materialized into settings — verbatim from a
 * sibling declaration when one exists, otherwise as an identity level map
 * (`off` maps to null, every other level to its own name), which is the
 * correct wire spelling for OpenAI-compatible relays. Writes ride the same
 * `settings.mutate` path as the provider panel, so the upstream
 * `assertServiceable` gate still rejects anything invalid atomically.
 *
 * @module @deepseek-ai/dsh-tui/model-capabilities
 */

import type { Context } from '@deepseek-ai/cordis'
import { loadModelDirectory, type ModelRow } from './models.ts'

/** The settings namespace the llm-pi-ai plugin owns (identity via `settingsNamespace`). */
const PI_AI_SETTINGS_NS = 'llm-pi-ai'

/** The effort level that means "send no reasoning parameter"; its wire value is always null. */
const OFF_LEVEL = 'off'

/* ------------------------------------------------------------------ *
 * Structural service faces (same discipline as provider-settings: the
 * settings package is never imported, only described structurally).
 * ------------------------------------------------------------------ */

/** One configurable-provider directory entry (subset of the `llm` service face). */
interface ConfigurableEntryFace {
  readonly provider: string
  readonly settingsNs: string
  readonly settingsPath: readonly string[]
}

/** One redacted settings descriptor (subset of `SettingsDescriptor`). */
interface DescriptorFace {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
}

/** One path-addressed edit to a stored section (subset of `SettingsPathOp`). */
interface PathOpFace {
  readonly op: 'set' | 'unset'
  readonly path: readonly string[]
  readonly value?: unknown
}

/** The subset of the `settings` service this module reads and writes. */
interface SettingsFace {
  describe(options?: { readonly redactSecrets?: boolean }): readonly DescriptorFace[]
  mutate(ns: string, ops: readonly PathOpFace[], expectedRevision?: number): Promise<void>
}

/** A notice sink structurally compatible with the app bridge's `notify`. */
export type CapabilityNotice = (text: string, tone?: 'info' | 'warning' | 'error') => void

/** Single-line a misbehaving error for the notice channel. */
function singleLine(message: string): string {
  const spaced = [...message].map(ch => { const code = ch.charCodeAt(0); return code < 32 || code === 127 ? ' ' : ch }).join('')
  return spaced.split(' ').filter(part => part !== '').join(' ')
}

/** Human text for a rejection value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

/** Whether a raw settings value is a usable `reasoningEfforts` dict (non-empty, non-false). */
function isDeclaredEfforts(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

/**
 * The identity level map for an advertised effort list: `off` sends no
 * parameter, every other level keeps its own name — the wire spelling
 * OpenAI-compatible relays accept as-is.
 */
function identityEfforts(levels: readonly string[]): Record<string, string | null> {
  const dict: Record<string, string | null> = {}
  for (const level of levels) dict[level] = level === OFF_LEVEL ? null : level
  return dict
}

/* ------------------------------------------------------------------ *
 * Pure planning.
 * ------------------------------------------------------------------ */

/** One pi-ai provider profile as stored in settings, addressed for mutation. */
export interface CapabilityProfileSource {
  /** Settings namespace owning the profile (`llm-pi-ai`). */
  readonly settingsNs: string
  /** Path from the section root to this provider's profile. */
  readonly settingsPath: readonly string[]
  /** Revision of the owning section at read time. */
  readonly revision: number
  /** Raw model entries, exactly as stored (declaration fields included). */
  readonly models: readonly Record<string, unknown>[]
}

/** One planned per-provider models rewrite. */
export interface CapabilitySyncPlan {
  /** Provider route the plan targets. */
  readonly provider: string
  /** Settings namespace owning the profile. */
  readonly settingsNs: string
  /** Path from the section root to the provider profile. */
  readonly settingsPath: readonly string[]
  /** Raw model entries, exactly as stored (declaration fields included). */
  readonly models: readonly Record<string, unknown>[]
  /** Fingerprint of the source models array this plan was derived from. */
  readonly sourceFingerprint: string
  /** Document revision of the owning section when the plan was derived. */
  readonly sourceRevision: number
  /** Model ids that gained a declaration, notice-facing. */
  readonly inherited: readonly string[]
  /** `provider/model` labels the declarations came from, notice-facing. */
  readonly sources: readonly string[]
}

/**
 * Plan the reasoning declarations to materialize. A model entry inherits
 * when it declares nothing (`reasoningEfforts` absent — a dict or `false` is
 * an explicit choice and is never touched) and its live row advertises no
 * efforts; the donor is the first sibling settings declaration for the same
 * id, copied verbatim so dialect wire spellings survive, otherwise the first
 * other-route row advertising efforts for that id, mapped by identity.
 * Entries never lose fields and keep their key order; a provider appears in
 * the result only when at least one entry changes.
 * @param input - the live model rows and the raw pi-ai profiles from settings.
 * @returns one plan per provider with at least one inheritance.
 */
export function planCapabilitySync(input: {
  readonly rows: readonly ModelRow[]
  readonly profiles: ReadonlyMap<string, CapabilityProfileSource>
}): readonly CapabilitySyncPlan[] {
  // Sibling declarations, first profile order wins: { id -> { dict, provider } }.
  const declared = new Map<string, { dict: Record<string, unknown>; provider: string }>()
  for (const [provider, profile] of input.profiles) {
    for (const entry of profile.models) {
      const efforts = entry.reasoningEfforts
      if (!isDeclaredEfforts(efforts)) continue
      if (!declared.has(String(entry.id))) declared.set(String(entry.id), { dict: efforts, provider })
    }
  }
  // Advertised donors, first row order wins: { id -> { levels, provider } }.
  // A row whose only level is `off` advertises nothing usable and is skipped.
  const advertised = new Map<string, { levels: readonly string[]; provider: string }>()
  for (const row of input.rows) {
    const levels = row.reasoning?.efforts.map(effort => effort.id) ?? []
    if (levels.filter(level => level !== OFF_LEVEL).length === 0) continue
    if (!advertised.has(row.model)) advertised.set(row.model, { levels, provider: row.provider })
  }
  const plans: CapabilitySyncPlan[] = []
  for (const [provider, profile] of input.profiles) {
    const inherited: string[] = []
    const sources: string[] = []
    const models = profile.models.map((entry): Record<string, unknown> => {
      if (entry.reasoningEfforts !== undefined) return entry
      const id = String(entry.id)
      const sibling = declared.get(id)
      if (sibling !== undefined && sibling.provider !== provider) {
        inherited.push(id)
        if (!sources.includes(`${sibling.provider}/${id}`)) sources.push(`${sibling.provider}/${id}`)
        return { ...entry, reasoningEfforts: sibling.dict }
      }
      const donor = advertised.get(id)
      if (donor !== undefined && donor.provider !== provider) {
        inherited.push(id)
        if (!sources.includes(`${donor.provider}/${id}`)) sources.push(`${donor.provider}/${id}`)
        return { ...entry, reasoningEfforts: identityEfforts(donor.levels) }
      }
      return entry
    })
    if (inherited.length > 0) {
      plans.push({
        provider,
        settingsNs: profile.settingsNs,
        settingsPath: profile.settingsPath,
        models,
        sourceFingerprint: JSON.stringify(profile.models),
        sourceRevision: profile.revision,
        inherited,
        sources,
      })
    }
  }
  return plans
}

/* ------------------------------------------------------------------ *
 * Application.
 * ------------------------------------------------------------------ */

/** Provider -> the source snapshot and document revision its last write landed against. */
const lastApplied = new Map<string, { fingerprint: string; revision: number }>()

/** Fresh revision of one namespace, or undefined when it does not resolve. */
function revisionOf(settings: SettingsFace, ns: string): number | undefined {
  try {
    for (const descriptor of settings.describe({ redactSecrets: true })) {
      if (descriptor.ns === ns) return descriptor.revision
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Materialize same-id reasoning declarations once per provider. Reads the
 * configurable directory, the redacted settings document, and the live model
 * rows; plans; then writes each provider's merged models array through
 * `settings.mutate` under a fresh revision (writes bump the section
 * revision, so per-plan revisions are re-read). Every failure converges to a
 * single-line notice — the caller's promise never rejects and the session
 * keeps running on the previous configuration.
 * @param ctx - context carrying the `llm` and `settings` services (optional).
 * @param notify - the app bridge's notice sink, when one is live.
 */
export async function syncModelCapabilities(ctx: Context, notify?: CapabilityNotice): Promise<void> {
  try {
    const llm = ctx.get('llm') as { listConfigurableProviders?: () => readonly ConfigurableEntryFace[] } | undefined
    if (llm?.listConfigurableProviders === undefined) return
    const settings = ctx.get('settings') as SettingsFace | undefined
    if (settings === undefined) return
    let entries: readonly ConfigurableEntryFace[]
    try {
      entries = llm.listConfigurableProviders()
    } catch {
      return
    }
    const routed = entries.filter(entry => entry.settingsNs === PI_AI_SETTINGS_NS)
    if (routed.length === 0) return
    let descriptors: readonly DescriptorFace[]
    try {
      descriptors = settings.describe({ redactSecrets: true })
    } catch {
      return
    }
    const namespaces = new Map(descriptors.map(descriptor => [descriptor.ns, descriptor] as const))
    const profiles = new Map<string, CapabilityProfileSource>()
    for (const entry of routed) {
      const namespace = namespaces.get(entry.settingsNs)
      if (namespace === undefined) continue
      const profile = entry.settingsPath.length === 0
        ? namespace.value
        : getPath(namespace.value, entry.settingsPath)
      const models = Array.isArray((profile as { models?: unknown } | null)?.models)
        ? (profile as { models: unknown }).models as readonly Record<string, unknown>[]
        : undefined
      // An absent models list is a dormant or unconfigured route: nothing to
      // inherit into (and the empty allow-list there is deliberate upstream).
      if (models === undefined) continue
      profiles.set(entry.provider, {
        settingsNs: entry.settingsNs,
        settingsPath: entry.settingsPath,
        revision: namespace.revision,
        models,
      })
    }
    if (profiles.size === 0) return
    const directory = await loadModelDirectory(ctx)
    for (const plan of planCapabilitySync({ rows: directory.rows, profiles })) {
      // Skip only a provable echo of our own write: the same source
      // snapshot at the same document revision we already wrote against
      // (our write re-triggers the document event before the re-read
      // catches up). An external edit that removes a materialized
      // declaration bumps the revision, so identical source content
      // re-plans and re-writes instead of being skipped forever.
      const applied = lastApplied.get(plan.provider)
      if (applied !== undefined && applied.fingerprint === plan.sourceFingerprint && applied.revision === plan.sourceRevision) continue
      // Writes bump the section revision; re-read per plan so the second
      // provider's optimistic revision is not already stale.
      const revision = revisionOf(settings, plan.settingsNs)
      if (revision === undefined) continue
      try {
        await settings.mutate(
          plan.settingsNs,
          [{ op: 'set', path: [...plan.settingsPath, 'models'], value: plan.models }],
          revision,
        )
        lastApplied.set(plan.provider, { fingerprint: plan.sourceFingerprint, revision: plan.sourceRevision })
        const shown = plan.sources.slice(0, 3).join(', ')
        const more = plan.sources.length > 3 ? `, +${plan.sources.length - 3}` : ''
        notify?.(
          `inherited reasoning levels for ${plan.inherited.length} model${plan.inherited.length === 1 ? '' : 's'} on ${plan.provider} (from ${shown}${more})`,
          'info',
        )
      } catch (error) {
        notify?.(`capability inheritance failed on ${plan.provider}: ${singleLine(messageOf(error))}`, 'warning')
      }
    }
  } catch {
    // A background sync must never surface as an unhandled rejection.
  }
}

/** Test seam: forget the applied-write fingerprints. */
export function resetCapabilitySyncState(): void {
  lastApplied.clear()
}
