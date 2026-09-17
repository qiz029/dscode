/**
 * Session usage for the /usage panel: the provider-reported token totals, the
 * context pressure and composition, and the exact per-turn accounting, folded
 * into the styled rows the panel draws.
 *
 * Every figure comes from the harness token meter. The four token buckets are
 * disjoint, so the prompt side is never double counted; the composition block
 * is a density estimate and is labelled as one.
 *
 * @module @deepseek-ai/dsh-tui/render/usage
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsageProjection, TurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import { t } from '../i18n.ts'
import { lineSegment, type LineStyle, type StyledLine, type StyledSegment } from './lines.ts'
import { visibleColumns } from './markdown.ts'
import { formatTokens } from './status.ts'
import { truncateColumns } from './text.ts'

/** One completed turn's exact provider-reported accounting. */
export interface UsageTurn {
  /** Durable turn number (`turn/start`). */
  readonly turn: number
  readonly usage: TurnTokenUsage
  /**
   * The model that billed this turn, or '' when nothing in the log names one.
   * The meter's own `routes` is preferred; it is absent whenever ONE attempt
   * went unattributed, so the turn's own assistant messages answer instead.
   */
  readonly model: string
}

/**
 * Everything the panel reads. The totals come from the mounted projection and
 * the per-turn rows from the meter's own fold; a missing projection renders as
 * explicitly unavailable rather than as zeros, because an unmounted deployment
 * and a session with no traffic are different facts.
 */
export interface UsageView {
  /** Provider-reported usage over the whole durable log. */
  readonly totals?: TokenUsageProjection
  /** Completed turns, oldest first. */
  readonly turns: readonly UsageTurn[]
}

/** Prompt-side tokens the provider billed: uncached input plus both cache buckets. */
export function billedInputTokens(totals: TokenUsageProjection): number {
  return totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
}

/** Prompt plus completion tokens over the whole log. */
export function usageTotalTokens(totals: TokenUsageProjection): number {
  return billedInputTokens(totals) + totals.outputTokens
}

/**
 * Cache-hit share of billed prompt-side input.
 * @param totals - cumulative provider-reported buckets.
 * @returns percent rounded to one decimal place, or null when nothing was billed.
 */
export function usageCacheHitPercent(totals: TokenUsageProjection): number | null {
  const billed = billedInputTokens(totals)
  return billed === 0 ? null : Math.round(totals.cacheReadTokens / billed * 1_000) / 10
}

/** One complete turn's durable events, in log order. */
export interface TurnSlice {
  readonly turn: number
  readonly events: readonly SessionEvent[]
}

/**
 * Split a durable log into COMPLETE turns. A turn still running has no
 * `turn/end` yet, and an unfinished attempt has no exact accounting, so the
 * trailing slice is dropped rather than guessed at.
 * @param events - the whole durable log, in log order.
 * @returns one slice per `turn/start`…`turn/end` span, oldest first.
 */
export function completedTurns(events: readonly SessionEvent[]): readonly TurnSlice[] {
  const slices: TurnSlice[] = []
  let open: { turn: number; events: SessionEvent[] } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = { turn: event.data.turn, events: [event] }
      continue
    }
    if (open === undefined) continue
    open.events.push(event)
    if (event.type === 'turn/end') {
      slices.push(open)
      open = undefined
    }
  }
  return slices
}

/**
 * Exact usage for every completed turn that can be proven.
 * @param events - the whole durable log, in log order.
 * @param derive - the meter's per-turn fold, injected so this module stays pure.
 * @returns one row per provable turn, oldest first; turns whose attempts did
 *   not all report usage are omitted rather than estimated, and so is a turn
 *   that billed nothing at all — an empty row is noise in a usage table.
 */
export function turnUsages(
  events: readonly SessionEvent[],
  derive: (events: readonly SessionEvent[]) => TurnTokenUsage | undefined,
): readonly UsageTurn[] {
  const rows: UsageTurn[] = []
  for (const slice of completedTurns(events)) {
    const usage = derive(slice.events)
    if (usage === undefined || usage.totalTokens === 0) continue
    rows.push({ turn: slice.turn, usage, model: turnModel(slice, usage) })
  }
  return rows
}

/** Pad to a column budget so labels line up across terminal widths. */
function padColumns(text: string, columns: number): string {
  return text + ' '.repeat(Math.max(0, columns - visibleColumns(text)))
}

/** One `label` + `value` row of a summary block. */
function pairLine(label: string, value: string, labelColumns: number, style: LineStyle = 'plain'): StyledLine {
  const gap = ' '.repeat(Math.max(1, labelColumns - visibleColumns(label)))
  return { segments: [lineSegment('  ' + label + gap, 'dim'), lineSegment(value, style)] }
}

/** A bucket some turn of a group did not report, leaving the group sum a floor. */
export type PartialBucket = 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'

/** One model's merged totals across every turn it billed. */
export interface ModelUsage {
  /** Model names joined with ` + ` (a turn that switched models lists both). */
  readonly model: string
  /** Turns attributed to this model. */
  readonly turns: number
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  /** Summed over the turns that reported it; absent when none did. */
  readonly cacheReadTokens?: number
  /** Summed over the turns that reported it; absent when none did. */
  readonly cacheWriteTokens?: number
  /** Summed over the turns that reported it; absent when none did. */
  readonly reasoningTokens?: number
  /**
   * Buckets some turn of the group left unreported. The corresponding sum (and
   * the hit share derived from it) counts only what WAS reported, so the
   * display marks it as a floor rather than hiding the group's known traffic.
   */
  readonly partial: readonly PartialBucket[]
}

/**
 * Merge the per-turn rows by the model that billed them, biggest spender
 * first. A turn lands in exactly one group — the group named by every model it
 * used — so the sums stay additive and a mid-turn model switch never counts
 * the same tokens twice. Each bucket is merged over the turns that reported
 * it, and {@link ModelUsage.partial} records the ones that stayed silent.
 * @param turns - provable per-turn rows, oldest first.
 * @returns one row per model group.
 */
export function modelTotals(turns: readonly UsageTurn[]): readonly ModelUsage[] {
  const groups = new Map<string, readonly UsageTurn[]>()
  for (const row of turns) {
    groups.set(row.model, [...(groups.get(row.model) ?? []), row])
  }
  const merged: ModelUsage[] = []
  for (const [model, rows] of groups) {
    const partial: PartialBucket[] = []
    // A bucket is summed over the turns that reported it. Refusing the whole
    // group because ONE turn stayed silent would contradict the per-turn table
    // right below, where those same turns show real cache reads; the floor is
    // marked instead of thrown away.
    const sum = (key: PartialBucket): number | undefined => {
      const reported = rows.flatMap(row => row.usage[key] === undefined ? [] : [row.usage[key]])
      if (reported.length === 0) return undefined
      if (reported.length < rows.length) partial.push(key)
      return reported.reduce((total, value) => total + value, 0)
    }
    const cacheReadTokens = sum('cacheReadTokens')
    const cacheWriteTokens = sum('cacheWriteTokens')
    const reasoningTokens = sum('reasoningTokens')
    merged.push({
      model,
      turns: rows.length,
      uncachedInputTokens: rows.reduce((sum, row) => sum + row.usage.uncachedInputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.usage.outputTokens, 0),
      totalTokens: rows.reduce((sum, row) => sum + row.usage.totalTokens, 0),
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      partial,
    })
  }
  // Biggest spender first; turns nothing could attribute stay at the bottom,
  // because that row is a gap in the record rather than a model.
  return merged.sort((left, right) => (
    left.model === '' ? 1 : right.model === '' ? -1 : right.totalTokens - left.totalTokens
  ))
}

/** Cut one styled line to a column budget, keeping every style it fits. */
function boundLine(line: StyledLine, width: number): StyledLine {
  const segments: StyledSegment[] = []
  let left = width
  for (const segment of line.segments) {
    if (left <= 0) break
    const columns = visibleColumns(segment.text)
    if (columns <= left) {
      segments.push(segment)
      left -= columns
      continue
    }
    segments.push(lineSegment(truncateColumns(segment.text, left), segment.style))
    left = 0
  }
  return { segments }
}

/** A block heading. */
function heading(text: string): StyledLine {
  return { segments: [lineSegment(text, 'accentBold')] }
}

/** A dim explanatory or empty-state row. */
function note(text: string): StyledLine {
  return { segments: [lineSegment('  ' + text, 'dim')] }
}

/** The bucket figures both tables print (a turn, or a merged model group). */
interface BucketRow {
  readonly totalTokens: number
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  /** Present on a merged group: buckets only some of its turns reported. */
  readonly partial?: readonly PartialBucket[]
}

/**
 * Cache-hit share of one row's billed prompt side, or undefined when the row
 * has no cache read to report. An unreported cache-write bucket counts as
 * zero: the adapters that bill cache writes always report the bucket, so its
 * absence means the route never tracked one — the same reading the status
 * bar's own fold uses.
 */
function hitShare(row: BucketRow): number | undefined {
  if (row.cacheReadTokens === undefined) return undefined
  const billed = row.uncachedInputTokens + row.cacheReadTokens + (row.cacheWriteTokens ?? 0)
  if (billed === 0) return undefined
  return Math.round(row.cacheReadTokens / billed * 1_000) / 10
}

/** The token columns, in display order (shared by both tables). */
/** True when the row's bucket is a floor rather than a complete figure. */
function isPartial(row: BucketRow, key: PartialBucket): boolean {
  return row.partial?.includes(key) === true
}

const BUCKET_COLUMNS: readonly { label: () => string; value: (row: BucketRow) => string; width: number }[] = [
  { label: () => t('panel.usage.colTotal'), value: row => formatTokens(row.totalTokens), width: 9 },
  { label: () => t('panel.usage.colUncached'), value: row => formatTokens(row.uncachedInputTokens), width: 9 },
  { label: () => t('panel.usage.colCacheRead'), value: row => optionalTokens(row.cacheReadTokens, isPartial(row, 'cacheReadTokens')), width: 9 },
  {
    label: () => t('panel.usage.colCacheHit'),
    value: row => percent(
      hitShare(row),
      isPartial(row, 'cacheReadTokens') || isPartial(row, 'cacheWriteTokens'),
    ),
    width: 8,
  },
  { label: () => t('panel.usage.colCacheWrite'), value: row => optionalTokens(row.cacheWriteTokens, isPartial(row, 'cacheWriteTokens')), width: 9 },
  { label: () => t('panel.usage.colOut'), value: row => formatTokens(row.outputTokens), width: 9 },
  { label: () => t('panel.usage.colThink'), value: row => optionalTokens(row.reasoningTokens, isPartial(row, 'reasoningTokens')), width: 9 },
]

/** A percentage, or an em dash when the row cannot prove one; `+` for a floor. */
function percent(value: number | undefined, partial = false): string {
  return value === undefined ? '—' : value + '%' + (partial ? '+' : '')
}

/**
 * A bucket as a table cell: an em dash when nothing reported it, and a `+`
 * when the figure counts only the turns of a group that did report it.
 */
function optionalTokens(value: number | undefined, partial = false): string {
  if (value === undefined) return '—'
  return formatTokens(value) + (partial ? '+' : '')
}

/** What an unattributed turn or group is called in the tables. */
function modelLabel(model: string): string {
  return model === '' ? t('panel.usage.unknownModel') : model
}

/**
 * The model a turn's assistant messages came from: the one that produced most
 * of them, with a tie naming every model involved. This is the fallback for
 * turns whose meter `routes` were withheld, and it reads only what the log
 * recorded — nothing is inferred from the current selection.
 */
function dominantModel(events: readonly SessionEvent[]): string {
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    const source = event.data.message.source
    if (source.kind !== 'model' || source.model === '') continue
    counts.set(source.model, (counts.get(source.model) ?? 0) + 1)
  }
  if (counts.size === 0) return ''
  const most = Math.max(...counts.values())
  return [...counts.entries()]
    .filter(([, count]) => count === most)
    .map(([model]) => model)
    .sort()
    .join(' + ')
}

/** The model attribution for one turn: the meter's routes, else its messages. */
export function turnModel(slice: TurnSlice, usage: TurnTokenUsage): string {
  const routes = usage.routes ?? []
  if (routes.length > 0) return routes.map(route => route.model).join(' + ')
  return dominantModel(slice.events)
}

/**
 * Render one table: a dim header plus one row per entry. The free-text cell
 * (the model name) keeps a readable share of the width, so trailing numeric
 * columns drop first on a narrow terminal instead of leaving an ellipsised
 * model name — the name is what the reader came for.
 * @param columns - the numeric columns, most important first.
 * @param rows - one entry per line, already in display order.
 * @param text - how to read the free-text cell of one entry.
 * @param width - the column budget.
 * @param textFirst - true puts the free-text cell before the numbers (the
 *   model-group table); false appends it (the per-turn table).
 * @returns the header row plus one row per entry.
 */
function table<T>(
  columns: readonly { label: () => string; value: (row: T) => string; width: number }[],
  rows: readonly T[],
  text: (row: T) => string,
  width: number,
  textFirst: boolean,
): StyledLine[] {
  const budget = width - 2
  const minText = 14
  const kept: typeof columns[number][] = []
  let used = 0
  for (const column of columns) {
    if (used + column.width > budget - minText - 1) break
    kept.push(column)
    used += column.width
  }
  // Capped so a wide terminal does not stretch one column across the panel.
  const textWidth = Math.min(24, Math.max(6, budget - used - 1))
  const numbers = (row: T): string => kept.map(column => padColumns(column.value(row), column.width)).join('')
  const header = kept.map(column => padColumns(column.label(), column.width)).join('')
  const headerText = textFirst
    ? padColumns(t('panel.usage.colModel'), textWidth) + ' ' + header
    : header + ' ' + t('panel.usage.colModel')
  const lines: StyledLine[] = [
    { segments: [lineSegment(truncateColumns('  ' + headerText, width), 'dim')] },
  ]
  for (const row of rows) {
    const label = truncateColumns(text(row), textWidth)
    lines.push({
      segments: [lineSegment('  ' + (textFirst ? padColumns(label, textWidth) + ' ' + numbers(row) : numbers(row) + ' ' + label), 'plain')],
    })
  }
  return lines
}

/**
 * Render the panel body.
 * @param view - the projection totals plus the derived per-turn rows.
 * @param columns - usable content columns inside the panel border.
 * @returns bounded, styled rows ready to draw.
 */
export function usageLines(view: UsageView, columns: number): readonly StyledLine[] {
  const width = Math.max(8, Math.floor(columns))
  const lines: StyledLine[] = []

  lines.push(heading(t('panel.usage.totals')))
  const totals = view.totals
  if (totals === undefined) {
    lines.push(note(t('panel.usage.unavailable')))
  } else {
    const label = 12
    lines.push(pairLine(t('panel.usage.uncached'), formatTokens(totals.uncachedInputTokens), label))
    lines.push(pairLine(t('panel.usage.cacheWrite'), formatTokens(totals.cacheWriteTokens), label))
    lines.push(pairLine(t('panel.usage.cacheRead'), formatTokens(totals.cacheReadTokens), label))
    lines.push(pairLine(t('panel.usage.output'), formatTokens(totals.outputTokens), label))
    lines.push(pairLine(t('panel.usage.total'), formatTokens(usageTotalTokens(totals)), label, 'bold'))
    const hit = usageCacheHitPercent(totals)
    if (hit !== null) lines.push(pairLine(t('panel.usage.cacheHit'), hit + '%', label))
  }

  lines.push({ segments: [] })
  const models = modelTotals(view.turns)
  lines.push(heading(models.length === 0 ? t('panel.usage.byModel') : `${t('panel.usage.byModel')} · ${models.length}`))
  if (models.length === 0) {
    lines.push(note(t('panel.usage.noTurns')))
  } else {
    lines.push(...table([
      { label: () => t('panel.usage.colTurns'), value: (row: ModelUsage) => String(row.turns), width: 7 },
      ...BUCKET_COLUMNS.map(column => ({ ...column, value: (row: ModelUsage) => column.value(row) })),
    ], models, row => modelLabel(row.model), width, true))
    if (models.some(row => row.partial.length > 0)) lines.push(note(t('panel.usage.partialNote')))
  }

  lines.push({ segments: [] })
  lines.push(heading(`${t('panel.usage.turns')} · ${view.turns.length}`))
  if (view.turns.length === 0) {
    lines.push(note(t('panel.usage.noTurns')))
  } else {
    const withTurn = [
      { label: () => t('panel.usage.colTurn'), value: (row: { turn: number }) => `#${row.turn}`, width: 7 },
      ...BUCKET_COLUMNS.map(column => ({ ...column, value: (row: UsageTurn) => column.value(row.usage) })),
    ]
    lines.push(...table(withTurn, [...view.turns].reverse(), row => modelLabel(row.model), width, false))
  }

  return lines.map(line => boundLine(line, width))
}
