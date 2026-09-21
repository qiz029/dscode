/**
 * dscode: DSCODE's transcript rendering. The default view stays quiet — tool
 * calls and the model's thinking only appear (dim) once verbose is on — and a
 * wrapped user prompt is painted as one continuous background band.
 *
 * @module dsh-code/dscode/chat
 */

import type { TranscriptEntry } from '../render/projection.ts'
import { visibleColumns } from '../render/markdown.ts'
import {
  hangingStyledLines,
  hangingTextLines,
  lineSegment,
  textLines,
  transcriptEntryLines,
  type StyledLine,
} from '../render/lines.ts'

/** Pad every physical row of a wrapped prompt so its background stays unbroken. */
export function userBackgroundRows(
  rows: readonly StyledLine[],
  columns: number,
  measure: (text: string) => number,
): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  return rows.map(row => {
    const used = row.segments.reduce((sum, segment) => sum + measure(segment.text), 0)
    return {
      ...row,
      background: 'user' as const,
      segments: [...row.segments, { text: ' '.repeat(Math.max(0, width - used)), style: 'plain' as const }],
    }
  })
}

/** Local wall-clock HH:MM:SS for a row, or undefined when it carries no time. */
function timeStamp(time: number | undefined): string | undefined {
  if (time === undefined) return undefined
  const at = new Date(time)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return pad(at.getHours()) + ':' + pad(at.getMinutes()) + ':' + pad(at.getSeconds())
}

/** Put a dim timestamp in front of a block first row. */
function stamped(lines: readonly StyledLine[], label: string | undefined): readonly StyledLine[] {
  if (label === undefined || lines.length === 0) return lines
  return [{ ...lines[0], segments: [lineSegment(label + ' ', 'dim'), ...lines[0].segments] }, ...lines.slice(1)]
}

/** The folded thinking tail: one dim paragraph, capped, with the Ctrl+O hint. */
function thinkingLines(reasoning: string, width: number): readonly StyledLine[] {
  const lines = hangingTextLines('Thinking: ' + reasoning.replace(/\s+/g, ' ').trim(), width, '· ', 'dimItalic', '  ')
  const cap = 8
  return lines.length <= cap
    ? lines
    : [...lines.slice(0, cap), ...textLines('  … ' + (lines.length - cap) + ' more lines · Ctrl+O opens the full history', width, 'dim')]
}

/**
 * Memoize the live-region render by ENTRY IDENTITY. Streaming carried the whole
 * live region into a re-render per frame (`view.entries` changes identity on
 * every event), so the same settled-but-unflushed entries were re-wrapped from
 * scratch ~60 times a second while only the streaming text — which lives in
 * `view.streaming`, not in an entry — actually changed. The projection replaces
 * an entry with a new object whenever its content changes (`{...entry}` at every
 * mutation site), so identity is a sound cache key, and the wrap depends only on
 * the entry, the column budget and `verbose`.
 * @returns a `(entry, columns, verbose) => lines` function with a WeakMap cache.
 */
export function createChatLinesCache(): (entry: TranscriptEntry, columns: number, verbose?: boolean) => readonly StyledLine[] {
  // Per wrap context: a width or `verbose` change re-wraps every row. Keying
  // the maps instead of resetting one map keeps interleaved contexts (two
  // regions rendering at different widths in one frame) from thrashing.
  const contexts = new Map<string, WeakMap<TranscriptEntry, readonly StyledLine[]>>()
  return (entry, columns, verbose = false) => {
    const width = Math.max(1, Math.floor(columns))
    const key = `${width}:${verbose ? 1 : 0}`
    let cache = contexts.get(key)
    if (cache === undefined) {
      cache = new WeakMap()
      contexts.set(key, cache)
    }
    const hit = cache.get(entry)
    if (hit !== undefined) return hit
    // The wrapped width is the same normalized value the key names, so a
    // fractional column count cannot key one width and wrap at another.
    const lines = dscodeChatLines(entry, width, verbose)
    cache.set(entry, lines)
    return lines
  }
}

/**
 * Render one transcript entry the DSCODE way: tool rows are quiet unless verbose
 * is on, assistant rows fold their thinking above the answer, and user prompts
 * carry the background band.
 */
export function dscodeChatLines(entry: TranscriptEntry, columns: number, verbose = false): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  const label = entry.kind === 'assistant' || entry.kind === 'tool' ? timeStamp(entry.time) : undefined
  // The stamp leads the block, so the rows wrap to what is left of the width: a row that
  // overflowed here would cost an extra screen row per block and move the composer.
  const stampWidth = label === undefined ? 0 : visibleColumns(label + ' ')
  const blockWidth = Math.max(1, width - stampWidth)
  const blockColumns = Math.max(1, columns - stampWidth)
  if (entry.kind === 'tool') {
    if (!verbose) return []
    const state = entry.state === 'running' ? ' · running' : entry.state === 'error' ? ' · error' : ''
    const lines = [...stamped(hangingStyledLines(
      [
        lineSegment('Tool Call: ' + entry.name, 'dim'),
        lineSegment(entry.preview ? ' ' + entry.preview : '', 'dim'),
        lineSegment(state, entry.state === 'error' ? 'error' : 'dim'),
      ],
      blockWidth,
      '· ',
      'dim',
      '  ',
      'dim',
    ), label)]
    if (entry.summary) {
      lines.push(...hangingTextLines('Output: ' + entry.summary, width, '  ', entry.state === 'error' ? 'error' : 'dim', '    '))
    }
    lines.push({ segments: [] })
    return lines
  }
  if (entry.kind === 'assistant') {
    const thinking = verbose && entry.reasoning ? [...stamped(thinkingLines(entry.reasoning, blockWidth), label), { segments: [] }] : []
    if (!entry.text && !entry.interrupted) return thinking
    const body = [...thinking, ...stamped(transcriptEntryLines({ ...entry, reasoning: '' }, blockColumns, false, false, false), label)]
    // The turn's last reply closes the turn with its own rule and breathing rows.
    return entry.turnEnded === true
      ? [...body, { segments: [] }, { segments: [{ text: '─'.repeat(width), style: 'dim' as const }] }, { segments: [] }]
      : body
  }
  const rows = transcriptEntryLines(entry, columns, false, false, false)
  return entry.kind === 'user' && !entry.notice ? [...userBackgroundRows(rows, columns, visibleColumns), { segments: [] }] : rows
}
