/**
 * Terminal markdown renderer for assistant replies: a pure GFM-subset
 * block/inline parser producing styled line segments the Ink renderer maps
 * to colored text. No ANSI here — the app owns color mapping, tests own the
 * structure. The subset mirrors what agent replies actually emit: headings,
 * emphasis, inline/fenced code, flat lists, blockquotes, links, rules, GFM
 * tables, and wrapped paragraphs. Unknown syntax degrades to plain text.
 *
 * @module @deepseek-ai/dsh-code/render/markdown
 */

import { graphemeWidth, splitGraphemes, stringWidth } from './width.ts'

/** Style classes the renderer emits; the app maps them to colors/props. */
export type MdStyle = 'plain' | 'bold' | 'italic' | 'boldItalic' | 'code' | 'accent' | 'accentBold' | 'dim' | 'strike' | 'diffAdd' | 'diffDel'

/** One styled run of text. */
export interface MdSegment {
  /** Visible text (no ANSI). */
  text: string
  /** Presentation class for the app's color map. */
  style: MdStyle
}

/** One rendered line: a sequence of styled runs. */
export interface MdLine {
  segments: readonly MdSegment[]
}

/** Plain segment helper. */
function seg(text: string, style: MdStyle = 'plain'): MdSegment {
  return { text, style }
}

/** Visible width of a run in columns (grapheme-cluster and emoji aware). */
export function visibleColumns(text: string): number {
  return stringWidth(text)
}

interface WrapUnit {
  text: string
  style: MdStyle
}

/** Punctuation that should not become the first visible glyph of a row. */
function isClosingPunctuation(text: string): boolean {
  return /^[,.;:!?%、。，．！？：；％）》」』】〕〉》”’]/u.test(text)
}

/**
 * Split prose into soft-wrap units: ASCII words stay intact, while wide CJK
 * glyphs become individual break opportunities. This keeps ordinary prose
 * readable without allowing a Chinese paragraph to become one overlong word.
 */
function wrapUnits(segments: readonly MdSegment[]): readonly WrapUnit[] {
  const units: WrapUnit[] = []
  for (const segment of segments) {
    let word = ''
    const flushWord = (): void => {
      if (word !== '') units.push({ text: word, style: segment.style })
      word = ''
    }
    // Grapheme clusters keep ZWJ families, flags, and combining sequences
    // whole; a cluster wider than one cell is its own break opportunity.
    for (const cluster of splitGraphemes(segment.text)) {
      if (cluster === ' ') {
        flushWord()
        units.push({ text: cluster, style: segment.style })
      } else if (graphemeWidth(cluster) > 1) {
        flushWord()
        units.push({ text: cluster, style: segment.style })
      } else {
        word += cluster
      }
    }
    flushWord()
  }
  return units
}

/** Walk styled units, keeping logical rows within the physical column budget. */
function wrapSegments(segments: readonly MdSegment[], width: number): readonly (readonly MdSegment[])[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: (readonly MdSegment[])[] = []
  let current: WrapUnit[] = []
  let used = 0
  const flush = (): void => {
    while (current.at(-1)?.text === ' ') {
      used -= visibleColumns(current.pop()!.text)
    }
    if (current.length > 0) lines.push(merge(current))
    current = []
    used = 0
  }
  const appendAtom = (unit: WrapUnit): void => {
    const columns = visibleColumns(unit.text)
    if (used > 0 && used + columns > limit) flush()
    current.push(unit)
    used += columns
  }
  const append = (unit: WrapUnit): void => {
    const columns = visibleColumns(unit.text)
    if (used === 0 && columns > limit) {
      for (const cluster of splitGraphemes(unit.text)) appendAtom({ text: cluster, style: unit.style })
      return
    }
    if (used + columns <= limit || current.length === 0) {
      current.push(unit)
      used += columns
      return
    }
    // Keep full-width punctuation attached to the preceding CJK glyph. If
    // the row is full, move that glyph with the punctuation instead of
    // producing a visually orphaned line beginning with '：' or '。'.
    const previous = current.at(-1)
    if (isClosingPunctuation(unit.text) && previous !== undefined && visibleColumns(previous.text) > 1) {
      current.pop()
      used -= visibleColumns(previous.text)
      flush()
      appendAtom(previous)
      appendAtom(unit)
      return
    }
    flush()
    if (columns > limit) {
      for (const cluster of splitGraphemes(unit.text)) appendAtom({ text: cluster, style: unit.style })
    } else {
      appendAtom(unit)
    }
  }
  for (const unit of wrapUnits(segments)) append(unit)
  flush()
  return lines
}

/** Join adjacent same-style runs so the app renders fewer elements. */
function merge(segments: readonly MdSegment[]): readonly MdSegment[] {
  const merged: MdSegment[] = []
  for (const segment of segments) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.style === segment.style) {
      merged[merged.length - 1] = { text: last.text + segment.text, style: last.style }
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}

/** One parsed inline run before wrapping. */
interface InlineRun {
  text: string
  style: MdStyle
}

/**
 * Parse inline markdown in one line of text. Link destinations render as a
 * dim `(url)` suffix — the visible text keeps the accent.
 */
function parseInline(text: string): readonly InlineRun[] {
  const runs: InlineRun[] = []
  let rest = text
  while (rest !== '') {
    const code = /^`([^`]+)`/u.exec(rest)
    if (code !== null) {
      runs.push({ text: code[1] ?? '', style: 'code' })
      rest = rest.slice(code[0].length)
      continue
    }
    const boldItalic = /^\*\*\*([^*]+)\*\*\*/u.exec(rest)
    if (boldItalic !== null) {
      runs.push({ text: boldItalic[1] ?? '', style: 'boldItalic' })
      rest = rest.slice(boldItalic[0].length)
      continue
    }
    const bold = /^\*\*([^*]+)\*\*/u.exec(rest)
    if (bold !== null) {
      runs.push({ text: bold[1] ?? '', style: 'bold' })
      rest = rest.slice(bold[0].length)
      continue
    }
    const italic = /^\*([^*]+)\*/u.exec(rest) ?? /^_([^_]+)_/u.exec(rest)
    if (italic !== null) {
      runs.push({ text: italic[1] ?? '', style: 'italic' })
      rest = rest.slice(italic[0].length)
      continue
    }
    const strike = /^~~([^~]+)~~/u.exec(rest)
    if (strike !== null) {
      runs.push({ text: strike[1] ?? '', style: 'strike' })
      rest = rest.slice(strike[0].length)
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/u.exec(rest)
    if (link !== null) {
      const label = link[1] ?? ''
      const url = link[2] ?? ''
      runs.push({ text: label, style: 'accent' })
      runs.push({ text: ` (${url})`, style: 'dim' })
      rest = rest.slice(link[0].length)
      continue
    }
    // Plain run up to the next special opener.
    const next = rest.search(/[*_`~[]/u)
    if (next === -1) {
      runs.push({ text: rest, style: 'plain' })
      break
    }
    if (next > 0) {
      runs.push({ text: rest.slice(0, next), style: 'plain' })
      rest = rest.slice(next)
      continue
    }
    // A special opener at position 0 that no pattern consumed: emit it
    // literally and advance, so unbalanced syntax never loops.
    runs.push({ text: rest.slice(0, 1), style: 'plain' })
    rest = rest.slice(1)
  }
  return runs
}

const HEADING = /^(#{1,6})\s+(.*)$/u
const FENCE = /^```([^\s`]*)\s*$/u
const RULE = /^(?:---|\*\*\*|___)\s*$/u
const QUOTE = /^>\s?(.*)$/u
const UNORDERED = /^\s*[-*+]\s+(.*)$/u
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/u
const TABLE_DELIMITER = /^(:)?-+(:)?$/u
const TABLE_COLUMN_GAP = 2
const TABLE_CELL_PADDING = 1
const TABLE_MIN_COLUMN_WIDTH = 3
const TABLE_MIN_ALIGNED_VALUE_WIDTH = 16
const MAX_TABLE_COLUMNS = 12

type TableAlignment = 'left' | 'center' | 'right'

interface ParsedTable {
  headers: readonly string[]
  alignments: readonly TableAlignment[]
  rows: readonly (readonly string[])[]
  nextIndex: number
}

/** Split one pipe row without treating escaped or inline-code pipes as cells. */
function splitTableRow(line: string): string[] | undefined {
  const source = line.trim()
  if (!source.includes('|')) return undefined
  const cells: string[] = []
  let current = ''
  let inCode = false
  let sawSeparator = false
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? ''
    if (char === '\\' && source[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '`') {
      inCode = !inCode
      current += char
      continue
    }
    if (char === '|' && !inCode) {
      cells.push(current.trim())
      current = ''
      sawSeparator = true
      continue
    }
    current += char
  }
  if (!sawSeparator) return undefined
  cells.push(current.trim())
  if (source.startsWith('|') && cells[0] === '') cells.shift()
  if (source.endsWith('|') && cells.at(-1) === '') cells.pop()
  return cells.length === 0 ? undefined : cells
}

/** Parse the alignment marker carried by one GFM delimiter cell. */
function tableAlignment(cell: string): TableAlignment | undefined {
  const match = TABLE_DELIMITER.exec(cell)
  if (match === null) return undefined
  if (match[1] !== undefined && match[2] !== undefined) return 'center'
  if (match[2] !== undefined) return 'right'
  return 'left'
}

/** Recognize one complete GFM pipe table at `startIndex`. */
function parseTable(source: readonly string[], startIndex: number): ParsedTable | undefined {
  const headers = splitTableRow(source[startIndex] ?? '')
  const delimiters = splitTableRow(source[startIndex + 1] ?? '')
  if (headers === undefined || delimiters === undefined || headers.length !== delimiters.length) return undefined
  if (headers.length === 0 || headers.length > MAX_TABLE_COLUMNS) return undefined
  const alignments = delimiters.map(tableAlignment)
  if (alignments.some(alignment => alignment === undefined)) return undefined

  const rows: string[][] = []
  let nextIndex = startIndex + 2
  while (nextIndex < source.length) {
    const cells = splitTableRow(source[nextIndex] ?? '')
    if (cells === undefined) break
    rows.push(Array.from({ length: headers.length }, (_, column) => cells[column] ?? ''))
    nextIndex += 1
  }
  return {
    headers,
    alignments: alignments as TableAlignment[],
    rows,
    nextIndex,
  }
}

/** Visible width of one styled cell line. */
function segmentsWidth(segments: readonly MdSegment[]): number {
  return segments.reduce((total, segment) => total + visibleColumns(segment.text), 0)
}

/** Drop wrapping-only leading spaces while preserving styles. */
function trimLeadingSpaces(segments: readonly MdSegment[]): readonly MdSegment[] {
  const trimmed = segments.map(segment => ({ ...segment }))
  while (trimmed[0]?.text.startsWith(' ') === true) {
    const first = trimmed[0]
    const text = first.text.replace(/^ +/u, '')
    if (text === '') trimmed.shift()
    else trimmed[0] = { ...first, text }
  }
  return trimmed
}

/** Hard-split an oversized soft-wrapped row while retaining inline styles. */
function hardWrapSegments(segments: readonly MdSegment[], width: number): readonly MdSegment[][] {
  const out: MdSegment[][] = []
  let current: MdSegment[] = []
  let used = 0
  const flush = (): void => {
    out.push(current)
    current = []
    used = 0
  }
  for (const segment of segments) {
    for (const cluster of splitGraphemes(segment.text)) {
      const cells = graphemeWidth(cluster)
      if (used > 0 && used + cells > width) flush()
      const previous = current.at(-1)
      if (previous?.style === segment.style) previous.text += cluster
      else current.push({ text: cluster, style: segment.style })
      used += cells
    }
  }
  if (current.length > 0 || out.length === 0) flush()
  return out
}

/** Wrap one table cell to its allocated content width. */
function wrapTableCell(runs: readonly InlineRun[], width: number): readonly MdSegment[][] {
  const segments = runs.map(run => seg(run.text, run.style))
  const soft = wrapSegments(segments, Math.max(1, width))
  if (soft.length === 0) return [[]]
  const wrapped: MdSegment[][] = []
  for (const line of soft) {
    const trimmed = trimLeadingSpaces(line)
    if (segmentsWidth(trimmed) <= width) wrapped.push(trimmed.map(segment => ({ ...segment })))
    else wrapped.push(...hardWrapSegments(trimmed, width))
  }
  return wrapped
}

/** Visible width after removing inline Markdown delimiters. */
function tableCellWidth(cell: string): number {
  return segmentsWidth(parseInline(cell).map(run => seg(run.text, run.style)))
}

/** Allocate readable grid widths or request the vertical record fallback. */
function tableColumnWidths(table: ParsedTable, width: number): readonly number[] | undefined {
  const columnCount = table.headers.length
  const reserved = (columnCount * TABLE_CELL_PADDING) + ((columnCount - 1) * TABLE_COLUMN_GAP)
  const available = width - reserved
  if (available < columnCount * TABLE_MIN_COLUMN_WIDTH) return undefined
  const widths = table.headers.map((header, column) => Math.max(
    TABLE_MIN_COLUMN_WIDTH,
    tableCellWidth(header),
    ...table.rows.map(row => tableCellWidth(row[column] ?? '')),
  ))
  let overflow = widths.reduce((total, value) => total + value, 0) - available
  while (overflow > 0) {
    let widest = -1
    for (let column = 0; column < widths.length; column += 1) {
      if ((widths[column] ?? 0) <= TABLE_MIN_COLUMN_WIDTH) continue
      if (widest < 0 || (widths[column] ?? 0) > (widths[widest] ?? 0)) widest = column
    }
    if (widest < 0) return undefined
    widths[widest] = (widths[widest] ?? TABLE_MIN_COLUMN_WIDTH) - 1
    overflow -= 1
  }
  return widths
}

/**
 * Reject grids whose headers or body values become fragmented vertical strips.
 * This mirrors Codex's readability fallback without importing its larger table
 * classification machinery: systemic long-token breaks or a seven-line prose
 * cell are clearer as vertical field records.
 */
function tableGridIsReadable(table: ParsedTable, widths: readonly number[]): boolean {
  const wrappedHeaders = table.headers.filter((header, column) => tableCellWidth(header) > (widths[column] ?? 0)).length
  if (wrappedHeaders >= 2) return false
  let affectedRows = 0
  for (const row of table.rows) {
    let affected = false
    for (let column = 0; column < table.headers.length; column += 1) {
      const width = widths[column] ?? TABLE_MIN_COLUMN_WIDTH
      const runs = parseInline(row[column] ?? '')
      const plain = runs.map(run => run.text).join('')
      const fragmentedToken = plain.split(/\s+/u).some(token => visibleColumns(token) > width)
      const wrappedHeight = wrapTableCell(runs, width).length
      const catastrophicProse = plain.trim().split(/\s+/u).length >= 4 && width < 12 && wrappedHeight >= 7
      if (fragmentedToken || catastrophicProse) {
        affected = true
        break
      }
    }
    if (affected) affectedRows += 1
  }
  const threshold = table.rows.length <= 1 ? 1 : Math.max(2, Math.ceil(table.rows.length / 3))
  return affectedRows < threshold
}

/** Apply one table-cell alignment to a wrapped content row. */
function alignedCell(
  segments: readonly MdSegment[],
  width: number,
  alignment: TableAlignment,
): { left: number; right: number } {
  const remaining = Math.max(0, width - segmentsWidth(segments))
  if (alignment === 'right') return { left: remaining, right: 0 }
  if (alignment === 'center') return { left: Math.floor(remaining / 2), right: Math.ceil(remaining / 2) }
  return { left: 0, right: remaining }
}

/** Render one logical grid row, including wrapped cell continuations. */
function renderTableGridRow(
  cells: readonly string[],
  widths: readonly number[],
  alignments: readonly TableAlignment[],
  header: boolean,
): readonly MdLine[] {
  const wrapped = cells.map((cell, column) => wrapTableCell(parseInline(cell), widths[column] ?? TABLE_MIN_COLUMN_WIDTH))
  const height = Math.max(1, ...wrapped.map(lines => lines.length))
  return Array.from({ length: height }, (_, rowIndex) => {
    const segments: MdSegment[] = []
    for (let column = 0; column < cells.length; column += 1) {
      const line = wrapped[column]?.[rowIndex] ?? []
      const styled = header
        ? line.map(segment => ({ ...segment, style: 'accentBold' as const }))
        : line
      const alignment = alignedCell(styled, widths[column] ?? TABLE_MIN_COLUMN_WIDTH, alignments[column] ?? 'left')
      segments.push(seg(' '.repeat(TABLE_CELL_PADDING + alignment.left)))
      segments.push(...styled)
      if (column + 1 < cells.length) segments.push(seg(' '.repeat(alignment.right + TABLE_COLUMN_GAP)))
    }
    return { segments: merge(segments) }
  })
}

/** Render a table as Codex-style borderless rows with measured separators. */
function renderTableGrid(table: ParsedTable, widths: readonly number[]): readonly MdLine[] {
  const separator = (char: string): MdLine => ({
    segments: [seg(widths.map(width => char.repeat(width + TABLE_CELL_PADDING)).join(' '.repeat(TABLE_COLUMN_GAP)), 'dim')],
  })
  const lines: MdLine[] = [
    ...renderTableGridRow(table.headers, widths, table.alignments, true),
    separator('━'),
  ]
  for (let row = 0; row < table.rows.length; row += 1) {
    lines.push(...renderTableGridRow(table.rows[row] ?? [], widths, table.alignments, false))
    if (row + 1 < table.rows.length) lines.push(separator('─'))
  }
  return lines
}

/** Render an unreadably narrow grid as vertically scannable field records. */
function renderTableRecords(table: ParsedTable, width: number): readonly MdLine[] {
  const labelWidth = Math.max(...table.headers.map(tableCellWidth))
  const prefixWidth = TABLE_CELL_PADDING + labelWidth + TABLE_COLUMN_GAP
  const aligned = prefixWidth + TABLE_MIN_ALIGNED_VALUE_WIDTH <= width
  const lines: MdLine[] = []
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex] ?? []
    for (let column = 0; column < table.headers.length; column += 1) {
      const label = table.headers[column] ?? ''
      const value = row[column] ?? ''
      const labelRuns = parseInline(label).map(run => seg(run.text, 'accentBold'))
      if (aligned) {
        const valueLines = wrapTableCell(parseInline(value), Math.max(1, width - prefixWidth))
        for (let lineIndex = 0; lineIndex < valueLines.length; lineIndex += 1) {
          const prefix = lineIndex === 0
            ? [seg(' '), ...labelRuns, seg(' '.repeat(labelWidth - tableCellWidth(label) + TABLE_COLUMN_GAP))]
            : [seg(' '.repeat(prefixWidth))]
          lines.push({ segments: merge([...prefix, ...(valueLines[lineIndex] ?? [])]) })
        }
      } else {
        lines.push({ segments: merge([seg(' '), ...labelRuns]) })
        for (const valueLine of wrapTableCell(parseInline(value), Math.max(1, width - 2))) {
          lines.push({ segments: merge([seg('  '), ...valueLine]) })
        }
      }
    }
    if (rowIndex + 1 < table.rows.length) lines.push({ segments: [seg('─'.repeat(width), 'dim')] })
  }
  return lines
}

/** Render markdown text into styled lines of at most `width` columns. */
export function renderMarkdown(
  text: string,
  width: number,
  options: { physicalWrap?: boolean } = {},
): readonly MdLine[] {
  const lines: MdLine[] = []
  let separatorPending = false
  const push = (segments: readonly MdSegment[]): void => {
    if (options.physicalWrap === false) {
      lines.push({ segments: merge(segments) })
      return
    }
    for (const wrapped of wrapSegments(segments, Math.max(10, width))) {
      lines.push({ segments: merge(wrapped) })
    }
  }
  const startBlock = (): void => {
    if (separatorPending && lines.length > 0 && lines.at(-1)?.segments.length !== 0) {
      lines.push({ segments: [] })
    }
    separatorPending = false
  }
  // Tabs become two visible spaces: terminal tab stops are contextual and
  // cannot participate in a deterministic column budget (the same rule the
  // styled-row path applies in lines.ts).
  const raw = text.replaceAll('\r', '').replaceAll('\t', '  ')
  const source = raw.split('\n')
  let index = 0
  while (index < source.length) {
    const line = source[index] ?? ''
    index += 1

    // Preserve one deliberate row between source blocks. Repeated blank
    // lines collapse, and leading/trailing whitespace never grows output.
    if (line.trim() === '') {
      separatorPending = lines.length > 0
      continue
    }
    startBlock()

    const table = parseTable(source, index - 1)
    if (table !== undefined) {
      const tableWidth = Math.max(10, Math.floor(width))
      const columnWidths = tableColumnWidths(table, tableWidth)
      lines.push(...(columnWidths === undefined || !tableGridIsReadable(table, columnWidths)
        ? renderTableRecords(table, tableWidth)
        : renderTableGrid(table, columnWidths)))
      index = table.nextIndex
      continue
    }

    // Fenced code block: verbatim lines in code style, language label first.
    // A ```diff fence keeps the same classification the /diff panel uses
    // (shared rule: lines.ts diffLineStyle) so pasted review diffs render
    // with the added/removed tints everywhere markdown does.
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const language = fence[1] ?? ''
      const diffFence = language === 'diff' || language === 'patch'
      if (language !== '') push([seg(`  ${language}`, 'dim')])
      while (index < source.length && !FENCE.test(source[index] ?? '')) {
        const source_ = source[index] ?? ''
        const style: MdStyle = !diffFence
          ? 'code'
          : source_.startsWith('+') && !source_.startsWith('+++')
            ? 'diffAdd'
            : source_.startsWith('-') && !source_.startsWith('---')
              ? 'diffDel'
              : 'code'
        push([seg(`  ${source_}`, style)])
        index += 1
      }
      index += 1 // closing fence
      continue
    }

    if (RULE.test(line.trim())) {
      push([seg(`  ${'─'.repeat(Math.max(1, Math.floor(width / 4)))}`, 'dim')])
      continue
    }
    const heading = HEADING.exec(line)
    if (heading !== null) {
      push([seg(heading[2] ?? '', 'accent')])
      continue
    }
    const quote = QUOTE.exec(line)
    if (quote !== null) {
      push([seg('  │ ', 'accent'), ...parseInline(quote[1] ?? '').map(run => seg(run.text, run.style === 'plain' ? 'dim' : run.style))])
      continue
    }
    const ordered = ORDERED.exec(line)
    if (ordered !== null) {
      const prefix = options.physicalWrap === false ? `${ordered[1] ?? ''}. ` : `  ${ordered[1] ?? ''}. `
      push([seg(prefix, 'accent'), ...parseInline(ordered[2] ?? '').map(run => seg(run.text, run.style))])
      continue
    }
    const unordered = UNORDERED.exec(line)
    if (unordered !== null) {
      push([seg(options.physicalWrap === false ? '• ' : '  • ', 'accent'), ...parseInline(unordered[1] ?? '').map(run => seg(run.text, run.style))])
      continue
    }

    // Paragraph: gather until a blank line, then wrap as one flow. Line
    // breaks inside a paragraph join as a single space (GFM soft breaks).
    const paragraph = [line]
    while (index < source.length && (source[index] ?? '').trim() !== '') {
      paragraph.push(source[index] ?? '')
      index += 1
    }
    const runs: InlineRun[] = []
    for (let at = 0; at < paragraph.length; at += 1) {
      if (at > 0) runs.push({ text: ' ', style: 'plain' })
      runs.push(...parseInline(paragraph[at] ?? ''))
    }
    push(runs.map(run => seg(run.text, run.style)))
  }
  return lines
}
