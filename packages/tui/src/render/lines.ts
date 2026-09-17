/** Width-safe styled physical rows for bounded terminal panels. */

import { promptDisplayText, type TranscriptEntry, type ToolEntry } from './projection.ts'
import type { ToolDetail } from './tool-detail.ts'
import { renderMarkdown, visibleColumns, type MdStyle } from './markdown.ts'
import { graphemeWidth, splitGraphemes } from './width.ts'
import { formatTokens, displayText, truncateColumns } from './text.ts'
import { t } from '../i18n.ts'

/** Trailing marker naming how a settled prompt was delivered; '' for ordinary. */
function deliveryMarker(delivery: 'queued' | 'steered' | undefined): string {
  if (delivery === 'queued') return t('entry.delivery.queued')
  if (delivery === 'steered') return t('entry.delivery.steered')
  return ''
}

/** Presentation classes mapped to Ink colors by the app boundary. */
export type LineStyle = MdStyle | 'brand' | 'success' | 'error' | 'warn' | 'dimItalic' | 'diffAdd' | 'diffDel'
  | 'promptRow' | 'promptQueuedRow' | 'promptSteeredRow'

/** One styled run within a physical terminal row. */
export interface StyledSegment {
  text: string
  style: LineStyle
}

/** One row guaranteed not to exceed the requested terminal width. */
export interface StyledLine {
  segments: readonly StyledSegment[]
  /** dscode: whole-row background band (the wrapped user prompt). */
  background?: 'user'
}

/** Construct one segment without leaking mutable objects into cached rows. */
export function lineSegment(text: string, style: LineStyle = 'plain'): StyledSegment {
  return { text, style }
}

/**
 * Classify one unified-diff row for coloring: additions and deletions carry
 * the diff tint styles (background on rich terminals), hunk headers and file
 * markers stay brand-blue, and everything else is dim context.
 */
export function diffLineStyle(line: string): LineStyle {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diffAdd'
  if (line.startsWith('-') && !line.startsWith('---')) return 'diffDel'
  if (line.startsWith('@@') || line.startsWith('diff --git') || line.startsWith('index ')) return 'brand'
  return 'dim'
}

/**
 * Extend pure diff-tinted rows to the full width with same-styled padding so
 * the tint reads as one unbroken bar (GitHub-style), including wrapped
 * continuation rows; mixed or non-diff rows pass through untouched.
 */
export function fillDiffLineBars(lines: readonly StyledLine[], columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  let changed = false
  const filled = lines.map(line => {
    const style = line.segments[0]?.style
    if (style !== 'diffAdd' && style !== 'diffDel') return line
    if (line.segments.some(segment => segment.style !== style)) return line
    const used = visibleColumns(line.segments.map(segment => segment.text).join(''))
    const pad = width - used
    if (pad <= 0) return line
    changed = true
    return { segments: [...line.segments, lineSegment(' '.repeat(pad), style)] }
  })
  // Identity-stable when nothing needed padding: callers cache row arrays.
  return changed ? filled : lines
}

/** Append a character while merging adjacent runs with the same style. */
function appendSegment(target: StyledSegment[], text: string, style: LineStyle): void {
  const previous = target[target.length - 1]
  if (previous?.style === style) {
    target[target.length - 1] = { text: previous.text + text, style }
    return
  }
  target.push({ text, style })
}

/**
 * Sanitize and hard-wrap styled content into exact physical rows.
 * Tabs become two visible spaces because terminal tab stops are contextual
 * and therefore cannot participate in a deterministic row budget.
 */
export function styledLines(segments: readonly StyledSegment[], columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  const lines: StyledLine[] = []
  let current: StyledSegment[] = []
  let used = 0
  const flush = (): void => {
    lines.push({ segments: current })
    current = []
    used = 0
  }

  for (const segment of segments) {
    const safe = displayText(segment.text).replaceAll('\t', '  ').replaceAll('\r', '')
    // Grapheme clusters, never bare code points: a ZWJ family or a flag is
    // one terminal cell run, and splitting it would both split the glyph
    // across rows and double-count its width against the budget.
    for (const cluster of splitGraphemes(safe)) {
      if (cluster === '\n') {
        flush()
        continue
      }
      const cells = graphemeWidth(cluster)
      if (used > 0 && used + cells > width) flush()
      appendSegment(current, cluster, segment.style)
      used += cells
    }
  }
  if (current.length > 0 || lines.length === 0) flush()
  return lines
}

/** Plain/dim text convenience over {@link styledLines}. */
export function textLines(text: string, columns: number, style: LineStyle = 'plain'): readonly StyledLine[] {
  return styledLines([lineSegment(text, style)], columns)
}

/** Prefix every wrapped physical row without exceeding the column budget. */
function prefixedStyledLines(segments: readonly StyledSegment[], columns: number, prefix: string, prefixStyle: LineStyle = 'plain'): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  // Keep one column for the body even when the prefix alone would fill the
  // row: a prefix allowed to claim the whole width pushed prefix+body one
  // column past the budget on very narrow terminals.
  const prefixWidth = Math.min(width - 1, visibleColumns(prefix))
  const bodyWidth = Math.max(1, width - prefixWidth)
  return styledLines(segments, bodyWidth).map(line => ({
    segments: [lineSegment(prefix, prefixStyle), ...line.segments],
  }))
}

/** Text convenience for a tool row whose continuation must keep its gutter. */
function prefixedTextLines(text: string, columns: number, prefix: string, style: LineStyle = 'plain'): readonly StyledLine[] {
  return prefixedStyledLines([lineSegment(text, style)], columns, prefix, style)
}

/**
 * Wrap styled segments with a hanging indent: the first physical row carries
 * `firstPrefix` (often a marker plus gutter) and every wrapped continuation
 * carries the narrower `contPrefix`, so long tool summaries and prompts
 * align under their card instead of falling back to column zero. The first
 * row may hold one prefix-width more than the continuations.
 */
export function hangingStyledLines(
  segments: readonly StyledSegment[],
  columns: number,
  firstPrefix: string,
  firstStyle: LineStyle,
  contPrefix: string,
  contStyle: LineStyle = firstStyle,
): readonly StyledLine[] {
  const width = Math.max(2, Math.floor(columns))
  const firstPrefixText = truncateColumns(firstPrefix, Math.max(1, width - 1))
  const contPrefixText = truncateColumns(contPrefix, Math.max(1, width - 1))
  const firstBudget = Math.max(1, width - visibleColumns(firstPrefixText))
  const contBudget = Math.max(1, width - visibleColumns(contPrefixText))
  const lines: StyledLine[] = []
  let current: StyledSegment[] = []
  let used = 0
  let budget = firstBudget
  const flush = (): void => {
    lines.push({ segments: current })
    current = []
    used = 0
    budget = contBudget
  }
  for (const segment of segments) {
    const safe = displayText(segment.text).replaceAll('\t', '  ').replaceAll('\r', '')
    for (const cluster of splitGraphemes(safe)) {
      if (cluster === '\n') {
        flush()
        continue
      }
      const cells = graphemeWidth(cluster)
      if (used > 0 && used + cells > budget) flush()
      appendSegment(current, cluster, segment.style)
      used += cells
    }
  }
  if (current.length > 0 || lines.length === 0) flush()
  return lines.map((line, index) => ({
    segments: [
      lineSegment(index === 0 ? firstPrefixText : contPrefixText, index === 0 ? firstStyle : contStyle),
      ...line.segments,
    ],
  }))
}

/** Plain-text convenience over {@link hangingStyledLines}. */
export function hangingTextLines(
  text: string,
  columns: number,
  firstPrefix: string,
  firstStyle: LineStyle = 'plain',
  contPrefix = '  ',
  contStyle: LineStyle = firstStyle,
): readonly StyledLine[] {
  return hangingStyledLines([lineSegment(text, firstStyle)], columns, firstPrefix, firstStyle, contPrefix, contStyle)
}

/** Markdown rows re-hardened so a single long word cannot escape the budget. */
export function markdownLines(text: string, columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  // The markdown pass formats at the real width — a 10-column floor on a
  // narrower terminal silently pushed rows past the budget (styledLines
  // re-hardens long words at `width` either way).
  const parsed = renderMarkdown(displayText(text), width)
  const rows = parsed.flatMap(line => styledLines(
    line.segments.map(segment => lineSegment(segment.text, segment.style)),
    width,
  ))
  // ```diff fence rows fill their full width so pasted diffs read as bars.
  return fillDiffLineBars(rows, width)
}

/**
 * Codex-style reasoning rows: the marker occupies the reply gutter and every
 * wrapped or explicit continuation starts with the same two-column indent, so
 * reasoning content and assistant Markdown share one left edge.
 */
export function reasoningLines(text: string, columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  if (width < 3) return textLines(text, width, 'dimItalic')
  const contentWidth = width - 2
  const content = displayText(text).replaceAll('\t', '  ').replaceAll('\r', '')
    .split('\n')
    .flatMap(line => styledLines([lineSegment(line, 'dimItalic')], contentWidth))
  return content.map((line, index) => ({
    segments: [
      lineSegment(index === 0 ? '✻ ' : '  ', 'dimItalic'),
      ...line.segments,
    ],
  }))
}

/** Expanded structured tool detail as scrollable, width-safe rows. */
/**
 * Detail rows share the tool card's four-column hanging gutter: the summary
 * (⎿) and delegation prompt (└) continuations already sit at four columns, so
 * diff/read/web/raw rows align under them instead of floating two columns
 * shallower.
 */
function toolDetailLines(detail: ToolDetail, columns: number): readonly StyledLine[] {
  switch (detail.kind) {
    case 'diff':
      return detail.diffs.flatMap(diff => [
        ...prefixedTextLines(`${diff.path}${diff.truncated ? ' (diff truncated)' : ''}`, columns, '    ── ', 'dim'),
        ...fillDiffLineBars(diff.lines.flatMap(line => prefixedTextLines(
          `${line.mark}${line.text}`,
          columns,
          '    ',
          line.mark === '+' ? 'diffAdd' : line.mark === '-' ? 'diffDel' : 'dim',
        )), columns),
      ])
    case 'read':
      return [
        ...prefixedTextLines(
          `${detail.path} · lines ${detail.offset}-${detail.lines.length > 0 ? detail.lines[detail.lines.length - 1].number : detail.offset - 1} of ${detail.totalLines}${detail.truncated ? ' (window truncated)' : ''}`,
          columns,
          '    ── ',
          'dim',
        ),
        ...detail.lines.flatMap(line => prefixedTextLines(`${String(line.number).padStart(5, ' ')} | ${line.text}`, columns, '    ', 'dim')),
      ]
    case 'web-search':
      return [
        ...detail.sources.flatMap(source => [
          ...prefixedStyledLines([
            lineSegment(source.title ?? source.url, 'brand'),
            lineSegment(` - ${source.url}`, 'dim'),
          ], columns, '    ? '),
          ...(source.snippet === '' ? [] : prefixedTextLines(source.snippet, columns, '      ', 'dim')),
        ]),
        ...prefixedTextLines(`${detail.sources.length} sources${detail.truncated ? ' (capped)' : ''}`, columns, '    ', 'dim'),
      ]
    case 'web-fetch':
      return prefixedTextLines(`${detail.url} · HTTP ${detail.statusCode}`, columns, '    ', 'dim')
    case 'raw':
      return [
        ...prefixedTextLines(detail.text, columns, '    ', 'dim'),
        ...prefixedTextLines(detail.truncated ? '… (output truncated)' : '(end of output)', columns, '    ', 'dim'),
      ]
    default: {
      const exhaustive: never = detail
      return exhaustive
    }
  }
}

/**
 * Style the lines of one user prompt for display: plain verbatim, except
 * inside ```diff / ```patch fences where added and removed lines take the
 * shared diff tints (the review prompt pastes its diff this way, and the
 * user row does not go through the markdown renderer). The fence markers
 * and file headers stay plain.
 */
export function userPromptSegments(text: string): readonly StyledSegment[] {
  if (!text.includes('```')) return [lineSegment(text, 'plain')]
  const segments: StyledSegment[] = []
  const lines = text.split('\n')
  let diffFence = false
  let inFence = false
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    const suffix = at === lines.length - 1 ? '' : '\n'
    if (line.trimStart().startsWith('```')) {
      const language = line.trim().slice(3).trim()
      inFence = !inFence
      diffFence = inFence && (language === 'diff' || language === 'patch')
      segments.push(lineSegment(line + suffix, 'plain'))
      continue
    }
    const style: LineStyle = !diffFence
      ? 'plain'
      : line.startsWith('+') && !line.startsWith('+++')
        ? 'diffAdd'
        : line.startsWith('-') && !line.startsWith('---')
          ? 'diffDel'
          : 'plain'
    segments.push(lineSegment(line + suffix, style))
  }
  return segments
}

/**
 * Full-row diff bars for mixed-gutter rows (user prompts): any row carrying
 * a diff tint takes it over entirely — gutter included — and pads to the
 * full width, so a pasted review diff reads as unbroken bars like the /diff
 * panel. Rows without a diff tint pass through untouched.
 */
function paintDiffRowBars(lines: readonly StyledLine[], columns: number): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  let changed = false
  const painted = lines.map(line => {
    const tint = line.segments.find(segment => segment.style === 'diffAdd' || segment.style === 'diffDel')?.style
    if (tint === undefined) return line
    changed = true
    const used = visibleColumns(line.segments.map(segment => segment.text).join(''))
    const pad = Math.max(0, width - used)
    return { segments: [...line.segments.map(segment => ({ text: segment.text, style: tint })), lineSegment(' '.repeat(pad), tint)] }
  })
  return changed ? painted : lines
}

/** Default compact tool-card window used while the Ctrl+R fold is closed. */
const DEFAULT_TOOL_ROWS = 3

/** The bar style one prompt row wears, chosen by how it was delivered. */
function promptRowStyle(delivery: 'queued' | 'steered' | undefined): LineStyle {
  if (delivery === 'queued') return 'promptQueuedRow'
  if (delivery === 'steered') return 'promptSteeredRow'
  return 'promptRow'
}

/**
 * Extend every row to the full width with the row's own style, so a prompt
 * bar reads as one unbroken block instead of stopping at the last glyph.
 * Rows already at width (or past it) pass through untouched.
 */
function fillRowBars(lines: readonly StyledLine[], columns: number, row: LineStyle): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  let changed = false
  const filled = lines.map(line => {
    const used = visibleColumns(line.segments.map(segment => segment.text).join(''))
    const pad = width - used
    if (pad <= 0) return line
    changed = true
    return { segments: [...line.segments, lineSegment(' '.repeat(pad), row)] }
  })
  return changed ? filled : lines
}

/**
 * Render one prompt as a full-width bar: the row style paints the glyph, the
 * text, the delivery marker, and the padding, while a ```diff fence pasted
 * into the prompt keeps its own green/red tint so the inner diff still reads
 * as a diff.
 */
function paintPromptRow(
  segments: readonly StyledSegment[],
  columns: number,
  row: LineStyle,
  glyph: string,
): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  const recolored = segments.map(segment =>
    segment.style === 'diffAdd' || segment.style === 'diffDel' ? segment : { ...segment, style: row })
  const lines = hangingStyledLines(recolored, width, glyph, row, '  ', row)
  // Diff bars pad themselves to the full width; only the remaining rows need
  // the prompt bar's padding.
  return fillRowBars(paintDiffRowBars(lines, width), width, row)
}

/** Format one sub-dispatch duration in seconds at tenth resolution. */
function subDispatchSeconds(durationMs: number): string {
  if (durationMs < 100) return ''
  return ` · ${Math.round(durationMs / 100) / 10}s`
}

/**
 * Nested PTC sub-dispatch rows under a `run_code` parent card: one bounded
 * row per child call (running keeps the brand pulse mark, errors carry the
 * bounded settle summary), plus a count row for evicted earlier dispatches.
 */
function subDispatchLines(entry: ToolEntry, columns: number): readonly StyledLine[] {
  if (entry.subs.length === 0) return []
  const width = Math.max(1, Math.floor(columns))
  const rows = entry.subs.flatMap(sub => {
    const mark = sub.state === 'running' ? '●' : sub.state === 'error' ? '⨯' : '⏺'
    const style: LineStyle = sub.state === 'running' ? 'brand' : sub.state === 'error' ? 'error' : 'dim'
    const label = sub.preview === '' ? sub.name : `${sub.name} ${sub.preview}`
    if (sub.state === 'error' && sub.summary !== '') {
      return textLines(`  ┆ ${mark} ${label} · ${sub.summary}${subDispatchSeconds(sub.durationMs)}`, width, style)
    }
    return textLines(`  ┆ ${mark} ${label}${subDispatchSeconds(sub.durationMs)}`, width, style)
  })
  if (entry.subsDropped === 0) return rows
  return [...rows, ...textLines(`  ┆ … ${entry.subsDropped} earlier dispatch${entry.subsDropped === 1 ? '' : 'es'}`, width, 'dim')]
}

/** Keep the invocation visible while making hidden tool output discoverable. */
function compactToolLines(lines: readonly StyledLine[], columns: number): readonly StyledLine[] {
  if (lines.length <= DEFAULT_TOOL_ROWS) return lines
  return [
    ...lines.slice(0, DEFAULT_TOOL_ROWS - 1),
    ...textLines('    … output hidden · Ctrl/Alt+R', columns, 'dim').slice(0, 1),
  ]
}

/**
 * Convert one durable transcript entry to its complete scrollable row model.
 * The source entry stays intact; only the caller's visible slice is rendered.
 * Wrapped continuations keep a hanging indent aligned under each row's
 * content (Codex history-cell alignment) instead of resetting to column 0.
 */
export function transcriptEntryLines(
  entry: TranscriptEntry,
  columns: number,
  showReasoning = true,
  reasoningToggleHint = true,
  showToolDetails = showReasoning,
): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  switch (entry.kind) {
    case 'user': {
      if (entry.notice) {
        return hangingStyledLines([lineSegment(promptDisplayText(entry), 'dim')], width, '⤷ ', 'dim', '  ', 'dim')
      }
      // A settled prompt is one full-width bar whose color says how it was
      // delivered, and a steered one switches to the ↳ prompt as well.
      const row = promptRowStyle(entry.delivery)
      const marker = deliveryMarker(entry.delivery)
      const segments = userPromptSegments(promptDisplayText(entry))
      const tagged = marker === '' ? segments : [...segments, lineSegment(`  ${marker}`, row)]
      return paintPromptRow(tagged, width, row, entry.delivery === 'steered' ? '↳ ' : '❯ ')
    }
    case 'pending': {
      // The queued/steered preview uses the same bar it will keep once the
      // durable message retires it, so nothing shifts under the reader.
      const row = promptRowStyle(entry.target === 'next-step' ? 'steered' : 'queued')
      const lines = hangingStyledLines(
        [{ ...lineSegment(promptDisplayText(entry), 'plain'), style: row }],
        width,
        entry.target === 'next-step' ? '↳ ' : '❯ ',
        row,
        '  ',
        row,
      )
      return fillRowBars(paintDiffRowBars(lines, width), width, row)
    }
    case 'assistant': {
      const reasoning = entry.reasoning === ''
        ? []
        : showReasoning
          ? reasoningLines(entry.reasoning, width)
          : textLines(`✻ Thinking (${entry.reasoning.length} chars${reasoningToggleHint ? ', Ctrl/Alt+R to expand' : ''})`, width, 'dim')
      // Every reply row carries the composer's two-column gutter, so reply
      // text aligns with the input cursor (Codex LIVE_PREFIX alignment); the
      // wrap budget shrinks by the same amount so no line double-wraps.
      const body = markdownLines(entry.text, Math.max(1, width - 2))
        .map(line => ({ segments: [{ text: '  ', style: 'plain' as const }, ...line.segments] }))
      // A cancelled stream's delivered prefix settles as this entry; one
      // bounded dim marker row distinguishes it from a completed reply.
      const interrupted = entry.interrupted === true ? textLines('  ⏹ interrupted', width, 'dim') : []
      return [...reasoning, ...body, ...interrupted]
    }
    case 'tool': {
      const mark = entry.state === 'running' ? '●' : entry.state === 'error' ? '⨯' : '⏺'
      const markStyle: LineStyle = entry.state === 'running' ? 'brand' : entry.state === 'error' ? 'error' : 'success'
      const summaryStyle: LineStyle = entry.state === 'error' ? 'error' : 'dim'
      const lines = [
        // The invocation row hangs wrapped previews under the call badge.
        ...hangingStyledLines([
          // Global call ordinal — the same number an error line references.
          lineSegment(`[${entry.ordinal}] `, 'dim'),
          lineSegment(entry.name, 'brand'),
          lineSegment(entry.preview === '' ? '' : ` ${entry.preview}`, 'dim'),
        ], width, `${mark} `, markStyle, '  ', 'plain'),
        // A delegation card carries what the child was asked (Codex's
        // SpawnAgent prompt preview) while it runs, before any result.
        ...(entry.prompt === '' ? [] : hangingTextLines(entry.prompt, width, '  └ ', 'dim', '    ')),
        // Nested PTC sub-dispatches (run_code): one bounded row per child
        // call, live while the parent card itself is still running.
        ...subDispatchLines(entry, width),
        ...(entry.summary === '' ? [] : hangingTextLines(
          entry.state === 'error' ? `call ${entry.ordinal}: ${entry.summary}` : entry.summary,
          width, '  ⎿ ', summaryStyle, '    ', summaryStyle,
        )),
        ...(entry.detail === undefined ? [] : toolDetailLines(entry.detail, width)),
      ]
      return showToolDetails ? lines : compactToolLines(lines, width)
    }
    case 'command': {
      const mark = entry.state === 'running' ? '●' : entry.state === 'error' ? '⨯' : '⏺'
      const markStyle: LineStyle = entry.state === 'running' ? 'brand' : entry.state === 'error' ? 'error' : 'success'
      const summaryStyle: LineStyle = entry.state === 'error' ? 'error' : 'dim'
      return [
        ...hangingStyledLines([
          lineSegment(`/${entry.name}`, 'brand'),
          lineSegment(entry.args === '' ? '' : ` ${entry.args}`, 'dim'),
        ], width, `${mark} `, markStyle, '  ', 'plain'),
        ...(entry.summary === '' ? [] : hangingTextLines(entry.summary, width, '  ⎿ ', summaryStyle, '    ', summaryStyle)),
      ]
    }
    case 'workflow': {
      const mark = entry.state === 'running' ? '●' : entry.state === 'error' ? '⨯' : entry.state === 'cancelled' ? '⏹' : '⏺'
      const markStyle: LineStyle = entry.state === 'running' ? 'brand' : entry.state === 'error' ? 'error' : entry.state === 'cancelled' ? 'dim' : 'success'
      const lines = [
        ...hangingStyledLines([
          lineSegment('workflow ', 'brand'),
          lineSegment(entry.name, 'dim'),
        ], width, `${mark} `, markStyle, '  ', 'plain'),
        // One bounded row per member; the child session id cross-links the
        // subagent feed's live rows for the same agent.
        ...entry.members.flatMap(member => {
          const state = member.outcome === 'running' ? '●' : member.outcome === 'failed' ? '⨯' : member.outcome === 'cancelled' ? '⏹' : '⏺'
          const style: LineStyle = member.outcome === 'running' ? 'brand' : member.outcome === 'failed' ? 'error' : 'dim'
          const phase = member.phase === '' ? '' : ` [${member.phase}]`
          return textLines(`  ┆ ${state} ${member.label}${phase}`, width, style)
        }),
        ...(entry.membersDropped === 0 ? [] : textLines(`  ┆ … ${entry.membersDropped} earlier member${entry.membersDropped === 1 ? '' : 's'}`, width, 'dim')),
      ]
      return showToolDetails ? lines : compactToolLines(lines, width)
    }
    case 'turn-marker':
      return textLines(`  ⏹ ${entry.text}`, width, 'dim')
    case 'compaction':
      return textLines(entry.ok
        ? `  ⧉ compacted ~${formatTokens(entry.tokens)} tokens`
        : `  ⧉ compaction failed: ${entry.error}`, width, 'dim')
    case 'retry':
      return textLines(
        entry.mode === 'always'
          ? `  ↻ retry ${entry.attempt} · ${entry.code} · ${Math.round(entry.delayMs / 100) / 10}s`
          : `  ↻ retry ${entry.attempt}/${entry.max} · ${entry.code} · ${Math.round(entry.delayMs / 100) / 10}s`,
        width,
        entry.state === 'running' ? 'warn' : 'dim',
      )
    case 'files':
      return entry.paths.length === 0
        ? textLines('  ⎄ no changed files', width, 'dim')
        : [
          ...textLines(`  ⎄ ${entry.paths.length} changed file${entry.paths.length === 1 ? '' : 's'}`, width, 'dim'),
          ...entry.paths.flatMap(path => hangingTextLines(path, width, '    ', 'dim', '    ')),
        ]
    case 'error':
      return textLines(entry.text, width, 'error')
    default: {
      const exhaustive: never = entry
      return exhaustive
    }
  }
}

/** Settled-history variant carrying the Ctrl+R reasoning fold. */
export function settledEntryLines(entry: TranscriptEntry, columns: number, showReasoning: boolean): readonly StyledLine[] {
  return transcriptEntryLines(entry, columns, showReasoning, false, showReasoning)
}

/** The flexible rows of the live region; chrome (composer/notice/status) is never reduced. */
export interface LiveAllocation {
  /** Settled tail rows currently rendered in the live tree. */
  readonly live: number
  /** Rows reserved for the streaming reasoning tail or its marker. */
  readonly reasoning: number
  /** Rows reserved for the streaming answer tail. */
  readonly answer: number
}

/** A clamped allocation plus the invariant-trip warning that triggered it. */
export interface LiveAllocationAudit {
  readonly allocation: LiveAllocation
  readonly warning?: string
}

/**
 * Clamp the live-region allocation so the flexible dynamic rows never exceed
 * the post-chrome budget. By construction the caller derives these rows from
 * the same budget; this is the runtime tripwire for a future edit that breaks
 * that derivation. Reduction order: answer first (the freshest content is the
 * live tail), then reasoning, then settled live rows; nothing goes negative.
 * @param allocation - the intended row allocation.
 * @param dynamicRows - the post-chrome row budget.
 * @returns the clamped allocation and a warning string when clamping fired.
 */
export function clampLiveAllocation(allocation: LiveAllocation, dynamicRows: number): LiveAllocationAudit {
  const live = Math.max(0, Math.floor(allocation.live))
  const reasoning = Math.max(0, Math.floor(allocation.reasoning))
  const answer = Math.max(0, Math.floor(allocation.answer))
  const budget = Math.max(0, Math.floor(dynamicRows))
  let excess = live + reasoning + answer - budget
  if (excess <= 0) return { allocation: { live, reasoning, answer } }
  const take = (from: number): number => {
    const cut = Math.min(from, excess)
    excess -= cut
    return from - cut
  }
  const clampedAnswer = take(answer)
  const clampedReasoning = excess > 0 ? take(reasoning) : reasoning
  const clampedLive = excess > 0 ? take(live) : live
  return {
    allocation: { live: clampedLive, reasoning: clampedReasoning, answer: clampedAnswer },
    warning: `live rows ${live} + ${reasoning} + ${answer} exceed the dynamic budget ${budget}; clamped to ${clampedLive}/${clampedReasoning}/${clampedAnswer}`,
  }
}
