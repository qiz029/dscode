/**
 * dscode: the /delegate-dashboard kanban. Four columns — pending, running,
 * verifying, complete — over the coordinator's delegate board, re-read once a
 * second so a child settling or a task completing shows without a keypress.
 * Read-only; Esc or q closes it.
 *
 * @module dsh-code/dscode/delegate-panel
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { panelViewport } from '../render/inspector.ts'
import { singleLineText, truncateColumns } from '../render/text.ts'
import { stringWidth } from '../render/width.ts'
import { panelAccent } from '../panel-accent.ts'
import { t } from '../i18n.ts'
import { getPalette, inkColor, type ThemeToken } from '../theme.ts'

export const DELEGATE_COLUMNS = ['pending', 'running', 'verifying', 'complete'] as const
export type DelegateColumn = typeof DELEGATE_COLUMNS[number]

/** One task card as the host board reports it. */
export interface DelegateTask {
  readonly id: string
  readonly title: string
  readonly child: string
  readonly waiting?: boolean
  readonly priority?: 'high' | 'normal' | 'low'
  /** Pending only: dependencies that are not complete yet. */
  readonly blockedBy?: readonly string[]
}

/** The board of the current root session, or undefined when no board source is mounted. */
export interface DelegateSnapshot {
  readonly columns: Readonly<Record<DelegateColumn, readonly DelegateTask[]>>
  readonly running: number
  readonly limit: number
}

const TONE: Record<DelegateColumn, ThemeToken> = { pending: 'code', running: 'brandBright', verifying: 'warn', complete: 'success' }
const GLYPH: Record<DelegateColumn, string> = { pending: '○', running: '●', verifying: '◐', complete: '✓' }
/** Narrower columns than this stack the board vertically instead. */
const MIN_COLUMN = 14
/** Rows one card takes: its two border rows, the id line and the title line. */
export const CARD_ROWS = 4
/** A compact card folds the id and the title into one line. */
export const COMPACT_CARD_ROWS = 3
/** Cells of the child-slot meter in the title row. */
const METER_CELLS = 10

const cardText = (task: DelegateTask): string => `${task.waiting ? '? ' : ''}${task.id} /${task.child}${task.priority === 'high' ? ' ▲' : ''}${task.blockedBy?.length ? ` ${t('panel.delegate.after', { ids: task.blockedBy.join(',') })}` : ''} ${singleLineText(task.title)}`

/** Up to `rows` card lines for one column, the last replaced by "+N" when the rest do not fit. */
export function columnLines(tasks: readonly DelegateTask[], rows: number): string[] {
  if (rows <= 0) return []
  if (tasks.length <= rows) return tasks.map(cardText)
  const shown = tasks.slice(0, Math.max(0, rows - 1)).map(cardText)
  return [...shown, t('panel.delegate.more', { count: tasks.length - shown.length })]
}

/** How many cards of `size` rows fit in `rows`, leaving one row for "+N" when some are hidden. */
export function cardsThatFit(count: number, rows: number, size: number = CARD_ROWS): number {
  if (count * size <= rows) return count
  return Math.max(0, Math.floor((rows - 1) / size))
}

/** Children waiting on the main agent need it first, so their cards lead the column. */
export function orderCards(tasks: readonly DelegateTask[]): readonly DelegateTask[] {
  return tasks.some(task => task.waiting) ? [...tasks.filter(task => task.waiting), ...tasks.filter(task => !task.waiting)] : tasks
}

/** One run of colored text inside a line; a line is truncated across its runs by display width. */
interface Run {
  readonly text: string
  readonly color?: ThemeToken
  readonly bold?: boolean
  readonly dim?: boolean
  readonly inverse?: boolean
}

/** A single terminal line built from colored runs, cut to `width` display columns. */
function Line({ runs, width }: { runs: readonly Run[]; width: number }): ReactElement {
  const palette = getPalette()
  let left = Math.max(0, width)
  const parts: ReactElement[] = []
  for (const [index, run] of runs.entries()) {
    if (left <= 0) break
    const text = stringWidth(run.text) > left ? truncateColumns(run.text, left) : run.text
    left -= stringWidth(text)
    parts.push(createElement(Text, {
      key: index,
      color: run.color === undefined ? undefined : inkColor(palette[run.color]),
      bold: run.bold,
      dimColor: run.dim,
      inverse: run.inverse,
    }, text))
  }
  return createElement(Text, { wrap: 'truncate' }, ...parts)
}

/** `filled` of `total` slots as a bar: used cells in `tone`, the rest dim. */
export function slotMeter(filled: number, total: number, cells: number = METER_CELLS): { used: string; free: string } {
  if (total <= 0) return { used: '', free: '▱'.repeat(cells) }
  const used = Math.min(cells, Math.round(cells * Math.min(filled, total) / total))
  return { used: '▰'.repeat(used), free: '▱'.repeat(cells - used) }
}

function Card({ task, column, width, compact }: { task: DelegateTask; column: DelegateColumn; width: number; compact: boolean }): ReactElement {
  const palette = getPalette()
  const inner = Math.max(1, width - 4)
  const blocked = (task.blockedBy?.length ?? 0) > 0
  const tone: ThemeToken = task.waiting ? 'warn' : blocked ? 'dim' : TONE[column]
  const done = column === 'complete'
  const head: Run[] = [
    { text: `${blocked ? '◌' : GLYPH[column]} `, color: tone },
    { text: task.id, color: tone, bold: true },
    { text: ' /', dim: true },
    { text: task.child, color: 'text', bold: !done && !blocked, dim: done || blocked },
    ...(task.priority === 'high' && !done ? [{ text: ' ▲', color: 'error' as const, bold: true }] : []),
    ...(task.priority === 'low' && !done ? [{ text: ' ▼', dim: true }] : []),
  ]
  const badge: Run[] = task.waiting ? [{ text: ' ' }, { text: ' ? ', color: 'warn', inverse: true, bold: true }] : []
  const after: Run[] = blocked ? [{ text: `${t('panel.delegate.after', { ids: task.blockedBy!.join(',') })} · `, color: 'warn' }] : []
  const title: Run = { text: singleLineText(task.title), color: done || blocked ? undefined : 'text', dim: done || blocked }
  const box = { width, borderStyle: 'round' as const, borderColor: inkColor(palette[tone]), paddingX: 1 }
  if (compact) return createElement(Box, box, createElement(Line, { runs: [...head, ...badge, { text: ' ' }, ...after, title], width: inner }))
  return createElement(
    Box,
    { ...box, flexDirection: 'column' },
    createElement(Line, { runs: [...head, ...badge], width: inner }),
    createElement(Line, { runs: [...after, title], width: inner }),
  )
}

function ColumnHeader({ column, count, width }: { column: DelegateColumn; count: number; width: number }): ReactElement {
  return createElement(Line, {
    width,
    runs: [
      { text: ` ${GLYPH[column]} ${t(`panel.delegate.${column}`)} `, color: TONE[column], inverse: true, bold: true },
      { text: ` ${count}`, color: TONE[column], bold: true },
    ],
  })
}

export function DelegateDashboardPanel({ load, close }: { load: () => DelegateSnapshot | undefined; close: () => void }): ReactElement {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(value => value + 1), 1_000)
    return () => clearInterval(id)
  }, [])
  useInput((input, key) => {
    if (key.escape || input === 'q') close()
  })
  const snapshot = load()
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const palette = getPalette()
  const counts = DELEGATE_COLUMNS.map(column => snapshot?.columns[column].length ?? 0)
  const total = counts.reduce((sum, count) => sum + count, 0)
  const heading = (column: DelegateColumn, index: number): string => `${t(`panel.delegate.${column}`)} ${counts[index]}`
  if (viewport.maxHeight === 0 || viewport.compact) {
    const summary = DELEGATE_COLUMNS.map(heading).join(' · ')
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`/delegate-dashboard · ${summary}`, viewport.contentColumns))
  }
  const accent = panelAccent('delegate', palette.brand, palette.brandBright)
  const width = viewport.contentColumns
  const running = snapshot?.running ?? 0
  const limit = snapshot?.limit ?? 0
  const meter = slotMeter(running, limit)
  const full = limit > 0 && running >= limit
  const complete = counts[DELEGATE_COLUMNS.indexOf('complete')]
  const titleRow = createElement(Line, {
    width,
    runs: [
      { text: `◆ ${t('panel.delegate.name')}`, color: 'brandBright', bold: true },
      { text: '   ' },
      { text: `${t('panel.delegate.slots')} `, dim: true },
      { text: meter.used, color: full ? 'warn' : 'brandBright' },
      { text: meter.free, dim: true },
      { text: ` ${running}/${limit}`, color: full ? 'warn' : 'brandBright', bold: true },
      ...(total > 0 ? [
        { text: '   ' },
        { text: `✓ ${complete}/${total} `, color: 'success' as const, bold: true },
        { text: t('panel.delegate.done'), dim: true },
      ] : []),
    ],
  })
  const body: ReactElement[] = []
  // Each divider takes three columns: a space, the rule and a space.
  const gaps = (DELEGATE_COLUMNS.length - 1) * 3
  const columnWidth = Math.floor((width - gaps) / DELEGATE_COLUMNS.length)
  if (total === 0 || snapshot === undefined) {
    body.push(createElement(Line, { key: 'empty', width, runs: [{ text: '  ○ ', color: 'code' }, { text: t('panel.delegate.empty'), dim: true }] }))
  } else if (columnWidth >= MIN_COLUMN) {
    // Column header and its rule take two rows; cards share the rest.
    const cardRows = Math.max(COMPACT_CARD_ROWS, viewport.bodyRows - 2)
    // Full cards while every column fits; otherwise every card folds to one line.
    const compact = DELEGATE_COLUMNS.some(column => snapshot.columns[column].length * CARD_ROWS > cardRows)
    const size = compact ? COMPACT_CARD_ROWS : CARD_ROWS
    // The dividers run as tall as the fullest column, not the whole budget.
    const used = Math.max(1, ...DELEGATE_COLUMNS.map(column => {
      const count = snapshot.columns[column].length
      const fit = cardsThatFit(count, cardRows, size)
      return count === 0 ? 1 : fit * size + (fit < count ? 1 : 0)
    }))
    const spare = width - gaps - columnWidth * DELEGATE_COLUMNS.length
    body.push(createElement(Box, { key: 'columns', flexDirection: 'row' }, ...DELEGATE_COLUMNS.map((column, index) => {
      const first = index === 0
      const last = index === DELEGATE_COLUMNS.length - 1
      const tasks = orderCards(snapshot.columns[column])
      const fit = cardsThatFit(tasks.length, cardRows, size)
      const cardWidth = columnWidth + (last ? spare : 0)
      return createElement(
        Box,
        {
          key: column,
          width: cardWidth + (first ? 0 : 1) + (last ? 0 : 2),
          height: used + 2,
          flexDirection: 'column',
          paddingLeft: first ? 0 : 1,
          paddingRight: last ? 0 : 1,
          ...(last ? {} : { borderStyle: 'single', borderTop: false, borderBottom: false, borderLeft: false, borderRight: true, borderColor: inkColor(palette.brandDeep) }),
        },
        createElement(ColumnHeader, { column, count: counts[index], width: cardWidth }),
        createElement(Text, { color: inkColor(palette[TONE[column]]), wrap: 'truncate' }, '━'.repeat(Math.max(1, cardWidth))),
        ...(tasks.length === 0
          ? [createElement(Text, { key: 'none', dimColor: true, italic: true, wrap: 'truncate-end' }, truncateColumns(t('panel.delegate.none'), cardWidth))]
          : tasks.slice(0, fit).map(task => createElement(Card, { key: task.id, task, column, width: cardWidth, compact }))),
        ...(fit < tasks.length ? [createElement(Line, { key: 'more', width: cardWidth, runs: [{ text: t('panel.delegate.more', { count: tasks.length - fit }), color: TONE[column], bold: true }] })] : []),
      )
    })))
  } else {
    // Too narrow for four columns: one section per column, sharing the row budget.
    let budget = Math.max(DELEGATE_COLUMNS.length, viewport.bodyRows)
    DELEGATE_COLUMNS.forEach((column, index) => {
      if (budget <= 0) return
      body.push(createElement(ColumnHeader, { key: column, column, count: counts[index], width }))
      budget--
      const share = Math.min(snapshot.columns[column].length, Math.max(0, budget - (DELEGATE_COLUMNS.length - 1 - index)))
      for (const [row, line] of columnLines(orderCards(snapshot.columns[column]), share).entries()) {
        body.push(createElement(Line, { key: `${column}-${row}`, width, runs: [{ text: '  ' }, { text: line, color: line.startsWith('? ') ? 'warn' : undefined }] }))
      }
      budget -= share
    })
  }
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    titleRow,
    ...body,
    createElement(Line, {
      width,
      runs: [
        { text: 'esc', color: 'brandBright', bold: true }, { text: '/', dim: true }, { text: 'q', color: 'brandBright', bold: true },
        { text: ` ${t('panel.delegate.close')}  `, dim: true },
        { text: ' ? ', color: 'warn', inverse: true, bold: true },
        { text: ` ${t('panel.delegate.waitingHint')}  `, dim: true },
        { text: '▲', color: 'error', bold: true }, { text: ` ${t('panel.delegate.high')}  `, dim: true },
        { text: t('panel.delegate.refresh'), dim: true },
      ],
    }),
  )
}
