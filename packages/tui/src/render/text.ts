/**
 * Display-boundary sanitization for externally sourced text (model output,
 * tool payloads, skill descriptions). Control characters — including ANSI
 * CSI/OSC escape sequences — would otherwise pass through Ink into the
 * terminal, letting output rewrite the screen or inject prompts. Newlines
 * survive; everything else in C0/C1 plus DEL becomes a visible `\xNN`
 * escape, and bidi overrides / invisible format controls / Unicode line and
 * paragraph separators become a visible `\uXXXX` escape (terminal emulators
 * that render bidirectional text would otherwise reorder the displayed
 * glyphs and let a command read as something it is not).
 *
 * @module @deepseek-ai/dsh-code/render/text
 */

import { graphemeWidth, splitGraphemes, stringWidth } from './width.ts'

/**
 * Compact token count: exact below 1K, then one-decimal-ish K/M.
 * @param n - token count.
 * @returns display string.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return scaled(n / 1_000) + 'K'
  return scaled(n / 1_000_000) + 'M'
}


/** C0 controls except tab (0x09) and newline (0x0a), plus DEL and C1. */
const CONTROL_ESCAPE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu

/**
 * Bidi overrides and isolates (U+202A-202E, U+2066-2069), the Arabic Letter
 * Mark (U+061C), directional and zero-width format characters (U+200B,
 * U+200E/200F, U+2060-2064, U+FEFF), and Unicode line/paragraph separators
 * (U+2028/2029). Terminal emulators with bidi support (Windows Terminal,
 * iTerm2, kitty, WezTerm) reorder or hide these, so they must never reach
 * the terminal raw.
 */
const INVISIBLE_ESCAPE = /[\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu

/**
 * Escape control and deceptive characters so externally sourced text cannot
 * drive the terminal. C0/C1/DEL render as a literal `\xNN` escape; bidi,
 * invisible-format, and separator controls render as a literal `\uXXXX`
 * escape. Newlines and tabs survive (budgeted callers normalize tabs).
 * @param text - raw text from a session event, tool payload, or catalog.
 * @returns display-safe text with every injectable character made visible.
 */
export function displayText(text: string): string {
  return text
    .replace(CONTROL_ESCAPE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
    .replace(INVISIBLE_ESCAPE, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Collapse external text to one terminal-safe logical row. */
export function singleLineText(text: string): string {
  return displayText(text).replace(/\r?\n/gu, ' ↵ ').replace(/\t/gu, '  ')
}

/**
 * Truncate one display-safe row without ever exceeding its physical-column
 * budget. The ellipsis is included inside the budget, matching Codex's popup
 * truncation contract; the cut walks grapheme clusters so emoji and
 * combining sequences never split mid-cluster.
 */
export function truncateColumns(text: string, columns: number): string {
  const limit = Math.max(0, Math.floor(columns))
  if (limit === 0) return ''
  if (stringWidth(text) <= limit) return text

  const contentLimit = limit - 1
  let used = 0
  let result = ''
  for (const cluster of splitGraphemes(text)) {
    const width = graphemeWidth(cluster)
    if (used + width > contentLimit) break
    result += cluster
    used += width
  }
  return `${result}…`
}

/** A display-safe suffix bounded by terminal rows and columns. */
export interface DisplayTail {
  /** Sanitized suffix suitable for direct terminal rendering. */
  text: string
  /** Whether content before the returned suffix was omitted. */
  truncated: boolean
}

/** Punctuation that must never START a physical row (CJK kinsoku tail set). */
const ROW_START_FORBIDDEN = '，。、；：！？）】」』〉》…‥'

/** Punctuation that must never END a physical row (CJK kinsoku head set). */
const ROW_END_FORBIDDEN = '（【「『〈《'

/**
 * Keep the newest display-safe text that fits a terminal rectangle, wrapping
 * FORWARD from the start of the text and slicing the tail rows.
 *
 * Forward wrapping is what keeps a streaming tail calm: rows already produced
 * never re-wrap as tokens append (a backward scan recomputes every wrap point
 * per chunk and the whole visible block jumps), and the wrap rules match the
 * settled text's renderer so the flush at turn end does not reflow the block
 * a second time. CJK kinsoku applies at both edges: closing punctuation
 * overhangs up to two cells onto the filled row instead of starting the next
 * one (within the caret column the caller reserves), and opening punctuation
 * moves down instead of dangling at a row end. Tabs expand to two spaces so
 * terminal tab stops cannot inflate the physical row count; clusters carry
 * emoji presentation and combining marks whole.
 * @param text - raw externally sourced text.
 * @param columns - available terminal columns.
 * @param rows - available terminal rows.
 * @returns a sanitized bounded suffix and whether an earlier prefix was cut.
 */
export function displayTail(text: string, columns: number, rows: number): DisplayTail {
  const columnLimit = Math.max(1, Math.floor(columns))
  const rowLimit = Math.max(1, Math.floor(rows))
  const wrapped: string[] = []
  let current = ''
  let used = 0
  let lastCluster = ''
  const flush = (): void => {
    wrapped.push(current)
    current = ''
    used = 0
    lastCluster = ''
  }

  for (const cluster of splitGraphemes(text)) {
    if (cluster === '\n') {
      flush()
      continue
    }
    const safe = cluster === '\t' ? '  ' : displayText(cluster)
    // safe can be a multi-character escape literal (\xNN / \uXXXX); only
    // stringWidth budgets the whole visible escape, never its first byte.
    const width = stringWidth(safe)
    if (used > 0 && used + width > columnLimit) {
      const overhang = width <= 2 && ROW_START_FORBIDDEN.includes(cluster)
      if (!overhang) {
        // Kinsoku head: an opening mark at the row edge moves down with the
        // incoming cluster instead of dangling at the end of the filled row.
        if (lastCluster !== '' && ROW_END_FORBIDDEN.includes(lastCluster)) {
          const carried = lastCluster
          current = current.slice(0, current.length - carried.length)
          flush()
          current = carried
          used = stringWidth(carried)
        } else {
          flush()
        }
      }
    }
    current += safe
    used += width
    lastCluster = cluster
  }
  // A trailing newline means one deliberate empty caret row, but that row
  // must never evict real content or fake a truncation marker: flush the
  // content first, decide truncation on content alone, then append the blank
  // row only when the whole tail still fits the budget.
  const trailingBlank = current === '' && wrapped.length > 0 && text.endsWith('\n')
  if (current !== '') flush()
  const truncated = wrapped.length > rowLimit
  const kept = truncated ? wrapped.slice(-rowLimit) : wrapped
  const keptRows = trailingBlank && kept.length < rowLimit ? [...kept, ''] : kept
  return { text: keptRows.join('\n'), truncated }
}
