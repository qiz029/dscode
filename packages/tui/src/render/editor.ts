/**
 * Pure composer editor model with Codex textarea semantics: a grapheme
 * cursor over a column-safe multiline layout, word/piece motion, single-entry
 * kill + yank, and the shell-recall boundary gate that keeps Up/Down usable
 * inside a multiline draft.
 *
 * The model is intentionally string-offset based (UTF-16 indices clamped to
 * grapheme boundaries) so the React state stays two primitives
 * (value, cursor) and every operation here stays pure and testable.
 *
 * Word motion follows Codex's piece semantics: whitespace separates runs,
 * punctuation runs stay atomic, and each Han grapheme is its own boundary.
 *
 * @module @deepseek-ai/dsh-code/render/editor
 */

import { visibleColumns } from './markdown.ts'

/** One grapheme cluster with its source span and display width in cells. */
export interface GraphemeSpan {
  text: string
  start: number
  end: number
  width: number
}

const segmenter: Intl.Segmenter | undefined = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter('en', { granularity: 'grapheme' })
  : undefined

/**
 * Split text into grapheme clusters. Falls back to code points when
 * Intl.Segmenter is unavailable; the fallback still keeps surrogate pairs
 * (emoji) atomic so the cursor can never split one.
 */
export function splitGraphemes(text: string): readonly GraphemeSpan[] {
  if (text === '') return []
  const spans: GraphemeSpan[] = []
  if (segmenter !== undefined) {
    for (const piece of segmenter.segment(text)) {
      spans.push({
        text: piece.segment,
        start: piece.index,
        end: piece.index + piece.segment.length,
        width: visibleColumns(piece.segment),
      })
    }
    return spans
  }
  let start = 0
  for (const char of text) {
    spans.push({ text: char, start, end: start + char.length, width: visibleColumns(char) })
    start += char.length
  }
  return spans
}

/** Round one UTF-16 offset down to the grapheme boundary at or before it. */
function floorBoundary(spans: readonly GraphemeSpan[], offset: number): number {
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]
    if (span.end <= offset) return span.end
    if (span.start < offset) return span.start
  }
  return 0
}

/** Clamp a cursor offset to the nearest grapheme boundary (surrogates, ZWJ, marks stay whole). */
export function clampCursor(value: string, offset: number): number {
  if (value === '') return 0
  const target = Math.max(0, Math.min(value.length, Math.floor(offset)))
  if (target === 0 || target === value.length) return target
  const spans = splitGraphemes(value)
  const down = floorBoundary(spans, target)
  if (down === target) return target
  const up = spans.find(span => span.start >= target)?.start ?? value.length
  return up - target < target - down ? up : down
}

/**
 * Delete the final grapheme cluster (append-only drafts without a cursor).
 * Surrogate pairs and multi-codepoint emoji stay whole instead of leaving a
 * lone trailing code unit behind.
 */
export function deleteLastGrapheme(text: string): string {
  if (text === '') return ''
  const spans = splitGraphemes(text)
  return text.slice(0, spans[spans.length - 1].start)
}

/**
 * Step the cursor by whole graphemes (negative steps left). The cursor is
 * assumed to sit on a boundary; any drift is clamped first.
 */
export function moveCursorBy(value: string, offset: number, delta: number): number {
  if (delta === 0 || value === '') return clampCursor(value, offset)
  const spans = splitGraphemes(value)
  const boundaries: number[] = [0]
  for (const span of spans) boundaries.push(span.end)
  const current = boundaries.indexOf(clampCursor(value, offset))
  if (current === -1) return clampCursor(value, offset)
  const next = Math.max(0, Math.min(boundaries.length - 1, current + delta))
  return boundaries[next]
}

/**
 * Normalize text entering the draft: CRLF/CR become LF, tabs become two
 * spaces (terminal tab stops are contextual and cannot join a deterministic
 * row budget), and every other C0 control byte plus DEL is REMOVED — the
 * draft is data, so a stray ESC (Windows Terminal file drops) disappears
 * instead of rendering as literal backslash-x-1-b text. Newlines survive.
 */
export function sanitizeDraftText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    // The draft is DATA, not display: strip C0 control bytes (the stray ESC
    // that rides Windows Terminal file drops) and DEL instead of escaping
    // them into visible "\x1b" text. Newlines survive; tabs widen.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replaceAll('\t', '  ')
}

/** One physical editor row: wrapped text plus its boundary map. */
export interface EditorRowModel {
  /** Display text of the row (never contains `\n`; sanitized upstream). */
  readonly text: string
  /** Source offset of the first grapheme on the row. */
  readonly start: number
  /** Source offset just past the last grapheme on the row (before its newline). */
  readonly end: number
  /** Boundary offsets on the row, start to end inclusive. */
  readonly offsets: readonly number[]
  /** Display column of each boundary; `columns[i]` pairs with `offsets[i]`. */
  readonly columns: readonly number[]
  /** Code-unit cut in `text` at each boundary; `cuts[i]` pairs with `offsets[i]`. */
  readonly cuts: readonly number[]
}

/** The wrapped physical-row model of one draft. */
export interface EditorModel {
  readonly rows: readonly EditorRowModel[]
  readonly length: number
}

/**
 * Hard-wrap the draft into column-safe physical rows. Wide graphemes never
 * split across rows (a grapheme that does not fit flushes the row first) and
 * explicit newlines end their row without occupying a cell.
 */
export function editorModel(value: string, columns: number): EditorModel {
  const width = Math.max(1, Math.floor(columns))
  const spans = splitGraphemes(value)
  const rows: EditorRowModel[] = []
  let text = ''
  let start = 0
  let used = 0
  const offsets: number[] = [0]
  const rowColumns: number[] = [0]
  const rowCuts: number[] = [0]
  const flush = (end: number): void => {
    rows.push({ text, start, end, offsets: [...offsets], columns: [...rowColumns], cuts: [...rowCuts] })
    text = ''
    used = 0
    offsets.length = 0
    rowColumns.length = 0
    rowCuts.length = 0
  }
  for (const span of spans) {
    if (span.text === '\n') {
      flush(span.start)
      start = span.end
      offsets.push(span.end)
      rowColumns.push(0)
      rowCuts.push(0)
      continue
    }
    if (used > 0 && used + span.width > width) {
      flush(span.start)
      start = span.start
      offsets.push(span.start)
      rowColumns.push(0)
      rowCuts.push(0)
    }
    text += span.text
    used += span.width
    offsets.push(span.end)
    rowColumns.push(used)
    rowCuts.push(text.length)
  }
  if (text !== '' || rows.length === 0) flush(value.length)
  else if (offsets.length > 0) {
    // Trailing newline leaves one pending empty boundary row.
    rows.push({ text: '', start, end: value.length, offsets: [...offsets], columns: [...rowColumns], cuts: [...rowCuts] })
  }
  return { rows, length: value.length }
}

/** Where a cursor offset renders: the physical row and its display column. */
export interface CaretSite {
  row: number
  column: number
}

/** Text slices for rendering one physical row with at most one caret. */
export interface EditorRowParts {
  readonly before: string
  readonly caret: string
  readonly after: string
  readonly hasCaret: boolean
}

/** Split one row around the authoritative caret; every other row stays whole. */
export function editorRowParts(
  row: EditorRowModel,
  rowIndex: number,
  caretRow: number,
  cursor: number,
  caretEnabled = true,
): EditorRowParts {
  if (!caretEnabled || rowIndex !== caretRow) return { before: '', caret: '', after: row.text, hasCaret: false }
  const at = row.offsets.indexOf(cursor)
  if (at < 0) return { before: '', caret: '', after: row.text, hasCaret: false }
  const before = at > 0 ? row.text.slice(0, row.cuts[at]) : ''
  const caret = at < row.cuts.length - 1 ? row.text.slice(row.cuts[at], row.cuts[at + 1]) : ' '
  const after = at < row.cuts.length - 1 ? row.text.slice(row.cuts[at + 1]) : ''
  return { before, caret, after, hasCaret: true }
}

/** Map a cursor offset to its caret site on the wrapped rows. */
export function caretSite(model: EditorModel, offset: number): CaretSite {
  const target = Math.max(0, Math.min(model.length, offset))
  for (let index = model.rows.length - 1; index >= 0; index -= 1) {
    const row = model.rows[index]
    const at = row.offsets.indexOf(target)
    if (at >= 0) return { row: index, column: row.columns[at] }
  }
  const last = model.rows[model.rows.length - 1]
  return { row: model.rows.length - 1, column: last === undefined ? 0 : last.columns[last.columns.length - 1] }
}

/**
 * Move the caret across physical rows keeping a preferred display column
 * (Codex `preferred_col`): horizontal moves reset the preference, vertical
 * moves reuse it, clamped to each row's width.
 */
export function moveCursorVertically(model: EditorModel, offset: number, preferredColumn: number, delta: number): number {
  const site = caretSite(model, offset)
  const target = site.row + delta
  if (delta === 0) return offset
  if (target < 0) return 0
  if (target >= model.rows.length) return model.length
  const row = model.rows[target]
  const wanted = Math.max(0, Math.min(preferredColumn, row.columns[row.columns.length - 1]))
  let best = 0
  for (let index = 1; index < row.columns.length; index += 1) {
    if (row.columns[index] <= wanted) best = index
    else break
  }
  return row.offsets[best]
}

/** The start/end offsets of the logical line containing the cursor. */
export function lineBounds(value: string, offset: number): { start: number; end: number } {
  const target = Math.max(0, Math.min(value.length, offset))
  const start = value.lastIndexOf('\n', Math.max(0, target - 1)) + 1
  const end = value.indexOf('\n', target)
  return { start, end: end === -1 ? value.length : end }
}

/** Codex WORD_SEPARATORS: punctuation runs are their own word pieces. */
const WORD_SEPARATORS = new Set('`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?')

type PieceClass = 'space' | 'punct' | 'word'

const HAN_GRAPHEME = /^\p{Script=Han}(?:\p{Mark}|\uFE0F)*$/u
const UNICODE_PUNCTUATION = /^\p{P}+$/u

function classifyGrapheme(text: string): PieceClass {
  if (/^\s$/u.test(text)) return 'space'
  return WORD_SEPARATORS.has(text) || UNICODE_PUNCTUATION.test(text) ? 'punct' : 'word'
}

/** Maximal same-class runs; Han graphemes deliberately stay one run each. */
function pieceRuns(value: string): readonly { start: number; end: number; class: PieceClass; atomic: boolean }[] {
  const runs: { start: number; end: number; class: PieceClass; atomic: boolean }[] = []
  let current: { start: number; end: number; class: PieceClass; atomic: boolean } | undefined
  for (const span of splitGraphemes(value)) {
    const klass = span.text === '\n' ? 'space' : classifyGrapheme(span.text)
    const atomic = klass === 'word' && HAN_GRAPHEME.test(span.text)
    if (current !== undefined && current.class === klass && !current.atomic && !atomic) {
      current.end = span.end
      continue
    }
    current = { start: span.start, end: span.end, class: klass, atomic }
    runs.push(current)
  }
  return runs
}

/**
 * Codex `beginning_of_previous_word`: skip whitespace left, then land on the
 * START of the trailing non-space piece (extending over separator pieces).
 */
export function moveWordLeft(value: string, offset: number): number {
  const cursor = clampCursor(value, offset)
  const runs = pieceRuns(value)
  // The last run with content before the cursor includes the current word's
  // left-hand fragment, instead of skipping the whole containing run.
  let index = runs.findLastIndex(run => run.start < cursor)
  if (index < 0) return 0
  if (runs[index].class === 'space') {
    index -= 1
    if (index < 0) return 0
  }
  let target = index
  while (target > 0 && runs[target].class === 'punct' && runs[target - 1].class === 'punct') target -= 1
  return runs[target].start
}

/**
 * Codex `end_of_next_word`: skip whitespace right, then land on the END of
 * the leading non-space piece (extending over separator pieces).
 */
export function moveWordRight(value: string, offset: number): number {
  const cursor = clampCursor(value, offset)
  const runs = pieceRuns(value)
  // The first run with content after the cursor includes the current word's
  // right-hand fragment, instead of jumping straight to the following word.
  let index = runs.findIndex(run => run.end > cursor)
  if (index >= runs.length) return value.length
  if (runs[index].class === 'space') {
    index += 1
    if (index >= runs.length) return value.length
  }
  let target = index
  while (target < runs.length - 1 && runs[target].class === 'punct' && runs[target + 1].class === 'punct') target += 1
  return runs[target].end
}

/** One edit outcome: the next draft value, cursor, and killed span (if any). */
export interface EditResult {
  value: string
  cursor: number
  /** Text removed into the kill buffer; undefined when nothing was killed. */
  killed: string | undefined
}

function replaceRange(value: string, cursor: number, start: number, end: number, killed: boolean): EditResult {
  const from = Math.min(start, end)
  const to = Math.max(start, end)
  if (from >= to) return { value, cursor, killed: undefined }
  const text = value.slice(from, to)
  return {
    value: value.slice(0, from) + value.slice(to),
    cursor: Math.max(0, cursor - Math.max(0, Math.min(cursor, to) - from)),
    killed: killed ? text : undefined,
  }
}

/** Delete the grapheme cluster before the cursor. */
export function deleteBackward(value: string, cursor: number): EditResult {
  if (cursor === 0) return { value, cursor, killed: undefined }
  const spans = splitGraphemes(value.slice(0, cursor))
  const start = spans.length === 0 ? 0 : spans[spans.length - 1].start
  return replaceRange(value, cursor, start, cursor, false)
}

/** Delete the grapheme cluster at the cursor. */
export function deleteForward(value: string, cursor: number): EditResult {
  if (cursor >= value.length) return { value, cursor, killed: undefined }
  const span = splitGraphemes(value).find(candidate => candidate.start >= cursor)
  return replaceRange(value, cursor, cursor, span === undefined ? value.length : span.end, false)
}

/** Delete back to the start of the previous word (fills the kill buffer). */
export function deleteWordBackward(value: string, cursor: number): EditResult {
  const start = moveWordLeft(value, cursor)
  return replaceRange(value, cursor, start, cursor, true)
}

/** Delete forward to the end of the next word (fills the kill buffer). */
export function deleteWordForward(value: string, cursor: number): EditResult {
  const end = moveWordRight(value, cursor)
  return replaceRange(value, cursor, cursor, end, true)
}

/** Ctrl+U: kill from the line start to the cursor; at BOL, kill the newline. */
export function killToLineStart(value: string, cursor: number): EditResult {
  const bounds = lineBounds(value, cursor)
  if (cursor > bounds.start) return replaceRange(value, cursor, bounds.start, cursor, true)
  if (bounds.start > 0) return replaceRange(value, cursor, bounds.start - 1, bounds.start, true)
  return { value, cursor, killed: undefined }
}

/** Ctrl+K: kill from the cursor to the line end; at EOL, kill the newline. */
export function killToLineEnd(value: string, cursor: number): EditResult {
  const bounds = lineBounds(value, cursor)
  if (cursor < bounds.end) return replaceRange(value, cursor, cursor, bounds.end, true)
  if (bounds.end < value.length) return replaceRange(value, cursor, bounds.end, bounds.end + 1, true)
  return { value, cursor, killed: undefined }
}

/** Insert sanitized text at the cursor. */
export function insertText(value: string, cursor: number, text: string): EditResult {
  const safe = sanitizeDraftText(text)
  if (safe === '') return { value, cursor, killed: undefined }
  return { value: value.slice(0, cursor) + safe + value.slice(cursor), cursor: cursor + safe.length, killed: undefined }
}

/** Ctrl+A: current logical line start, then the previous line start on repeat. */
export function moveToLineStart(value: string, cursor: number, crossOnRepeat: boolean): number {
  const site = clampCursor(value, cursor)
  const bounds = lineBounds(value, site)
  if (!crossOnRepeat || site !== bounds.start || bounds.start === 0) return bounds.start
  return lineBounds(value, bounds.start - 1).start
}

/** Ctrl+E: current logical line end, then the next line end on repeat. */
export function moveToLineEnd(value: string, cursor: number, crossOnRepeat: boolean): number {
  const site = clampCursor(value, cursor)
  const bounds = lineBounds(value, site)
  if (!crossOnRepeat || site !== bounds.end || bounds.end >= value.length) return bounds.end
  return lineBounds(value, bounds.end + 1).end
}

/** One stable text range captured before an asynchronous draft operation. */
export interface DraftRange {
  readonly start: number
  readonly end: number
}

/**
 * Remap a captured range when all intervening edits are wholly before or
 * wholly after it. An edit overlapping either boundary invalidates the
 * anchor instead of guessing and inserting content at a surprising place.
 */
export function remapStableRange(original: string, current: string, range: DraftRange): DraftRange | undefined {
  const start = Math.max(0, Math.min(original.length, range.start))
  const end = Math.max(start, Math.min(original.length, range.end))
  if (original === current) return { start, end }
  let prefix = 0
  const shared = Math.min(original.length, current.length)
  while (prefix < shared && original[prefix] === current[prefix]) prefix += 1
  let suffix = 0
  while (suffix < original.length - prefix
    && suffix < current.length - prefix
    && original[original.length - 1 - suffix] === current[current.length - 1 - suffix]) suffix += 1
  const oldChangedEnd = original.length - suffix
  if (prefix >= end) return { start, end }
  if (oldChangedEnd <= start) {
    const delta = current.length - original.length
    return { start: start + delta, end: end + delta }
  }
  return undefined
}

/** Replace a current range while preserving a cursor moved after capture. */
export function replaceRangePreservingCursor(
  value: string,
  cursor: number,
  range: DraftRange,
  replacement: string,
): EditResult {
  const start = Math.max(0, Math.min(value.length, range.start))
  const end = Math.max(start, Math.min(value.length, range.end))
  const site = clampCursor(value, cursor)
  const nextCursor = site <= start
    ? site
    : site >= end
      ? site + replacement.length - (end - start)
      : start + replacement.length
  return {
    value: value.slice(0, start) + replacement + value.slice(end),
    cursor: nextCursor,
    killed: undefined,
  }
}

/**
 * Composer editor row budget: the editor itself never grows past this many
 * physical rows; deeper drafts scroll internally to keep the caret visible.
 * Short terminals collapse toward one row so the live transcript keeps room.
 */
export function composerMaxRows(terminalRows: number): number {
  return Math.max(1, Math.min(6, Math.floor((Math.max(1, terminalRows) - 10) / 3)))
}

/**
 * History navigation starts with Up on an empty draft, or continues from an
 * unchanged recalled entry whenever the caret sits on either text edge
 * (start or end) - moving the caret into the interior returns the keys to
 * ordinary editing until an edge is reached again.
 */
export function shouldRecallNavigate(value: string, cursor: number, lastRecalled: string | null, direction: -1 | 1): boolean {
  if (value === '') return direction < 0
  if (lastRecalled !== value) return false
  return cursor === 0 || cursor === value.length
}
