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

/** The folded thinking tail: one dim paragraph, capped, with the Ctrl+O hint. */
function thinkingLines(reasoning: string, width: number): readonly StyledLine[] {
  const lines = hangingTextLines('Thinking: ' + reasoning.replace(/\s+/g, ' ').trim(), width, '· ', 'dimItalic', '  ')
  const cap = 8
  return lines.length <= cap
    ? lines
    : [...lines.slice(0, cap), ...textLines('  … ' + (lines.length - cap) + ' more lines · Ctrl+O opens the full history', width, 'dim')]
}

/**
 * Render one transcript entry the DSCODE way: tool rows are quiet unless verbose
 * is on, assistant rows fold their thinking above the answer, and user prompts
 * carry the background band.
 */
export function dscodeChatLines(entry: TranscriptEntry, columns: number, verbose = false): readonly StyledLine[] {
  const width = Math.max(1, Math.floor(columns))
  if (entry.kind === 'tool') {
    if (!verbose) return []
    const state = entry.state === 'running' ? ' · running' : entry.state === 'error' ? ' · error' : ''
    const lines = hangingStyledLines(
      [
        lineSegment('Tool Call: ' + entry.name, 'dim'),
        lineSegment(entry.preview ? ' ' + entry.preview : '', 'dim'),
        lineSegment(state, entry.state === 'error' ? 'error' : 'dim'),
      ],
      width,
      '· ',
      'dim',
      '  ',
      'dim',
    )
    if (entry.summary) {
      lines.push(...hangingTextLines('Output: ' + entry.summary, width, '  ', entry.state === 'error' ? 'error' : 'dim', '    '))
    }
    lines.push({ segments: [] })
    return lines
  }
  if (entry.kind === 'assistant') {
    const thinking = verbose && entry.reasoning ? [...thinkingLines(entry.reasoning, width), { segments: [] }] : []
    if (!entry.text && !entry.interrupted) return thinking
    const body = [...thinking, ...transcriptEntryLines({ ...entry, reasoning: '' }, columns, false, false, false)]
    // The turn's last reply closes the turn with its own rule and breathing rows.
    return entry.turnEnded === true
      ? [...body, { segments: [] }, { segments: [{ text: '─'.repeat(width), style: 'dim' as const }] }, { segments: [] }]
      : body
  }
  const rows = transcriptEntryLines(entry, columns, false, false, false)
  return entry.kind === 'user' && !entry.notice ? [...userBackgroundRows(rows, columns, visibleColumns), { segments: [] }] : rows
}
