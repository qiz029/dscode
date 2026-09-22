/**
 * Status-bar composition for the TUI footer. Codex/Claude-Code-style split
 * line: identity facts and session figures flow from the left, while the
 * permission badge (the Codex "autonomous selection" anchor, with its
 * shift+tab cycle hint) pins to the right edge. Every segment carries a tone
 * the footer maps to a theme color, and layoutStatusBar degrades the line
 * item by item so it always fits one physical row — truncation with an
 * ellipsis happens only after every lesser group has already dropped out.
 *
 * @module @deepseek-ai/dsh-tui/render/status
 */

import { visibleColumns } from './markdown.ts'
import type { TranscriptStats } from './projection.ts'
import { billedInputTokens } from './usage.ts'
import { singleLineText, truncateColumns, formatTokens } from './text.ts'

// Re-exported for the callers that have always read the formatter here.
export { formatTokens }
import { t } from '../i18n.ts'


/**
 * Compact duration: 45.2s under a minute, 2m42s from there on.
 * @param ms - duration in milliseconds.
 * @returns display string.
 */
export function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return String(Math.round(s * 10) / 10) + 's'
  const whole = Math.round(s)
  return Math.floor(whole / 60) + 'm' + (whole % 60) + 's'
}

/**
 * Compact decode rate: one decimal under a hundred, whole below a thousand,
 * then thousands (15.3 / 124 / 1.2K).
 * @param n - tokens per second.
 * @returns display string.
 */
function formatRate(n: number): string {
  if (n < 100) return String(Math.round(n * 10) / 10)
  if (n < 1_000) return String(Math.round(n))
  return String(Math.round(n / 100) / 10) + 'K'
}

/**
 * Fixed value columns for the footer's live figures. A running turn changes
 * these numbers every second, so each one renders right-aligned inside its
 * own columns: a growing value then reshapes its digits without reflowing the
 * groups after it, and the row's geometry follows terminal width alone. The
 * widths cover the figures a session reaches in practice (999 turns, 999K
 * tokens, 120m0s of wall time); a value past its columns simply grows the
 * group rather than being clipped into a wrong reading.
 */
const VALUE_WIDTH = {
  /** Turn and step counters. */
  count: 3,
  /** `12.3K` token totals. */
  tokens: 5,
  /** `45.2s` / `2m42s` wall times. */
  duration: 6,
  /** `15.3` / `124` / `1.2K` decode rates. */
  rate: 4,
  /** `100%` context occupancy. */
  percentContext: 4,
  /** `100.0%` cache shares. */
  percentShare: 6,
} as const

/** Right-align a figure inside its fixed value columns (wider text is left alone). */
export function padValue(text: string, width: number): string {
  const padding = width - visibleColumns(text)
  return padding > 0 ? ' '.repeat(padding) + text : text
}

/** The `--` placeholder for a figure with no reading yet, in the same columns. */
function pendingValue(width: number): string {
  return padValue('--', width)
}

/**
 * Cache-hit share of billed prompt-side input. The denominator is the same
 * billed total the /usage panel shows (uncached input plus both cache
 * buckets), so the two readouts can never disagree.
 * @param usage - cumulative token totals.
 * @returns percent rounded to one decimal place, or null when no input was billed.
 */
export function cacheHitPercent(usage: TranscriptStats['usage']): number | null {
  const billed = billedInputTokens(usage)
  return billed === 0
    ? null
    : Math.round(usage.cacheReadTokens / billed * 1_000) / 10
}

/**
 * Presentation tones for status spans; the footer maps each to a theme color
 * (Codex status-line accents: model/path/branch/state/usage categories).
 */
export type StatusTone =
  | 'model'
  | 'live'
  | 'path'
  | 'branch'
  | 'value'
  | 'label'
  | 'meta'
  | 'accent'
  | 'success'
  | 'plan'
  | 'warn'
  | 'error'
  // Context-bar fill: one DeepSeek blue for the whole occupied run (the free
  // track uses the dim 'label' tone). Only the context bar emits it.
  | 'ctxFill'

/** One colored run inside the status bar. */
export interface StatusSpan {
  text: string
  tone: StatusTone
  /** Render financial figures with the telemetry's numeric tinting. */
  telemetry?: boolean
}

/**
 * One dot-separated cluster on the leading side of the bar. Spans are the
 * full visual sequence: junction separators ride along as their own dim
 * 'label'-tone spans, so joining is a flat concat with no implicit glue.
 */
export interface StatusGroup {
  spans: readonly StatusSpan[]
  /** dscode: the status item that produced the group; the telemetry cluster is tinted by it. */
  id?: string
}

/** One physical row of the footer: leading clusters and trailing badges. */
export interface StatusRow {
  /** Leading clusters, dot-separated in display order; index 0 is identity. */
  left: readonly StatusGroup[]
  /** Trailing spans pinned to the right edge, dot-separated in display order. */
  right: readonly StatusSpan[]
  /**
   * Whether to paint the shift+tab cycle hint left of the right cluster. Its
   * columns stay reserved either way, so a turn opening or closing never moves
   * the badge or changes what the left clusters may occupy.
   */
  hint: boolean
}

/**
 * The footer layout: two primary rows and an optional third financial row. Row 1 keeps the primary
 * controls (model, cwd, mode, branch, context) flowing from the left while the
 * permission badge anchors the right edge. Row 2 carries every secondary
 * session/run figure and degrades independently.
 */
export interface StatusLayout {
  row1: StatusRow
  row2: StatusRow
  /** Complete financial group moves here when it cannot share row 2. */
  row3?: StatusRow
}

/** Separator between leading clusters. */
export const STATUS_GROUP_SEPARATOR = ' · '
/** Separator between trailing state spans. */
export const STATUS_ITEM_SEPARATOR = ' · '
/** The Codex-style mode cycle hint appended to the permission badge. */
/** English compatibility value for callers that only measure the default layout. */
export const STATUS_CYCLE_HINT = ' (shift+tab to cycle)'

/** Localized mode-cycle hint used by the live layout. */
export function statusCycleHint(): string {
  return ` ${t('status.cycleHint')}`
}

/**
 * Interior columns of the context bar. The layout starts every bar at this
 * width so the drop ladder can pre-measure the group, then degrades the
 * readout and shrinks the bar inside a tighter budget before dropping the
 * group (see CONTEXT_MIN_WIDTH) rather than asking the layout for more room.
 */
export const CONTEXT_BAR_WIDTH = 24
/** Occupancy at which the usage readout flips from brand blue to amber. */
const CONTEXT_WARN_PERCENT = 90
/**
 * Narrowest bar width the drop ladder keeps before dropping the whole
 * context group: the bar shrinks to this floor first (the absolute readout
 * survives), and only past it does the readout degrade and the group go.
 */
const CONTEXT_MIN_WIDTH = 5

/**
 * Render context occupancy as ONE stepless proportional bar: a solid
 * DeepSeek-blue fill run tracking the occupancy and a dim dotted free
 * track for the rest. Nothing else lives inside the bar — the usage
 * readout rides outside it (see contextGroupSpans) — so the geometry
 * always reads as the true remaining share. A given occupancy always
 * renders the identical bar.
 * @param usedTokens - reported used tokens.
 * @param contextWindow - route capacity.
 * @param width - total bar columns.
 * @returns tone-split spans for the footer to paint.
 */
export function contextBar(
  usedTokens: number,
  contextWindow: number,
  width: number,
): readonly StatusSpan[] {
  if (width <= 0 || contextWindow <= 0) return []
  const used = Math.max(0, usedTokens)
  const fill = Math.min(width, Math.max(0, Math.round(used / contextWindow * width)))
  const spans: StatusSpan[] = []
  if (fill > 0) spans.push({ text: '█'.repeat(fill), tone: 'ctxFill' })
  const free = width - fill
  if (free > 0) spans.push({ text: '░'.repeat(free), tone: 'label' })
  return spans
}

/** How much usage detail the context group's readout carries. */
export type ContextReadoutMode = 'full' | 'percent' | 'none'

/**
 * Compose the context group: the proportional bar plus the usage readout
 * OUTSIDE the bar, so the dotted track keeps its proportional meaning no
 * matter how wide the readout is. `full` reads `12.3K/1.0M 25%`; `percent`
 * drops the absolute pair; `none` is the bare bar. The readout turns amber
 * once occupancy reaches the warning threshold. Before a route advertises a
 * window the empty track still draws and the readout is the `--` placeholder,
 * so the group keeps its columns from the first frame on.
 */
export function contextGroupSpans(
  usedTokens: number,
  contextWindow: number,
  barWidth: number,
  readout: ContextReadoutMode,
): readonly StatusSpan[] {
  const spans: StatusSpan[] = [{ text: t('status.label.context') + ' ', tone: 'label' }]
  const track = contextWindow > 0
    ? contextBar(usedTokens, contextWindow, barWidth)
    : barWidth > 0 ? [{ text: '░'.repeat(barWidth), tone: 'label' as const }] : []
  spans.push(...track)
  if (readout === 'none' || barWidth <= 0) return spans
  if (contextWindow <= 0) {
    spans.push({ text: ' ', tone: 'label' }, { text: pendingValue(VALUE_WIDTH.tokens), tone: 'value' })
    return spans
  }
  const used = Math.max(0, usedTokens)
  const percent = Math.round(used / contextWindow * 100)
  const text = readout === 'full'
    ? `${padValue(formatTokens(used), VALUE_WIDTH.tokens)}/${formatTokens(contextWindow)} ${padValue(percent + '%', VALUE_WIDTH.percentContext)}`
    : padValue(percent + '%', VALUE_WIDTH.percentContext)
  spans.push(
    { text: ' ', tone: 'label' },
    { text, tone: percent >= CONTEXT_WARN_PERCENT ? 'warn' : 'value' },
  )
  return spans
}

/**
 * One customizable status item (the Codex /statusline picker contract).
 * 'left' items render as pipe-separated clusters after the identity dot;
 * 'right' items pin to the right edge as dot-separated state badges.
 */
export type StatusItemId =
  | 'model'
  | 'cwd'
  | 'branch'
  | 'plan'
  | 'mode'
  | 'turns'
  | 'durations'
  | 'cache'
  | 'context'
  | 'skills'
  | 'tokens'
  | 'title'
  | 'goal'
  | 'sandbox'
  | 'permission'

/** Picker-facing metadata for one customizable item. */
export interface StatusItemInfo {
  id: StatusItemId
  /** Short picker label. */
  label: string
  /** One-line picker description of what the item shows. */
  description: string
  /** Which side of the split row the item renders on. */
  side: 'left' | 'right'
}

/** The full item catalog in canonical order (the /statusline default). */
export const STATUS_ITEMS: readonly StatusItemInfo[] = [
  { id: 'model', label: 'model', description: 'provider/model serving this session', side: 'left' },
  { id: 'cwd', label: 'cwd', description: 'working-directory basename', side: 'left' },
  { id: 'mode', label: 'mode', description: 'agent preset composing the session', side: 'left' },
  { id: 'branch', label: 'branch', description: 'git branch inside a repository', side: 'left' },
  { id: 'context', label: 'context', description: 'context-window occupancy meter', side: 'left' },
  { id: 'skills', label: 'skills', description: 'skills loaded in the session catalog', side: 'left' },
  { id: 'permission', label: 'permission', description: 'permission preset badge with cycle hint', side: 'right' },
  { id: 'plan', label: 'plan', description: 'plan-mode state mark', side: 'left' },
  { id: 'turns', label: 'turns', description: 'turn and step counters', side: 'left' },
  { id: 'durations', label: 'durations', description: 'llm/ttft/decode/tool wall time', side: 'left' },
  { id: 'cache', label: 'cache', description: 'cache-hit share of billed input', side: 'left' },
  { id: 'tokens', label: 'tokens', description: 'cumulative input/output tokens', side: 'left' },
  { id: 'title', label: 'title', description: 'session title or short id', side: 'left' },
  { id: 'goal', label: 'goal', description: 'live goal phase and round progress', side: 'left' },
  { id: 'sandbox', label: 'sandbox', description: 'divergent sandbox-mode override', side: 'left' },
]

/**
 * Default order: the whole catalog (matches the pre-customization bar).
 * The busy dot is not an item — it always leads the identity cluster.
 */
export const DEFAULT_STATUSLINE_ITEMS: readonly StatusItemId[] = ['model', 'permission', 'title', 'plan', 'goal', 'sandbox', 'skills']

/**
 * Parse a persisted statusline item list. The stored value is the ordered
 * set of ENABLED items (the Codex /statusline contract): unknown ids and
 * duplicates drop out, and a non-array value (missing or corrupt file)
 * falls back to the full default set. An explicitly empty array is valid —
 * the bar degrades to its busy dot alone.
 * @param value - the raw parsed JSON value (expected string[]).
 * @returns the normalized ordered item list.
 */
export function parseStatuslineItems(value: unknown): readonly StatusItemId[] {
  if (!Array.isArray(value)) return [...DEFAULT_STATUSLINE_ITEMS]
  const known = new Set(STATUS_ITEMS.map(item => item.id))
  const kept: StatusItemId[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && known.has(entry as StatusItemId) && !kept.includes(entry as StatusItemId)) {
      kept.push(entry as StatusItemId)
    }
  }
  return kept
}

/** Minimum blank gap kept between the leading and trailing sides. */
const LEFT_RIGHT_GAP = 2
/** Column held back so Ink/yoga measurement drift can never force a wrap. */
const WIDTH_SAFETY = 1
/**
 * Extra left padding on the secondary row so its content aligns with the
 * model name's left edge on the primary row (padding 2 + busy dot 2). The
 * layout subtracts it from row 2's budget so the indent can never wrap it.
 */
export const STATUS_ROW2_INDENT = 2
/** Column budget for the session title before it ellipsizes. */
const TITLE_BUDGET = 48

/**
 * Primary-row drop ranks: context drops before permission; the identity
 * cluster never drops and ellipsizes only after the right badge is gone.
 * Secondary-row groups reuse the remaining ranks independently.
 */
const RANK_TITLE = 10
const RANK_TOKENS = 50
const RANK_COUNTS = 90
const RANK_CONTEXT = 90
const RANK_SANDBOX = 92
const RANK_GOAL = 95
const RANK_BADGE = 100
const RANK_IDENTITY = Number.POSITIVE_INFINITY

/** Row 2 drop ranks: title and durations go first; state and counts survive longest. */
const RANK2_DURATIONS = 40
const RANK2_CACHE = 50
const RANK2_SKILLS = 60
const RANK2_PLAN = 70
/** The live telemetry cluster is the last row-2 group to go: it carries the running cost. */
const RANK2_TELEMETRY = 95

/** Identity facts the runner resolves once at mount; empty strings drop out. */
export interface StatusFacts {
  /** 'provider/model' selection serving this session. */
  model: string
  /** Agent preset composing this session. */
  mode?: string
  /** Working-directory basename the session serves. */
  cwd: string
  /** Git branch name, empty outside a repository or on a detached HEAD file. */
  branch: string
  /** Short session identifier (last dash-separated segment or tail). */
  sessionId: string
  /** Latest session title (folded from 'session/title'); shown in place of the id. */
  title: string
  /** Sandbox-mode override (folded from 'sandbox/mode'), empty when never switched. */
  sandbox: string
  /** Live goal summary (folded from 'goal/change'), undefined when none. */
  goal: { phase: string; rounds: number; max: number } | undefined
  /** Whether plan mode is active (folded from 'plan/mode'). */
  plan: boolean
  /** Active or pending permission preset; empty only when the service is unavailable. */
  permission: string
  /** dscode: full session identity the footer telemetry reads its live metrics from. */
  fullSessionId: string
  /** dscode: the live metrics cluster (tps / context / spend / cache) that closes row 2. */
  telemetry?: string
  /** Independently laid-out figures from the same metrics snapshot. */
  telemetryFigures?: {
    current: string
    average: string
    context: string
    money: string
    cache: string
    turn: string
  }
  /** Effort for facts.model; an absent value never inherits an older request's effort. */
  effort?: string
  /** dscode: the effective skill-catalog size; undefined until the first catalog read settles. */
  skills?: number
}

/**
 * Traffic-light tone for a permission preset: read-only stays success green,
 * full access reads error red, and every workspace-scoped middle ground
 * (including unknown presets) reads warning amber.
 * @param permission - active permission preset label.
 * @returns tone for the badge span.
 */
export function permissionTone(permission: string): StatusTone {
  const label = permission.toLowerCase()
  if (label.includes('read')) return 'success'
  if (label.includes('danger') || label.includes('full')) return 'error'
  return 'warn'
}

/** Display-safe external text: one row, controls escaped. */
function safe(text: string): string {
  return singleLineText(text)
}

/** Dim junction separator span inside a cluster. */
function sep(): StatusSpan {
  return { text: ' · ', tone: 'label' }
}

/** Total visible columns of a span list (separators ride inside the spans). */
function spansWidth(spans: readonly StatusSpan[]): number {
  let width = 0
  for (const span of spans) width += visibleColumns(span.text)
  return width
}

/** Join widths of parts with one fixed separator between neighbors. */
function joinWidth(parts: readonly number[], separator: number): number {
  if (parts.length === 0) return 0
  let width = 0
  for (const part of parts) width += part
  return width + separator * (parts.length - 1)
}

/** dscode: row 1's identity lead — the session title, else the session id. */
function dscodeStatusLead(facts: StatusFacts): string {
  const source = facts.title !== undefined && facts.title !== '' ? facts.title : facts.sessionId
  return source === undefined || source === '' ? '' : truncateColumns(safe(source), TITLE_BUDGET)
}

/** Build every candidate group/span with its drop rank and item id. */
function buildCandidates(
  facts: StatusFacts,
  stats: TranscriptStats,
  busy: boolean,
  enabled: ReadonlySet<string>,
  contextWidth: number,
): {
  left: { group: StatusGroup; rank: number; id: string }[]
  right: { span: StatusSpan; rank: number; id: string }[]
  badge: number
  row2: { group: StatusGroup; rank: number; id: string }[]
} {
  const identity: StatusSpan[] = [
    { text: busy ? '● ' : '○ ', tone: busy ? 'live' : 'meta' },
  ]
  // The dot glues straight to the first fact; further facts join through
  // explicit dim separators, so an absent model never strands a leading ' · '.
  const push = (span: StatusSpan): void => {
    if (identity.length > 1) identity.push(sep())
    identity.push(span)
  }
  const model = safe(facts.model).split('/').at(-1) ?? ''
  // dscode: row 1 names the session (title, else its id) and then the model with
  // its effort, so row 2 stays free for the live figures.
  if ((model !== '' && enabled.has('model')) || enabled.has('title')) {
    const lead = dscodeStatusLead(facts)
    if (lead !== '') push({ text: lead, tone: 'model' })
  }
  if (model !== '' && enabled.has('model')) {
    const effort = safe(facts.effort ?? '')
    push({ text: effort === '' ? model : model + ' @ ' + effort, tone: 'accent' })
  }
  const cwd = safe(facts.cwd)
  if (cwd !== '' && enabled.has('cwd')) push({ text: cwd, tone: 'path' })
  const mode = safe(facts.mode ?? '')
  if (mode !== '' && enabled.has('mode')) {
    push({ text: t('status.label.mode') + ' ', tone: 'label' })
    identity.push({ text: mode, tone: 'accent' })
  }
  const branch = safe(facts.branch)
  if (branch !== '' && enabled.has('branch')) push({ text: '⑂ ' + branch, tone: 'branch' })

  const left: { group: StatusGroup; rank: number; id: string }[] = [
    { group: { spans: identity }, rank: RANK_IDENTITY, id: 'identity' },
  ]
  const right: { span: StatusSpan; rank: number; id: string }[] = []
  const row2: { group: StatusGroup; rank: number; id: string }[] = []



  if (enabled.has('turns')) {
    // Label/value pairs join through explicit dim separators. The counters ride
    // the footer from the first frame on, so a turn opening one never moves the
    // row.
    const counts: StatusSpan[] = []
    const pair = (label: string, value: string): void => {
      if (counts.length > 0) counts.push(sep())
      counts.push({ text: label + ' ', tone: 'label' }, { text: value, tone: 'value' })
    }
    pair(t('status.label.turns'), padValue(String(stats.turns), VALUE_WIDTH.count))
    pair(t('status.label.steps'), padValue(String(stats.steps), VALUE_WIDTH.count))
    row2.push({ group: { spans: counts }, rank: RANK_COUNTS, id: 'turns' })
  }
  if (enabled.has('durations')) {
    // Model round-trip, first-token latency, decode rate, and tool wall
    // time; the label keeps its one trailing space so each reads as one
    // figure ('model 45.2s'). Named in full — no single-letter codes. A figure
    // without a reading yet keeps its columns as `--`.
    const durations: StatusSpan[] = []
    const pair = (label: string, value: string): void => {
      if (durations.length > 0) durations.push(sep())
      durations.push({ text: label + ' ', tone: 'label' }, { text: value, tone: 'value' })
    }
    const wall = (ms: number): string => ms > 0
      ? padValue(formatDuration(ms), VALUE_WIDTH.duration)
      : pendingValue(VALUE_WIDTH.duration)
    pair(t('status.label.modelTime'), wall(stats.llmMs))
    pair(t('status.label.latency'), stats.ttftSteps > 0 ? wall(stats.ttftMs / stats.ttftSteps) : pendingValue(VALUE_WIDTH.duration))
    if (durations.length > 0) durations.push(sep())
    durations.push(
      {
        text: stats.decodeMs > 0 && stats.decodeTokens > 0
          ? padValue(formatRate(stats.decodeTokens / (stats.decodeMs / 1_000)), VALUE_WIDTH.rate)
          : pendingValue(VALUE_WIDTH.rate),
        tone: 'value',
      },
      { text: t('status.label.tokensPerSec'), tone: 'label' },
    )
    pair(t('status.label.tool'), wall(stats.toolMs))
    row2.push({ group: { spans: durations }, rank: RANK2_DURATIONS, id: 'durations' })
  }

  // The cache group carries both facts about cached prompt tokens: how many
  // were read and what share of the billed prompt that was. The read count
  // lives here rather than in the tokens group so the tokens group keeps
  // meaning "what the provider billed outside the cache".
  // An unread cache keeps its columns as the `--` placeholder.
  const cacheHit = cacheHitPercent(stats.usage)
  if (enabled.has('cache')) {
    const spans: StatusSpan[] = [{ text: t('status.label.cache') + ' ', tone: 'label' }]
    spans.push({
      text: stats.usage.cacheReadTokens > 0
        ? padValue(formatTokens(stats.usage.cacheReadTokens), VALUE_WIDTH.tokens)
        : pendingValue(VALUE_WIDTH.tokens),
      tone: 'value',
    })
    spans.push(sep())
    spans.push({ text: cacheHit === null ? pendingValue(VALUE_WIDTH.percentShare) : padValue(cacheHit + '%', VALUE_WIDTH.percentShare), tone: 'value' })
    row2.push({ group: { spans }, rank: RANK2_CACHE, id: 'cache' })
  }
  // Context occupancy as a purely proportional bar with the usage readout
  // riding outside it: the used total is the most recent reported prompt
  // size against the advertised route capacity.
  if (enabled.has('context')) {
    left.push({
      group: {
        spans: contextGroupSpans(stats.lastPromptTokens, stats.contextWindow, contextWidth, 'full'),
      },
      rank: RANK_CONTEXT,
      id: 'context',
    })
  }
  // The token totals keep their columns from the first frame on: an unread
  // total shows its zero in the same width instead of taking the group out.
  if (enabled.has('tokens')) {
    const tokens: StatusSpan[] = []
    const pair = (label: string, value: string): void => {
      if (tokens.length > 0) tokens.push(sep())
      tokens.push({ text: label + ' ', tone: 'label' }, { text: value, tone: 'value' })
    }
    pair(t('status.label.in'), padValue(formatTokens(stats.usage.uncachedInputTokens), VALUE_WIDTH.tokens))
    pair(t('status.label.out'), padValue(formatTokens(stats.usage.outputTokens), VALUE_WIDTH.tokens))
    row2.push({ group: { spans: tokens }, rank: RANK_TOKENS, id: 'tokens' })
  }

  // dscode: the catalog size the session actually sees, read from the live
  // skills view, so the footer answers "how many skills are loaded" without
  // opening /skills. Before the first read settles the figure keeps its
  // columns as the `--` placeholder, like every other live figure.
  if (enabled.has('skills')) {
    row2.push({
      group: {
        spans: [
          { text: t('status.label.skills') + ' ', tone: 'label' },
          {
            text: facts.skills === undefined
              ? pendingValue(VALUE_WIDTH.count)
              : padValue(String(facts.skills), VALUE_WIDTH.count),
            tone: 'value',
          },
        ],
      },
      rank: facts.telemetryFigures === undefined ? RANK2_SKILLS : 100,
      id: 'skills',
    })
  }

  // dscode: the session title moved to row 1's identity lead (dscodeStatusLead),
  // so row 2 no longer carries it.

  // Secondary state rides row 2; permission alone remains right-pinned on row 1.
  if (facts.goal !== undefined && enabled.has('goal')) {
    row2.push({
      group: {
        spans: [{
          text: facts.goal.phase === 'active'
            ? '◎ round ' + facts.goal.rounds + '/' + facts.goal.max
            : '◎ ' + safe(facts.goal.phase),
          tone: 'accent',
        }],
      },
      rank: RANK_GOAL,
      id: 'goal',
    })
  }
  // The sandbox override stays implicit when it merely echoes the preset.
  const sandbox = safe(facts.sandbox ?? '')
  if (sandbox !== '' && sandbox.toLowerCase() !== facts.permission.toLowerCase() && enabled.has('sandbox')) {
    row2.push({ group: { spans: [{ text: 'sandbox ' + sandbox, tone: 'warn' }] }, rank: RANK_SANDBOX, id: 'sandbox' })
  }
  const permission = safe(facts.permission)
  let badge = -1
  // The plan STATION names itself in the permission badge: with the most
  // restrictive preset active, plan mode reads as the green fourth cycle
  // station 'plan' (that preset IS the station's permission layer). Plan on
  // any other preset (a typed /plan mid-session) stays orthogonal: the badge
  // keeps naming the preset and row 2 carries the green plan marker.
  const planStation = facts.plan && permissionTone(permission) === 'success'
  // dscode: the permission badge anchors row 1's right edge, so the left
  // clusters (title, cwd, mode, branch, context) grow and shrink under it
  // without ever moving it.
  if (permission !== '' && enabled.has('permission')) {
    right.push({
      span: planStation
        ? { text: 'plan on', tone: 'plan' }
        : { text: permission, tone: permissionTone(permission) },
      rank: RANK_BADGE,
      id: 'permission',
    })
    badge = right.length - 1
  }
  if (facts.plan && enabled.has('plan')) {
    row2.push({ group: { spans: [{ text: '⧉ plan', tone: 'accent' }] }, rank: RANK2_PLAN, id: 'plan' })
  }
  // Structured runtime figures sit on the left; finances are placed separately
  // after fitting that row. Keep the flat form for older text-only callers.
  if (facts.telemetryFigures !== undefined) {
    const figures = facts.telemetryFigures
    for (const [id, text, rank] of [
      ['telemetry-current', figures.current, 95],
      ['telemetry-average', figures.average, 30],
      ['telemetry-context', figures.context, 94],
    ] as const) {
      if (text !== '') row2.push({ group: { spans: [{ text, tone: 'meta' }] }, rank, id })
    }
  } else if (facts.telemetry !== undefined && facts.telemetry !== '') {
    row2.push({ group: { spans: [{ text: facts.telemetry, tone: 'meta' }] }, rank: RANK2_TELEMETRY, id: 'telemetry' })
  }
  return { left, right, badge, row2 }
}

/**
 * Compose the responsive footer layout under a column budget. Row 1 keeps the
 * session identity, cwd, mode, branch, context, then the right-pinned permission
 * badge and cycle hint. It drops hint, context, and permission before
 * ellipsizing identity. Row 2 fits all secondary figures, the live telemetry
 * cluster and state within its own budget.
 * @param facts - identity facts resolved by the runner.
 * @param stats - session figures folded from the durable log.
 * @param columns - usable columns for each row (before their left padding).
 * @param options - 'busy' hides the cycle hint while a turn runs (Codex
 * keeps mode hints idle-only); 'items' is the ordered enabled-item config
 * from /statusline (defaults to the full catalog). Display order follows the
 * config per side while the drop ladder keeps its fixed ranks.
 * @returns the rows to render; row1.left is never empty.
 */
export function layoutStatusBar(
  facts: StatusFacts,
  stats: TranscriptStats,
  columns: number,
  options: { busy?: boolean; items?: readonly string[]; contextWidth?: number } = {},
): StatusLayout {
  const busy = options.busy === true
  const items = options.items ?? DEFAULT_STATUSLINE_ITEMS
  const enabled = new Set(items)
  const budget = Math.max(1, Math.floor(columns) - WIDTH_SAFETY)
  // The context meter shares the same measured width as the composer. Its
  // initial width is a ceiling only; the drop ladder below shrinks it around
  // the other status groups before dropping any group.
  const maxContextWidth = Math.max(CONTEXT_MIN_WIDTH, Math.min(budget, Math.floor(options.contextWidth ?? CONTEXT_BAR_WIDTH)))
  const { left, right, badge, row2 } = buildCandidates(facts, stats, busy, enabled, maxContextWidth)
  const groupSeparator = visibleColumns(STATUS_GROUP_SEPARATOR)
  const itemSeparator = visibleColumns(STATUS_ITEM_SEPARATOR)

  // Display order follows the config per side (Codex /statusline reorder).
  // The identity cluster stays anchored first — it owns the busy dot.
  const position = new Map(items.map((id, index) => [id, index]))
  const byPosition = (a: { id: string }, b: { id: string }): number =>
    (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER)
  const orderedLeft = [left[0], ...left.slice(1).sort(byPosition)]
  const orderedRight = right.slice().sort(byPosition)
  const orderedRow2 = facts.telemetryFigures === undefined ? row2.slice().sort(byPosition) : [
    ...row2.filter(entry => entry.id.startsWith('telemetry-')),
    ...row2.filter(entry => !entry.id.startsWith('telemetry-')).sort(byPosition),
  ]

  // The cycle hint keeps its columns reserved whether or not it is painted:
  // the badge anchors the right edge, so a turn opening or closing must not
  // change what the left clusters may occupy.
  let hint = badge >= 0 && !busy
  let hintWidth = badge >= 0 ? visibleColumns(statusCycleHint()) : 0
  const leftKept = [...orderedLeft]
  const rightKept = [...orderedRight]

  // Columns the hint reserves: its own text plus the item separator that
  // joins it to a right cluster, so an idle and a running turn measure the
  // row identically.
  const hintSlot = (): number => hintWidth > 0 && rightKept.length > 0 ? hintWidth + itemSeparator : hintWidth

  // Context degradation state: the readout drops its absolute pair first,
  // then the bar shrinks inside its own budget, and only then is the whole
  // group removed — the proportional meter outlives the auxiliary numbers.
  // Rebuilding replaces the group's spans in place so width() re-measures it.
  let contextReadout: ContextReadoutMode = 'full'
  let contextWidth = maxContextWidth
  const rebuildContext = (): void => {
    const index = leftKept.findIndex(entry => entry.id === 'context')
    if (index < 0) return
    leftKept[index] = {
      group: {
        spans: contextGroupSpans(stats.lastPromptTokens, stats.contextWindow, contextWidth, contextReadout),
      },
      rank: RANK_CONTEXT,
      id: 'context',
    }
  }

  const width = (): number => {
    const leftWidth = joinWidth(
      leftKept.map(entry => spansWidth(entry.group.spans)),
      groupSeparator,
    )
    const rightWidth = joinWidth(rightKept.map(entry => visibleColumns(entry.span.text)), itemSeparator)
      + hintSlot()
    return rightWidth > 0 ? leftWidth + LEFT_RIGHT_GAP + rightWidth : leftWidth
  }

  while (width() > budget) {
    // Context is the lowest-priority visual group: the bar shrinks inside
    // its own budget first (the absolute readout survives), then the
    // readout degrades to the bare percent, and only then does the whole
    // group go — before the permission badge or its Shift+Tab affordance
    // is touched.
    if (leftKept.some(entry => entry.id === 'context')) {
      if (contextWidth > CONTEXT_MIN_WIDTH) {
        const overflow = width() - budget
        contextWidth = Math.max(CONTEXT_MIN_WIDTH, contextWidth - overflow)
        rebuildContext()
        continue
      }
      if (contextReadout === 'full') {
        contextReadout = 'percent'
        rebuildContext()
        continue
      }
      leftKept.splice(leftKept.findIndex(entry => entry.id === 'context'), 1)
      continue
    }
    if (hintWidth > 0 && rightKept.length > 0 && leftKept.length > 0) {
      const identity = leftKept[0]
      const identityText = identity.group.spans.map(span => span.text).join('')
      const rightWidth = joinWidth(rightKept.map(entry => visibleColumns(entry.span.text)), itemSeparator)
      const identityBudget = budget - rightWidth - LEFT_RIGHT_GAP - hintSlot()
      if (identityBudget > 0 && visibleColumns(identityText) > identityBudget) {
        leftKept[0] = {
          ...identity,
          group: { spans: [{ text: truncateColumns(identityText, identityBudget), tone: 'model' }] },
        }
        continue
      }
    }
    if (hintWidth > 0) {
      hint = false
      hintWidth = 0
      continue
    }
    let dropLeft = -1
    let dropRight = -1
    let dropRank = Number.POSITIVE_INFINITY
    for (let index = 0; index < leftKept.length; index += 1) {
      const rank = leftKept[index].rank
      if (rank < dropRank) {
        dropRank = rank
        dropLeft = index
        dropRight = -1
      }
    }
    for (let index = 0; index < rightKept.length; index += 1) {
      const rank = rightKept[index].rank
      if (rank < dropRank) {
        dropRank = rank
        dropRight = index
        dropLeft = -1
      }
    }
    if (dropLeft < 0 && dropRight < 0) break
    if (dropLeft >= 0) {
      leftKept.splice(dropLeft, 1)
    } else {
      rightKept.splice(dropRight, 1)
      if (dropRight === rightKept.length) hint = false
    }
  }

  // Only the identity cluster can remain overflowing: collapse to it and
  // ellipsize inside the budget as the last resort. Flat spans make the
  // joined text identical to what the row would have displayed.
  if (width() > budget) {
    rightKept.length = 0
    hint = false
    while (leftKept.length > 1) leftKept.pop()
    const identity = leftKept[0].group
    const joined = identity.spans.map(span => span.text).join('')
    leftKept[0] = {
      group: { spans: [{ text: truncateColumns(joined, budget), tone: 'model' }] },
      rank: RANK_IDENTITY,
      id: 'identity',
    }
  }

  // Row 2 fits its own budget minus the model-name indent; the lowest-rank
  // group drops first until the row fits or nothing is left. An empty row2 is
  // a valid state — the footer degrades back to a single status row.
  const row2Kept = [...orderedRow2]
  const row2Budget = Math.max(0, budget - 1)
  const row2Width = (): number =>
    joinWidth(row2Kept.map(entry => spansWidth(entry.group.spans)), groupSeparator)
  while (row2Width() > row2Budget && row2Kept.length > 0) {
    let dropIndex = 0
    let dropRank = Number.POSITIVE_INFINITY
    for (let index = 0; index < row2Kept.length; index += 1) {
      if (row2Kept[index].rank < dropRank) {
        dropRank = row2Kept[index].rank
        dropIndex = index
      }
    }
    row2Kept.splice(dropIndex, 1)
  }

  // Keep fees, balance, peak/off-peak and cache together. Move the group down
  // before sacrificing left-side figures just to seat it on the same row.
  const figures = facts.telemetryFigures
  let financial: StatusSpan[] = []
  if (figures !== undefined) {
    const parts = [figures.money, figures.turn, figures.cache].filter(Boolean)
    let text = parts.join(STATUS_ITEM_SEPARATOR)
    // The optional per-turn cost goes first on extremely narrow terminals.
    if (visibleColumns(text) > row2Budget) text = [figures.money, figures.cache].filter(Boolean).join(STATUS_ITEM_SEPARATOR)
    financial = [{ text: truncateColumns(text, row2Budget), tone: 'meta', telemetry: true }]
  }
  const financialWidth = spansWidth(financial)
  const financialWrap = financial.length > 0 && row2Kept.length > 0
    && row2Width() + LEFT_RIGHT_GAP + financialWidth > row2Budget

  return {
    row1: {
      left: leftKept.map(entry => ({ ...entry.group, id: entry.id })),
      right: rightKept.map(entry => entry.span),
      hint,
    },
    row2: {
      left: row2Kept.map(entry => ({ ...entry.group, id: entry.id })),
      right: financialWrap ? [] : financial,
      hint: false,
    },
    ...(financialWrap ? { row3: { left: [], right: financial, hint: false } } : {}),
  }
}
