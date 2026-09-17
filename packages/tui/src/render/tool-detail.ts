/**
 * Expansion payloads for tool cards (the Ctrl+O verbose transcript): the
 * TUI-side consumption of the harness presentation contract. Mutation and
 * read tools persist a structured `tool/result.meta` (`diffs`, read
 * windows, web sources) exactly so a capable UI can replay richer cards than
 * the model-facing text; this module narrows that opaque JSON defensively —
 * mirroring the upstream validators — and pre-formats bounded, render-ready
 * rows. Malformed or absent metadata always degrades to the bounded raw
 * result text, never throws during replay.
 *
 * @module @deepseek-ai/dsh-code/render/tool-detail
 */

import { displayText, truncateColumns } from './text.ts'

/** Budgets keeping one expanded card bounded on a terminal. */
const MAX_DIFF_LINES = 200
const MAX_READ_LINES = 120
const MAX_SOURCES = 10
const MAX_RAW_CHARS = 6000
const MAX_LINE_COLUMNS = 240
/** Hard caps on adversarial `tool/result.meta` before any row is built. */
const MAX_DIFFS = 8
const MAX_DIFF_TEXT_CHARS = 24_000

/** One rendered diff row: removed, added, or shared context. */
export interface DiffLine {
  /** '-' removed, '+' added, ' ' context. */
  mark: '-' | '+' | ' '
  /** The line text, truncated to the column budget. */
  text: string
}

/** One file's bounded inline diff. */
export interface ToolDiff {
  /** File path the change belongs to. */
  path: string
  /** Rendered rows in order; '-' block before the '+' block. */
  lines: readonly DiffLine[]
  /** True when the line budget cut the hunk. */
  truncated: boolean
}

/** One numbered line of a read window. */
export interface ToolReadLine {
  /** 1-based file line number. */
  number: number
  /** The line text, truncated to the column budget. */
  text: string
}

/** One web-search source row. */
export interface ToolWebSource {
  /** Source URL. */
  url: string
  /** Source title, when the provider returned one. */
  title: string | undefined
  /** Short excerpt, truncated to the column budget. */
  snippet: string
}

/** The expansion payload a verbose tool card renders; a discriminated union. */
export type ToolDetail =
  | { kind: 'diff'; diffs: readonly ToolDiff[] }
  | { kind: 'read'; path: string; offset: number; lines: readonly ToolReadLine[]; totalLines: number; truncated: boolean }
  | { kind: 'web-search'; sources: readonly ToolWebSource[]; truncated: boolean }
  | { kind: 'web-fetch'; url: string; statusCode: number }
  | { kind: 'raw'; text: string; truncated: boolean }

/** Truncate one line to the visible-column budget with an ellipsis marker. */
function clipLine(text: string): string {
  return truncateColumns(displayText(text), MAX_LINE_COLUMNS)
}

/** Split text into lines, dropping the trailing empty element of a final newline. */
function toLines(text: string): string[] {
  const split = text.split('\n')
  return split.length > 0 && split[split.length - 1] === '' ? split.slice(0, -1) : split
}

/**
 * Render one change as removed-then-added rows, hunked by common prefix and
 * suffix. A null before-image (file create) renders as pure additions. The
 * budget caps emitted rows and reports the cut, so a whole-file overwrite
 * never floods the transcript. Inputs are hard-capped before line splitting
 * and the row list is built incrementally up to the budget — a crafted or
 * replayed giant diff cannot force a full intermediate rows array.
 * @param oldText - prior content, or null for a create.
 * @param newText - content after the change.
 * @param budget - maximum rows to emit.
 * @returns the bounded rows and whether they were cut.
 */
export function diffRows(oldText: string | null, newText: string, budget: number): { lines: readonly DiffLine[]; truncated: boolean } {
  const oldRaw = oldText ?? ''
  const newRaw = newText
  let inputTruncated = false
  let oldSource = oldRaw
  let newSource = newRaw
  // Bound the working arrays before `toLines` allocates them: keep a
  // combined-characters share of each side proportional to its input size.
  const combined = oldRaw.length + newRaw.length
  if (combined > MAX_DIFF_TEXT_CHARS) {
    inputTruncated = true
    const oldShare = Math.min(oldRaw.length, Math.floor(MAX_DIFF_TEXT_CHARS * oldRaw.length / combined))
    const newShare = Math.min(newRaw.length, MAX_DIFF_TEXT_CHARS - oldShare)
    oldSource = oldRaw.slice(0, oldShare)
    newSource = newRaw.slice(0, newShare)
  }
  const oldLines = oldText === null ? [] : toLines(oldSource)
  const newLines = toLines(newSource)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1
  const removedCount = oldLines.length - prefix - suffix
  const addedCount = newLines.length - prefix - suffix
  const truncated = inputTruncated || removedCount + addedCount > budget
  // Build at most `budget` rows directly; never materialize the full hunk.
  const rows: DiffLine[] = []
  const removedLimit = Math.min(removedCount, Math.max(0, budget))
  for (let index = 0; index < removedLimit; index += 1) {
    rows.push({ mark: '-', text: clipLine(oldLines[prefix + index] ?? '') })
  }
  const addedLimit = Math.min(addedCount, Math.max(0, budget - removedLimit))
  for (let index = 0; index < addedLimit; index += 1) {
    rows.push({ mark: '+', text: clipLine(newLines[prefix + index] ?? '') })
  }
  return { lines: rows, truncated }
}

/** Whether `value` is a valid upstream FileDiff (defensive narrowing). */
function isFileDiff(value: unknown): value is { path: string; oldText: string | null; newText: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string' && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
}

/** Whether `value` is a valid read-window line (defensive narrowing). */
function isReadLine(value: unknown): value is { number: number; text: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { number, text } = value as Record<string, unknown>
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string'
}

/** Whether `value` is a valid web source (defensive narrowing). */
function isWebSource(value: unknown): value is { url: string; title?: unknown; snippet?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { url, title, snippet } = value as Record<string, unknown>
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
}

/**
 * Narrow the opaque `tool/result.meta` into one bounded expansion payload,
 * mirroring the upstream presenters' degradation ladder: diffs (write/edit),
 * read windows (read), sources (web_search), fetch summaries (web_fetch), and
 * the bounded raw result text as the universal fallback.
 * @param meta - the persisted presentation metadata, when the tool attached one.
 * @param rawText - the joined text blocks of the result message.
 * @returns the expansion payload, or undefined when nothing renderable exists.
 */
export function toolResultDetail(meta: unknown, rawText: string): ToolDetail | undefined {
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
    const record = meta as Record<string, unknown>

    const diffs = record['diffs']
    // Validate and process only the capped prefix: an adversarial meta with
    // thousands of diffs never runs `.every` over the full array.
    if (Array.isArray(diffs) && diffs.length > 0) {
      const capped = diffs.slice(0, MAX_DIFFS)
      if (capped.every(isFileDiff)) {
        const budget = Math.max(8, Math.floor(MAX_DIFF_LINES / capped.length))
        // Diffs dropped beyond the cap must not vanish silently: the last
        // kept diff reports the cut exactly like a hunk cut does.
        const dropped = diffs.length > capped.length
        const rendered = capped.map((diff, index) => {
          const rows = diffRows(diff.oldText, diff.newText, budget)
          return dropped && index === capped.length - 1
            ? { path: diff.path, ...rows, truncated: true }
            : { path: diff.path, ...rows }
        })
        return { kind: 'diff', diffs: rendered }
      }
    }

    const { path, offset, lines, totalLines } = record
    if (typeof path === 'string' && Number.isInteger(offset) && (offset as number) >= 1
      && Number.isInteger(totalLines) && (totalLines as number) >= 0
      && Array.isArray(lines)) {
      // Validate the bounded window only: lines beyond the display cap are
      // dropped anyway, so a giant persisted window cannot force a full-array
      // validation pass before the slice.
      const window = lines.slice(0, MAX_READ_LINES)
      if (window.every(isReadLine)) {
        const truncated = lines.length > MAX_READ_LINES
        return {
          kind: 'read',
          path,
          offset: offset as number,
          lines: window.map(line => ({ number: line.number, text: clipLine(line.text) })),
          totalLines: totalLines as number,
          truncated,
        }
      }
    }

    const sources = record['sources']
    if (Array.isArray(sources)) {
      const capped = sources.slice(0, MAX_SOURCES)
      if (capped.every(isWebSource)) {
        const truncated = sources.length > MAX_SOURCES
        return {
          kind: 'web-search',
          sources: capped.map(source => ({
            url: source.url,
            title: typeof source.title === 'string' ? source.title : undefined,
            snippet: typeof source.snippet === 'string' ? clipLine(source.snippet) : '',
          })),
          truncated,
        }
      }
    }

    const { url, statusCode } = record
    if (typeof url === 'string' && typeof statusCode === 'number') {
      return { kind: 'web-fetch', url, statusCode: Math.trunc(statusCode) }
    }
  }
  if (rawText === '') return undefined
  const truncated = rawText.length > MAX_RAW_CHARS
  return {
    kind: 'raw',
    text: truncated ? rawText.slice(0, MAX_RAW_CHARS) : rawText,
    truncated,
  }
}