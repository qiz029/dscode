/**
 * dscode: the command palette's memory. The completion menu ranks by where a
 * name matches; the palette additionally remembers what this user actually
 * runs, so the third time `/review` is opened it is already the first row.
 *
 * Usage lives in one user-level JSON file (`~/.dsh/dsh-code/palette.json`),
 * written through the same crash-atomic chain as the statusline file. A missing
 * file is an empty history and a corrupt one is treated the same way instead of
 * failing the TUI: losing the sort order must never cost a session.
 *
 * @module @deepseek-ai/dsh-code/dscode/palette
 */

import { rankByName } from '../render/fuzzy.ts'

/** One remembered command use. */
export interface PaletteUsageEntry {
  /** Epoch milliseconds of the most recent use. */
  readonly lastUsed: number
  /** How many times the command has been run. */
  readonly uses: number
}

/** The persisted usage map, keyed by command name without its trigger. */
export type PaletteUsage = Readonly<Record<string, PaletteUsageEntry>>

/** One palette row. */
export interface PaletteEntry {
  /** Command name without the leading slash (what usage is keyed on). */
  readonly name: string
  /** The `/name` label rendered in the row. */
  readonly label: string
  /** Human-readable description shown beside the label. */
  readonly description: string
  /** What the row runs; skipped for a skill that only accepts a prompt. */
  readonly origin: 'command' | 'skill'
}

/** A description longer than this is clipped in the row, never dropped. */
const MAX_DESCRIPTION = 160

/** Parse the persisted usage object; anything unrecognized is dropped. */
export function parsePaletteUsage(raw: unknown): PaletteUsage {
  if (raw === null || typeof raw !== 'object') return {}
  const source = (raw as { usage?: unknown }).usage
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return {}
  const usage: Record<string, PaletteUsageEntry> = {}
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (name === '' || value === null || typeof value !== 'object') continue
    const entry = value as { lastUsed?: unknown; uses?: unknown }
    const lastUsed = typeof entry.lastUsed === 'number' && Number.isFinite(entry.lastUsed) ? entry.lastUsed : 0
    const uses = typeof entry.uses === 'number' && Number.isFinite(entry.uses) && entry.uses > 0 ? Math.floor(entry.uses) : 0
    if (uses === 0) continue
    usage[name] = { lastUsed, uses }
  }
  return usage
}

/** Serialize the usage map back to the file's shape. */
export function serializePaletteUsage(usage: PaletteUsage): string {
  const sorted: Record<string, PaletteUsageEntry> = {}
  // Stable key order keeps the file readable and diffable across sessions.
  for (const name of Object.keys(usage).sort()) sorted[name] = usage[name]!
  return JSON.stringify({ usage: sorted }, null, 2) + '\n'
}

/** Record one use: the newest timestamp wins, the count accumulates. */
export function recordPaletteUse(usage: PaletteUsage, name: string, now = Date.now()): PaletteUsage {
  if (name === '') return usage
  const previous = usage[name]
  return { ...usage, [name]: { lastUsed: now, uses: (previous?.uses ?? 0) + 1 } }
}

/**
 * Usage weight for sorting. Recency and frequency trade off on a square root,
 * so a single fresh run overtakes an old favorite but a well-worn command does
 * not sink the moment another one is used once.
 */
function weight(entry: PaletteUsageEntry | undefined, now: number): number {
  if (entry === undefined || entry.uses <= 0) return 0
  const ageDays = Math.max(0, now - entry.lastUsed) / 86400000
  return Math.sqrt(entry.uses) / (1 + ageDays)
}

/**
 * Every runnable row for the palette, before a query.
 *
 * User-invocable skills are included: the palette is the one place a skill that
 * the model cannot invoke is still reachable by hand, so hiding it here would
 * make those skills undiscoverable. Model-only skills keep their full
 * description so the row states which is which.
 */
export function paletteEntries(
  local: readonly { readonly name: string; readonly description: string }[],
  descriptors: readonly { readonly name: string; readonly description: string }[],
  skills: readonly { readonly name: string; readonly description: string; readonly modelInvocable?: boolean }[],
): readonly PaletteEntry[] {
  const rows: PaletteEntry[] = []
  const seen = new Set<string>()
  const push = (name: string, description: string, origin: 'command' | 'skill'): void => {
    if (name === '' || seen.has(name)) return
    seen.add(name)
    rows.push({ name, label: `/${name}`, description: description.slice(0, MAX_DESCRIPTION), origin })
  }
  // Local commands shadow the registry (the same precedence dispatch uses).
  for (const command of local) push(command.name, command.description, 'command')
  for (const descriptor of descriptors) push(descriptor.name, descriptor.description, 'command')
  for (const skill of skills) push(skill.name, `skill · ${skill.description}`, 'skill')
  return rows
}

/**
 * Rank rows for one query: fuzzy match first, then the usage weight, then the
 * source order. An empty query is the personal order — most-used, most-recent
 * commands first — with the untouched catalog keeping its declared order.
 */
export function rankPalette(entries: readonly PaletteEntry[], query: string, usage: PaletteUsage, now = Date.now()): readonly PaletteEntry[] {
  // rankByName keeps the source order for equally good matches; stamping each
  // row once lets the usage sort stay stable without an indexOf per comparison.
  const matched = rankByName(entries, query).map((entry, order) => ({ entry, order }))
  return matched
    .sort((left, right) =>
      weight(usage[right.entry.name], now) - weight(usage[left.entry.name], now) || left.order - right.order)
    .map(item => item.entry)
}
