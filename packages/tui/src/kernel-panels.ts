/** Bounded, composer-safe panels for preset, session, and plugin kernel views. */

import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { ModelDirectory, ModelRow } from './models.ts'
import type { SubagentRow } from './subagents.ts'
import type { ScheduleRow } from './render/projection.ts'
import type { PermissionRow } from './permissions.ts'
import type { PresetRow } from './presets.ts'
import type { PluginRow } from './plugin-inventory.ts'
import type { SessionDirectoryOptions, SessionRow } from './session-directory.ts'
import { formatRelativeTime } from './session-directory.ts'
import type { ReviewBranch, ReviewCommit, ReviewSelection } from './git-workflow.ts'
import { panelViewport, revealRow } from './render/inspector.ts'
import { markdownLines, textLines, type LineStyle, type StyledLine } from './render/lines.ts'
import { usageLines, type UsageView } from './render/usage.ts'
import { deleteLastGrapheme } from './render/editor.ts'
import { stripPasteMarkers } from './keyboard.ts'
import { DEFAULT_STATUSLINE_ITEMS, STATUS_ITEMS, type StatusItemId } from './render/status.ts'
import { singleLineText, truncateColumns } from './render/text.ts'
import { panelAccent } from './panel-accent.ts'
import { t } from './i18n.ts'
import { getPalette, inkColor } from './theme.ts'

interface ListFrameProps {
  readonly title: string
  readonly rows: readonly { readonly key: string; readonly text: string; readonly disabled?: boolean }[]
  readonly cursor: number
  readonly loading: boolean
  readonly error?: string
  readonly query: string
  /** Ctrl+F-gated search focus for this panel: typing edits the query only
   * while true. `undefined` keeps the plain "type to filter" prompt (the
   * panel filters by typing directly). */
  readonly searching?: boolean
  readonly footer: string
}

/** True for the Ctrl+F search-focus toggle. */
function isSearchToggle(input: string, key: { ctrl?: boolean }): boolean {
  return key.ctrl === true && input === 'f'
}

/** The search-state line: gated panels show only an ACTIVE filter (the ctrl+f
 * toggle lives in the footer), direct-typing panels keep the plain prompt. */
function searchLine(searching: boolean | undefined, query: string): string {
  if (searching === true) return query === '' ? t('panel.searchIdleStop') : `${t('panel.searchPrefix')}${query}`
  if (searching === false) return query === '' ? '' : `${t('panel.searchPrefix')}${query}`
  return query === '' ? t('panel.searchIdle') : `${t('panel.searchPrefix')}${query}`
}

function ListFrame(props: ListFrameProps): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  if (viewport.maxHeight === 0 || viewport.compact) {
    // One visible row instead of a hidden panel: the current selection (or
    // load state) is shown so Enter/arrows are never blind keys acting on
    // invisible state. The selection leads and `esc close` follows it, so a
    // narrow terminal truncates the panel title — never the actionable facts.
    const body = props.loading
      ? `${props.title} · loading…`
      : props.error !== undefined
        ? `${props.title} · load failed`
        : props.rows.length === 0
          ? `${props.title} · no matching entries`
          : `❯ ${singleLineText(props.rows[props.cursor]?.text ?? '')}`
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(singleLineText(`${body} · esc close`), viewport.contentColumns))
  }
  const stateRows = props.loading
    ? [{ key: 'loading', text: '  loading…' }]
    : props.error !== undefined
      ? [{ key: 'error', text: `  ${singleLineText(props.error)}` }]
      : props.rows.length === 0
        ? [{ key: 'empty', text: '  no matching entries' }]
        : props.rows
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, props.cursor, stateRows.length, bodyRows)
  const visible = stateRows.slice(offset, offset + bodyRows)
  const accent = panelAccent('kernel-list', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(singleLineText(props.title), viewport.contentColumns)),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(singleLineText(searchLine(props.searching, props.query)), viewport.contentColumns)),
    ...visible.map((row, index) => {
      const absolute = offset + index
      const selected = !props.loading && props.error === undefined && props.rows.length > 0 && absolute === props.cursor
      return createElement(Text, {
        key: row.key,
        color: selected ? inkColor(getPalette().brandBright) : row.disabled ? inkColor(getPalette().dim) : undefined,
        dimColor: row.disabled,
        wrap: 'truncate-end',
      }, truncateColumns(`${selected ? '› ' : '  '}${singleLineText(row.text)}`, viewport.contentColumns))
    }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(singleLineText(props.footer), viewport.contentColumns)),
  )
}

/**
 * Apply one keystroke to a panel search query. IME commits arrive as one
 * multi-character chunk, so the whole printable run is appended; paste
 * markers are stripped and control-laden chunks are ignored.
 */
export function editQuery(query: string, input: string, key: { backspace?: boolean; delete?: boolean }): string | undefined {
  if (key.backspace || key.delete) return deleteLastGrapheme(query)
  const text = stripPasteMarkers(input)
  if (text !== '' && !/[\u0000-\u001f\u007f]/u.test(text)) return query + text
  return undefined
}

export function ModePanel({ current, load, select, close }: {
  current: string
  load: () => Promise<readonly PresetRow[]>
  select: (id: string) => void
  close: () => void
}): ReactElement {
  const [rows, setRows] = useState<readonly PresetRow[]>([])
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const refresh = (): void => {
    setLoading(true); setError(undefined)
    Promise.resolve().then(load).then(value => { setRows(value); setLoading(false) }, reason => {
      setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false)
    })
  }
  useEffect(refresh, [])
  const visible = useMemo(() => rows.filter(row => `${row.id} ${row.name ?? ''} ${row.description ?? ''}`.toLowerCase().includes(query.toLowerCase())), [rows, query])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, visible.length - 1))), [visible.length])
  useInput((input, key) => {
    if (key.escape) return close()
    // q closes only while the query is empty; mid-filter it is query text.
    if (input === 'q' && query === '') return close()
    if (input === 'r' && query === '') return refresh()
    if (key.upArrow) return setCursor(value => visible.length === 0 ? 0 : (value + visible.length - 1) % visible.length)
    if (key.downArrow) return setCursor(value => visible.length === 0 ? 0 : (value + 1) % visible.length)
    // Empty/loading/filtered-out lists have no row at the cursor: a bare
    // `?.broken === undefined` check passes on undefined and crashes the
    // process on the `!.id` access (PermissionPanel guards this correctly).
    if (key.return && visible[cursor] !== undefined && visible[cursor].broken === undefined) return select(visible[cursor].id)
    const next = editQuery(query, input, key)
    if (next !== undefined) { setQuery(next); setCursor(0) }
  })
  return createElement(ListFrame, {
    title: t('panel.mode.title', { current }),
    rows: visible.map(row => ({ key: row.id, disabled: row.broken !== undefined, text: `${row.id === current ? '●' : '○'} ${row.name ?? row.id} · ${row.description ?? row.trust}${row.broken === undefined ? '' : ` · broken: ${row.broken}`}` })),
    cursor, loading, error, query, footer: t('panel.footer.chooseSwitch'),
  })
}

export function PermissionPanel({ current, load, select, close }: {
  current: string
  load: () => Promise<readonly PermissionRow[]>
  select: (id: string) => void
  close: () => void
}): ReactElement {
  const [rows, setRows] = useState<readonly PermissionRow[]>([])
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const refresh = (): void => {
    setLoading(true); setError(undefined)
    Promise.resolve().then(load).then(value => { setRows(value); setLoading(false) }, reason => {
      setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false)
    })
  }
  useEffect(refresh, [])
  const visible = useMemo(() => rows.filter(row => `${row.id} ${row.description ?? ''}`.toLowerCase().includes(query.toLowerCase())), [rows, query])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, visible.length - 1))), [visible.length])
  useInput((input, key) => {
    if (key.escape) return close()
    // q closes only while the query is empty; mid-filter it is query text.
    if (input === 'q' && query === '') return close()
    if (input === 'r' && query === '') return refresh()
    if (key.upArrow) return setCursor(value => visible.length === 0 ? 0 : (value + visible.length - 1) % visible.length)
    if (key.downArrow) return setCursor(value => visible.length === 0 ? 0 : (value + 1) % visible.length)
    if (key.return && visible[cursor] !== undefined) return select(visible[cursor].id)
    const next = editQuery(query, input, key)
    if (next !== undefined) { setQuery(next); setCursor(0) }
  })
  return createElement(ListFrame, {
    title: t('panel.permission.title', { current }),
    rows: visible.map(row => ({ key: row.id, text: `${row.id === current ? '●' : '○'} ${row.id}${row.description === undefined ? '' : ` · ${row.description}`}` })),
    cursor, loading, error, query, footer: t('panel.footer.chooseSelect'),
  })
}

export function PluginPanel({ load, close, initialQuery = '' }: { load: () => readonly PluginRow[]; close: () => void; initialQuery?: string }): ReactElement {
  const [epoch, setEpoch] = useState(0)
  const [query, setQuery] = useState(initialQuery)
  const [cursor, setCursor] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const rows = useMemo(() => load().filter(row => `${row.entryId} ${row.moduleName} ${row.phase ?? ''}`.toLowerCase().includes(query.toLowerCase())), [epoch, query])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, rows.length - 1))), [rows.length])
  useInput((input, key) => {
    if (key.escape) return close()
    // q closes only while the query is empty; mid-filter it is query text.
    if (input === 'q' && query === '') return close()
    if (input === 'r' && query === '') return setEpoch(value => value + 1)
    if (key.upArrow) return setCursor(value => rows.length === 0 ? 0 : (value + rows.length - 1) % rows.length)
    if (key.downArrow) return setCursor(value => rows.length === 0 ? 0 : (value + 1) % rows.length)
    if (key.return) return setExpanded(value => !value)
    const next = editQuery(query, input, key)
    if (next !== undefined) { setQuery(next); setCursor(0) }
  })
  return createElement(ListFrame, {
    title: t('panel.plugin.title'),
    rows: rows.map((row, index) => ({
      key: row.entryId,
      disabled: !row.enabled,
      text: `${row.enabled ? '●' : '○'} ${row.entryId} · ${row.phase ?? 'not mounted'}${expanded && index === cursor ? ` · ${row.moduleName}` : ''}`,
    })), cursor, loading: false, query, footer: t('panel.footer.inspectDetails'),
  })
}

/** One background job snapshot for the /jobs panel (the registry's read-only view). */
export interface JobRow {
  /** The registry-issued id (`<kind>-N`). */
  readonly id: string
  /** Producer kind (bash, subagent, …). */
  readonly kind: string
  /** One-line model-facing label (the command; the delegation description). */
  readonly label: string
  /** Lifecycle state. */
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Kind-specific status detail once the producer supplied one. */
  readonly detail?: string
  /** Epoch ms when the job was registered. */
  readonly startedAt: number
  /** Epoch ms when the job settled; absent while running/stopping. */
  readonly finishedAt?: number
}

/** Web TurnStatus elapsed format: `45s` under a minute, `2m03s` beyond. */
export function runClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

/** Status glyph per job lifecycle state. */
const JOB_MARK: Record<JobRow['status'], string> = {
  running: '●',
  stopping: '⏸',
  completed: '✓',
  killed: '⊘',
  failed: '✗',
}

/**
 * The read-only background-job panel: caller-owned and unowned jobs from the
 * host `jobs` registry in registration order, with a local second-hand while
 * the panel is open (elapsed clocks advance and the snapshot re-reads; the
 * interval dies with the panel). Cancel stays upstream-only; an absent
 * registry renders as the plain empty state (a harmless missing service).
 */
export function JobsPanel({ load, close }: { load: () => readonly JobRow[]; close: () => void }): ReactElement {
  const [, setRefresh] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(value => value + 1), 1_000)
    return () => clearInterval(id)
  }, [])
  const rows = load()
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (input === 'r') return setRefresh(value => value + 1)
    if (key.upArrow) return setCursor(value => rows.length === 0 ? 0 : (value + rows.length - 1) % rows.length)
    if (key.downArrow) return setCursor(value => rows.length === 0 ? 0 : (value + 1) % rows.length)
  })
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, rows.length - 1))), [rows.length])
  return createElement(ListFrame, {
    title: t('panel.jobs.title', { count: rows.length }),
    rows: rows.map(row => ({
      key: row.id,
      text: `${JOB_MARK[row.status]} ${row.id} · ${singleLineText(row.label)} · ${runClock((row.finishedAt ?? Date.now()) - row.startedAt)}${row.detail === undefined ? '' : ` · ${singleLineText(row.detail)}`}`,
    })),
    cursor, loading: false, query: '', searching: false, footer: t('panel.footer.inspectRefresh'),
  })
}

export function ResumePanel({ currentCwd, load, readTranscript, select, requestDelete, deleteConfirmId, reloadToken = 0, deleteMode = false, close }: {
  currentCwd: string
  load: (options: SessionDirectoryOptions, signal?: AbortSignal) => Promise<readonly SessionRow[]>
  readTranscript: (id: string, signal?: AbortSignal) => Promise<string>
  select: (row: SessionRow) => void
  /** Arm the composer-based delete confirm for one row (App owns the keys). */
  requestDelete?: (row: SessionRow) => void
  /** The row id awaiting y/n in the composer, when any (App-owned). */
  deleteConfirmId?: string
  /** Bump to reload the listing (e.g. after a deletion). */
  reloadToken?: number
  /** Opened via /delete: hint-first delete mode. */
  deleteMode?: boolean
  close: () => void
}): ReactElement {
  // Codex resume-picker default: the CURRENT directory's root sessions; the
  // cwd filter widens to all only on request (the old default leaked every
  // directory's sessions into what read as a current-directory view).
  const [options, setOptions] = useState<SessionDirectoryOptions>({ sessions: 'roots', cwd: 'current', sort: 'newest', currentCwd, query: '' })
  const [focus, setFocus] = useState(0)
  const [density, setDensity] = useState<'comfortable' | 'dense'>('comfortable')
  const [rows, setRows] = useState<readonly SessionRow[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [expanded, setExpanded] = useState<string>()
  const [transcript, setTranscript] = useState<{ id: string; text?: string; error?: string }>()
  /** Ctrl+F-gated search: typing filters only while searching (codex). */
  const [searching, setSearching] = useState(false)
  /** Reference clock pinned per row render, so relative times never drift mid-list. */
  const now = useMemo(() => Date.now(), [rows, options])
  const transcriptLoad = useRef<AbortController>()
  useEffect(() => () => transcriptLoad.current?.abort(), [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError(undefined)
    Promise.resolve().then(() => load(options, controller.signal)).then(value => {
      if (!controller.signal.aborted) { setRows(value); setLoading(false) }
    }, reason => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false) }
    })
    return () => controller.abort()
  }, [options, reloadToken])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, rows.length - 1))), [rows.length])
  const cycle = (): void => {
    if (focus === 3) {
      setDensity(current => current === 'comfortable' ? 'dense' : 'comfortable')
      return
    }
    setOptions(value => {
      if (focus === 0) return { ...value, sessions: value.sessions === 'roots' ? 'all' : 'roots' }
      if (focus === 1) return { ...value, cwd: value.cwd === 'all' ? 'current' : 'all' }
      return { ...value, sort: value.sort === 'newest' ? 'oldest' : 'newest' }
    })
  }
  useInput((input, key) => {
    // While a deletion awaits y/n, the COMPOSER owns every key (App routes
    // them); the panel yields so y/n cannot be handled twice.
    if (deleteConfirmId !== undefined) return
    if (key.escape) {
      if (searching) { setSearching(false); return }
      return close()
    }
    if (isSearchToggle(input, key)) { setSearching(current => !current); return }
    if (searching) {
      if (key.return) { setSearching(false); return }
      const next = editQuery(options.query, input, key)
      if (next !== undefined) { setOptions(value => ({ ...value, query: next })); setCursor(0) }
      return
    }
    if (input === 'q') return close()
    if (key.tab) return setFocus(value => (value + (key.shift ? 3 : 1)) % 4)
    if (key.leftArrow) return cycle()
    if (key.rightArrow) return cycle()
    if (key.upArrow) return setCursor(value => rows.length === 0 ? 0 : Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => rows.length === 0 ? 0 : Math.min(rows.length - 1, value + 1))
    if (key.pageUp) return setCursor(value => Math.max(0, value - 8))
    if (key.pageDown) return setCursor(value => Math.min(rows.length - 1, value + 8))
    if (input === 'g') return setCursor(0)
    if (input === 'G') return setCursor(Math.max(0, rows.length - 1))
    if (input === 'd' && rows[cursor] !== undefined && requestDelete !== undefined) return requestDelete(rows[cursor])
    if (input === 'e' && rows[cursor] !== undefined) {
      return setExpanded(value => value === rows[cursor].id ? undefined : rows[cursor].id)
    }
    if (input === 't' && rows[cursor] !== undefined) {
      const row = rows[cursor]
      transcriptLoad.current?.abort()
      setTranscript({ id: row.id })
      const controller = new AbortController()
      transcriptLoad.current = controller
      Promise.resolve().then(() => readTranscript(row.id, controller.signal)).then(
        text => { if (!controller.signal.aborted) setTranscript({ id: row.id, text }) },
        reason => { if (!controller.signal.aborted) setTranscript({ id: row.id, error: reason instanceof Error ? reason.message : String(reason) }) },
      )
      return
    }
    if (key.return && rows[cursor]?.resumable === true) return select(rows[cursor])
  }, { isActive: transcript === undefined })
  if (transcript !== undefined) {
    return createElement(DocumentPanel, {
      title: t('panel.document.title', { id: transcript.id }),
      text: transcript.text,
      error: transcript.error,
      close: () => { transcriptLoad.current?.abort(); setTranscript(undefined) },
    })
  }
  const pendingRow = deleteConfirmId === undefined ? undefined : rows.find(row => row.id === deleteConfirmId)
  const toolbar = `[${focus === 0 ? '>' : ''}${options.sessions}] [${focus === 1 ? '>' : ''}${options.cwd} cwd] [${focus === 2 ? '>' : ''}${options.sort}] [${focus === 3 ? '>' : ''}${density}]`
  return createElement(ListFrame, {
    title: deleteConfirmId === undefined
      ? `/resume${deleteMode ? ' — delete mode' : ''}${searching ? ' — searching' : ''} · ${toolbar}`
      : `permanently delete ${pendingRow === undefined ? deleteConfirmId.slice(-12) : pendingRow.title ?? pendingRow.id}? this cannot be undone · subagent threads go too`,
    rows: rows.map(row => ({
      key: row.id,
      disabled: !row.resumable,
      text: `${row.subagent ? '↳' : '○'} ${row.title ?? row.id.slice(-12)}${density === 'comfortable' ? ` · ${formatRelativeTime(row.updatedAt ?? row.createdAt, now)} · ${row.workspace} · ${row.preset}` : ''}${row.live ? ' · live' : ''}${expanded === row.id ? ` · ${row.id} · ${row.cwd}${row.parent === undefined ? '' : ` · parent ${row.parent}`}` : ''}`,
    })), cursor, loading, error, query: options.query, searching,
    footer: t('panel.footer.resume'),
  })
}

function documentStyleProps(style: LineStyle): { color?: string; bold?: boolean; italic?: boolean; strikethrough?: boolean } {
  switch (style) {
    case 'accent':
      return { color: inkColor(getPalette().brandBright) }
    case 'accentBold':
      return { color: inkColor(getPalette().brandBright), bold: true }
    case 'code':
      return { color: inkColor(getPalette().code) }
    case 'dim':
      return { color: inkColor(getPalette().dim) }
    case 'bold':
      return { bold: true }
    case 'italic':
      return { italic: true }
    case 'boldItalic':
      return { bold: true, italic: true }
    case 'strike':
      return { color: inkColor(getPalette().dim), strikethrough: true }
    default:
      return {}
  }
}

function DocumentRows({ lines }: { lines: readonly StyledLine[] }): ReactElement {
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, index) => createElement(
      Text,
      { key: index, wrap: 'truncate-end' },
      line.segments.length === 0
        ? ' '
        : line.segments.map((segment, at) => createElement(Text, { key: at, ...documentStyleProps(segment.style) }, segment.text)),
    )),
  )
}

function DocumentPanel({ title, text, error, close }: {
  title: string
  text?: string
  error?: string
  close: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const lines = useMemo(() => text === undefined ? [] : markdownLines(text, viewport.contentColumns), [text, viewport.contentColumns])
  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 't') return close()
    if (key.upArrow) return setScroll(value => Math.max(0, value - 1))
    if (key.downArrow) return setScroll(value => Math.min(Math.max(0, lines.length - viewport.bodyRows), value + 1))
    if (key.pageUp) return setScroll(value => Math.max(0, value - Math.max(1, viewport.bodyRows - 1)))
    if (key.pageDown) return setScroll(value => Math.min(Math.max(0, lines.length - viewport.bodyRows), value + Math.max(1, viewport.bodyRows - 1)))
    if (input === 'g') return setScroll(0)
    if (input === 'G') return setScroll(Math.max(0, lines.length - viewport.bodyRows))
  })
  if (viewport.compact) return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('document.compact'), viewport.contentColumns))
  const body: readonly StyledLine[] = error !== undefined
    ? textLines(`error: ${singleLineText(error)}`, viewport.contentColumns, 'error')
    : text === undefined
      ? textLines(t('document.loading'), viewport.contentColumns, 'dim')
      : lines.slice(scroll, scroll + viewport.bodyRows)
  const accent = panelAccent('kernel-transcript', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(singleLineText(title), viewport.contentColumns)),
    createElement(DocumentRows, { lines: body }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('document.footer', { from: lines.length === 0 ? 0 : scroll + 1, to: Math.min(lines.length, scroll + viewport.bodyRows), total: lines.length }), viewport.contentColumns)),
  )
}

/**
 * The /history recall panel (Codex composer-history search, bounded): one
 * query line over the newest-first recall space, filtered by substring, with
 * arrow selection and enter to fill the composer. Editing the query restarts
 * from the newest match; Esc closes without touching the draft.
 */
export function HistoryPanel({ entries, fill, close }: {
  /** Newest-first recall entries (persistent + in-session, deduped). */
  entries: readonly string[]
  /** Accept one entry: its text plus its recall-space index (browsing resumes there). */
  fill: (text: string, index: number) => void
  close: () => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const matches = query === ''
    ? entries
    : entries.filter(entry => entry.toLowerCase().includes(query.toLowerCase()))
  useInput((input, key) => {
    if (key.escape) return close()
    if (key.return) {
      const entry = matches[cursor]
      if (entry !== undefined) fill(entry, entries.indexOf(entry))
      return
    }
    if (key.upArrow) return setCursor(value => Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => Math.min(matches.length - 1, value + 1))
    // g/G stay vim-style jumps only on an empty query (the /mode contract):
    // mid-filter they are query text, so filters like 'Fix' or 'grep' survive.
    if (input === 'g' && query === '') return setCursor(0)
    if (input === 'G' && query === '') return setCursor(matches.length - 1)
    if (key.backspace || key.delete) {
      setQuery(current => deleteLastGrapheme(current))
      setCursor(0)
      return
    }
    // Ink reports single uppercase letters and shifted symbols ('!', '@')
    // with key.shift set; only ctrl/meta mark real command input.
    if (input !== '' && !key.ctrl && !key.meta) {
      const text = stripPasteMarkers(input)
      if (text !== '') {
        setQuery(current => (current + text).slice(0, 120))
        setCursor(0)
      }
    }
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  if (viewport.maxHeight === 0 || viewport.compact) {
    const picked = matches[cursor]
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`/history · ${picked === undefined ? t('history.compact.none') : singleLineText(picked)} · ${t('panel.close')}`, viewport.contentColumns))
  }
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, cursor, matches.length, bodyRows)
  const visible = matches.slice(offset, offset + bodyRows)
  const header = query === ''
    ? t('history.title.prompts', { count: entries.length })
    : t('history.title.match', { matches: matches.length, count: entries.length, query: truncateColumns(singleLineText(query), Math.max(6, viewport.contentColumns - 34)) })
  const accent = panelAccent('history', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(header, viewport.contentColumns)),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('history.filterHint', { state: query === '' ? t('history.filterEmpty') : t('history.filterQuery', { query: singleLineText(query) }) }), viewport.contentColumns)),
    ...(visible.length === 0
      ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('history.empty'), viewport.contentColumns))]
      : visible.map((entry, index) => {
        const absolute = offset + index
        const selected = absolute === cursor
        return createElement(
          Text,
          {
            key: `history-${absolute}`,
            color: selected ? inkColor(getPalette().brandBright) : undefined,
            wrap: 'truncate-end',
          },
          truncateColumns((selected ? '› ' : '  ') + singleLineText(entry), viewport.contentColumns),
        )
      })),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('history.footer'), viewport.contentColumns)),
  )
}

/**
 * The /review candidate picker (Codex's preset popup): bare /review opens a
 * four-way preset — review uncommitted changes, pick a base branch, pick a
 * recent commit, or type a custom focus. Branch and commit phases are
 * type-to-filter lists; every selection resolves to the same /review
 * argument string the direct command accepts.
 */
export function ReviewPickerPanel({ loadBranches, loadCommits, choose, close }: {
  loadBranches: (signal?: AbortSignal) => Promise<readonly ReviewBranch[]>
  loadCommits: (signal?: AbortSignal) => Promise<readonly ReviewCommit[]>
  /** Run the review for one picker selection. */
  choose: (selection: ReviewSelection) => void
  close: () => void
}): ReactElement {
  const [phase, setPhase] = useState<'preset' | 'branches' | 'commits' | 'custom'>('preset')
  const [cursor, setCursor] = useState(0)
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<readonly (ReviewBranch | ReviewCommit)[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const loadRef = useRef<AbortController>()
  const now = useMemo(() => Date.now(), [rows])

  useEffect(() => {
    if (phase !== 'branches' && phase !== 'commits') return undefined
    loadRef.current?.abort()
    const controller = new AbortController()
    loadRef.current = controller
    setLoading(true)
    setError(undefined)
    const load = phase === 'branches'
      ? (signal?: AbortSignal) => loadBranches(signal) as Promise<readonly (ReviewBranch | ReviewCommit)[]>
      : (signal?: AbortSignal) => loadCommits(signal) as Promise<readonly (ReviewBranch | ReviewCommit)[]>
    void Promise.resolve().then(() => load(controller.signal)).then(list => {
      if (controller.signal.aborted) return
      setLoading(false)
      setRows(list)
      setCursor(0)
    }, reason => {
      if (controller.signal.aborted) return
      setLoading(false)
      setRows([])
      setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const filtered = useMemo(() => {
    if (phase !== 'branches' && phase !== 'commits') return []
    const needle = query.toLowerCase()
    if (needle === '') return rows
    return rows.filter(row => {
      const hay = 'name' in row ? row.name : `${row.sha} ${row.title}`
      return hay.toLowerCase().includes(needle)
    })
  }, [phase, rows, query])

  const submit = (selection: ReviewSelection): void => {
    choose(selection)
  }

  useInput((input, key) => {
    if (key.escape || (input === 'q' && query === '' && phase !== 'custom')) {
      if (phase !== 'preset') {
        setPhase('preset')
        setQuery('')
        setCursor(0)
        return
      }
      return close()
    }
    if (key.ctrl && input === 'c') return close()
    if (phase === 'custom' || ((phase === 'branches' || phase === 'commits') && query !== '')) {
      const next = editQuery(query, input, key)
      if (next !== undefined) {
        setQuery(next)
        setCursor(0)
        return
      }
    }
    // The row budget per phase: the preset list is fixed at four rows, the
    // branch/commit lists clamp to their filtered length.
    const rowCount = phase === 'preset' ? 4 : filtered.length
    if (key.upArrow) return setCursor(value => Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => Math.min(Math.max(0, rowCount - 1), value + 1))
    if (key.return) {
      if (phase === 'preset') {
        if (cursor === 0) return submit({ kind: 'uncommitted' })
        if (cursor === 1) return setPhase('branches')
        if (cursor === 2) return setPhase('commits')
        return setPhase('custom')
      }
      if (phase === 'branches' || phase === 'commits') {
        const row = filtered[cursor]
        if (row !== undefined) submit('name' in row ? { kind: 'base-branch', branch: row.name } : { kind: 'commit', sha: row.sha })
        return
      }
      if (query.trim() !== '') submit({ kind: 'custom', instructions: query.trim() })
      return
    }
  })

  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  if (viewport.maxHeight === 0 || viewport.compact) {
    const state = phase === 'preset' ? 'pick a review target' : loading ? 'loading…' : error !== undefined ? `error: ${error}` : `${filtered.length} candidates`
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`/review · ${state} · ${t('panel.close')}`, viewport.contentColumns))
  }
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, cursor, phase === 'preset' ? 4 : filtered.length, bodyRows)
  const header = phase === 'preset'
    ? t('review.picker.title')
    : phase === 'branches'
      ? loading ? t('review.picker.loadingBranches') : error !== undefined ? t('search.compact.error', { message: truncateColumns(singleLineText(error), Math.max(6, viewport.contentColumns - 14)) }) : t('review.picker.branches', { filtered: filtered.length, total: rows.length })
      : phase === 'commits'
        ? loading ? t('review.picker.loadingCommits') : error !== undefined ? t('search.compact.error', { message: truncateColumns(singleLineText(error), Math.max(6, viewport.contentColumns - 14)) }) : t('review.picker.commits', { filtered: filtered.length, total: rows.length })
        : t('review.picker.customHint')
  const accent = panelAccent('review-picker', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(header, viewport.contentColumns)),
    ...(phase === 'preset'
      ? [
        t('review.picker.uncommitted'),
        t('review.picker.branch'),
        t('review.picker.commit'),
        t('review.picker.custom'),
      ].map((label, index) => {
        const absolute = offset + index
        const selected = absolute === cursor
        return createElement(
          Text,
          { key: `preset-${index}`, color: selected ? inkColor(getPalette().brandBright) : undefined, wrap: 'truncate-end' },
          truncateColumns(`${selected ? '› ' : '  '}${label}`, viewport.contentColumns),
        )
      })
      : phase === 'custom'
        ? [createElement(Text, { key: 'custom-input', dimColor: true, wrap: 'truncate-end' }, truncateColumns(`  ${query === '' ? t('review.picker.customHint') : singleLineText(query)}`, viewport.contentColumns))]
        : filtered.length === 0
          ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, truncateColumns(`  ${loading ? t('review.picker.loading') : error !== undefined ? t('review.picker.loadFailed') : query === '' ? t('review.picker.empty') : t('review.picker.noMatch')}`, viewport.contentColumns))]
          : filtered.slice(offset, offset + bodyRows).map((row, index) => {
            const absolute = offset + index
            const selected = absolute === cursor
            const label = 'name' in row ? row.name : `${row.sha.slice(0, 7)} · ${formatRelativeTime(row.at, now)} · ${row.title}`
            return createElement(
              Text,
              { key: `row-${absolute}`, color: selected ? inkColor(getPalette().brandBright) : undefined, wrap: 'truncate-end' },
              truncateColumns(`${selected ? '› ' : '  '}${singleLineText(label)}`, viewport.contentColumns),
            )
          })),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('review.picker.footer'), viewport.contentColumns)),
  )
}

/** One cross-session full-text search hit mapped from the session-query engine. */
export interface SearchRow {
  /** Session id (Enter resumes it through the switch machinery). */
  readonly id: string
  /** Display label: session title or the short id form. */
  readonly label: string
  /** Secondary facts line (workspace · preset markers). */
  readonly detail: string
  /** Bounded plain-text excerpt around the strongest match. */
  readonly snippet: string
  /** Match timestamp (relative labels derive from it). */
  readonly updatedAt: number
  /** Whether the hit is a delegated subagent conversation (not resumable). */
  readonly subagent: boolean
  /** Whether Enter may switch into it. */
  readonly resumable: boolean
}

/**
 * The /search panel: full-text search over every persisted session through
 * the in-process session-query engine (the same corpus the model's
 * session_search tool reads). Type a query, Enter searches, Enter again
 * resumes the hit; the query line edits like every kernel panel.
 */
export function SearchPanel({ load, select, initialQuery = '', close }: {
  load: (query: string, signal?: AbortSignal) => Promise<readonly SearchRow[]>
  select: (row: SearchRow) => void
  initialQuery?: string
  close: () => void
}): ReactElement {
  const [query, setQuery] = useState(initialQuery)
  const [rows, setRows] = useState<readonly SearchRow[]>([])
  const [cursor, setCursor] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [searched, setSearched] = useState('')
  const searchRef = useRef<AbortController>()
  const run = (next: string): void => {
    const trimmed = next.trim()
    if (trimmed === '') return
    searchRef.current?.abort()
    const controller = new AbortController()
    searchRef.current = controller
    setLoading(true)
    setError(undefined)
    void Promise.resolve().then(() => load(trimmed, controller.signal)).then(hits => {
      if (controller.signal.aborted) return
      setLoading(false)
      setRows(hits)
      setCursor(0)
      setSearched(next)
    }, reason => {
      if (controller.signal.aborted) return
      setLoading(false)
      // Stale results must not stay interactive under an error header: a
      // later Enter re-runs the query instead of resuming an old hit.
      setRows([])
      setCursor(0)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  // An /search <query> invocation searches immediately with its argument.
  useEffect(() => {
    if (initialQuery.trim() !== '') run(initialQuery)
    return () => searchRef.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useInput((input, key) => {
    if (key.escape || (input === 'q' && query === '')) return close()
    if (key.ctrl && input === 'c') return close()
    if (key.backspace || key.delete) {
      setQuery(current => deleteLastGrapheme(current))
      setCursor(0)
      return
    }
    const next = editQuery(query, input, key)
    if (next !== undefined) {
      setQuery(next)
      setCursor(0)
      return
    }
    if (key.upArrow) return setCursor(value => Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => Math.min(rows.length - 1, value + 1))
    if (key.return) {
      // A changed query searches; the SAME query re-runs when the previous
      // pass failed or produced nothing (Enter is then the refresh key).
      const stale = error !== undefined || rows.length === 0
      if (query.trim() !== '' && (query.trim() !== searched.trim() || stale)) {
        run(query)
        return
      }
      // Non-resumable hits (subagent conversations) keep the panel open:
      // Enter must not trade the visible results for a rejected switch.
      const row = rows[cursor]
      if (row !== undefined && row.resumable) select(row)
      return
    }
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const now = useMemo(() => Date.now(), [rows, searched])
  if (viewport.maxHeight === 0 || viewport.compact) {
    const state = loading ? 'searching…' : error !== undefined ? `error: ${error}` : rows.length === 0 ? 'no results yet' : `❯ ${rows[cursor]?.label ?? ''}`
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`/search · ${state} · ${t('panel.close')}`, viewport.contentColumns))
  }
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, cursor, rows.length, bodyRows)
  const visible = rows.slice(offset, offset + bodyRows)
  const header = error !== undefined
    ? t('search.compact.error', { message: truncateColumns(singleLineText(error), Math.max(6, viewport.contentColumns - 14)) })
    : loading
      ? t('search.compact.searching')
      : searched === ''
        ? t('search.title.type')
        : rows.length === 1
          ? t('search.title.hits', { count: rows.length, query: truncateColumns(singleLineText(searched), Math.max(6, viewport.contentColumns - 30)) })
          : t('search.title.hitsPlural', { count: rows.length, query: truncateColumns(singleLineText(searched), Math.max(6, viewport.contentColumns - 30)) })
  const accent = panelAccent('search', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(header, viewport.contentColumns)),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('search.hint', { state: query === '' ? t('search.hintEmpty') : singleLineText(query) }), viewport.contentColumns)),
    ...(visible.length === 0
      ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, truncateColumns(searched === '' ? `  ${t('search.empty.idle')}` : `  ${t('search.empty.noHits', { loading: loading ? '…' : '' })}`, viewport.contentColumns))]
      : visible.flatMap((row, index) => {
        const absolute = offset + index
        const selected = absolute === cursor
        return [
          createElement(
            Text,
            {
              key: `search-${absolute}`,
              color: selected ? inkColor(getPalette().brandBright) : undefined,
              dimColor: row.subagent,
              wrap: 'truncate-end',
            },
            truncateColumns(`${selected ? '› ' : '  '}${row.subagent ? '↳ ' : ''}${singleLineText(row.label)} · ${formatRelativeTime(row.updatedAt, now)}${row.detail === '' ? '' : ` · ${row.detail}`}${row.resumable ? '' : ' · read-only'}`, viewport.contentColumns),
          ),
          createElement(
            Text,
            { key: `search-snippet-${absolute}`, dimColor: true, wrap: 'truncate-end' },
            truncateColumns(`  ⎿ ${singleLineText(row.snippet)}`, viewport.contentColumns),
          ),
        ]
      })),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('search.footer'), viewport.contentColumns)),
  )
}

/**
 * The /statusline picker (the Codex setup-view contract): one bounded list
 * of every status item with its enabled mark, arrow reordering, and a
 * live preview — the real status line under the composer updates as you
 * edit, so the panel itself carries no duplicate preview row.
 */
export function StatuslinePanel({ enabled, change, close }: {
  enabled: readonly StatusItemId[]
  change: (items: readonly StatusItemId[]) => void
  close: () => void
}): ReactElement {
  // Working state: the full catalog in display order (enabled entries in
  // their configured positions, disabled ones trailing canonically) plus
  // the enabled set. Persisted shape is the enabled subsequence only.
  const [order, setOrder] = useState<readonly StatusItemId[]>(() => {
    const seen = new Set(enabled)
    return [...enabled, ...STATUS_ITEMS.map(item => item.id).filter(id => !seen.has(id))]
  })
  const [on, setOn] = useState<ReadonlySet<StatusItemId>>(() => new Set(enabled))
  const [cursor, setCursor] = useState(0)
  const commit = (nextOrder: readonly StatusItemId[], nextOn: ReadonlySet<StatusItemId>): void => {
    setOrder(nextOrder)
    setOn(nextOn)
    change(nextOrder.filter(id => nextOn.has(id)))
  }
  const move = (offset: number): void => {
    const target = cursor + offset
    if (target < 0 || target >= order.length) return
    const next = [...order]
    const [item] = next.splice(cursor, 1)
    next.splice(target, 0, item)
    commit(next, on)
    setCursor(target)
  }
  useInput((input, key) => {
    if (key.escape || input === 'q' || key.return) return close()
    if (key.upArrow) return setCursor(value => Math.max(0, value - 1))
    if (key.downArrow) return setCursor(value => Math.min(order.length - 1, value + 1))
    if (key.leftArrow) return move(-1)
    if (key.rightArrow) return move(1)
    if (input === 'g') return setCursor(0)
    if (input === 'G') return setCursor(order.length - 1)
    if (input === 'd') {
      commit([...DEFAULT_STATUSLINE_ITEMS], new Set(DEFAULT_STATUSLINE_ITEMS))
      setCursor(0)
      return
    }
    if (input === ' ') {
      const item = order[cursor]
      if (item === undefined) return
      const next = new Set(on)
      if (next.has(item)) next.delete(item)
      else next.add(item)
      commit(order, next)
    }
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.statusline.compact'), viewport.contentColumns))
  }
  const bodyRows = Math.max(1, viewport.bodyRows - 1)
  const offset = revealRow(0, cursor, order.length, bodyRows)
  const visible = order.slice(offset, offset + bodyRows)
  const meta = new Map(STATUS_ITEMS.map(item => [item.id, item]))
  const accent = panelAccent('statusline', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(t('statusline.title'), viewport.contentColumns)),
    ...visible.map((id, index) => {
      const absolute = offset + index
      const selected = absolute === cursor
      const info = meta.get(id)
      return createElement(
        Text,
        {
          key: id,
          color: selected ? inkColor(getPalette().brandBright) : undefined,
          dimColor: !on.has(id) || undefined,
          wrap: 'truncate-end',
        },
        truncateColumns((selected ? '› ' : '  ') + (on.has(id) ? '● ' : '○ ') + (info?.label ?? id) + (info === undefined ? '' : ' · ' + info.description + ' · ' + info.side), viewport.contentColumns),
      )
    }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('panel.footer.statusline'), viewport.contentColumns)),
  )
}

/**
 * The `/model` reasoning-effort stage (the Codex model → reasoning popup
 * contract): one bounded list over the selected model's adapter-advertised
 * effort levels — in the adapter's own display order, ids verbatim (the
 * kernel treats them as opaque and rejects anything else) — with the
 * effective effort and the model default marked. A model WITHOUT an
 * adapter-declared default leads with a "Default" (provider-default) row —
 * the web effort pane's first entry — so the user can clear a picked level
 * back to provider behavior. A model advertising no levels opens the same
 * stage with an explicit empty state (the web pane's "no levels" copy)
 * instead of a bare failure notice. Enter applies one level; Esc returns to
 * the model list without applying.
 */
export function EffortPanel({ row, current, select, back, onExit }: {
  /** The model row whose advertised levels this stage lists. */
  row: ModelRow
  /** Effective effort currently in force ('' when none), for the ● mark. */
  current: string | undefined
  /** Accept one advertised effort id, or '' for the provider default. */
  select: (effortId: string) => void
  /** Return to the model list without applying. */
  back: () => void
  /** Leave the whole /model flow (Ctrl+C). */
  onExit: () => void
}): ReactElement {
  const advertised = row.reasoning?.efforts ?? []
  const empty = row.reasoning === undefined || advertised.length === 0
  // The provider-default row only exists when the adapter declares no default
  // effort: with one, the default is an advertised level already in the list.
  const hasDefaultRow = row.reasoning !== undefined && row.reasoning.defaultEffort === undefined
  const rows = empty
    ? [{ id: '', name: '' }]
    : hasDefaultRow
      ? [{ id: '', name: 'Default' }, ...advertised]
      : advertised
  // An absent or cleared effort is the Default row's current state.
  const effective = current === undefined || current === '' ? '' : current
  // The list opens ON the effective level (or the model's default row), so a
  // quick re-pick never restarts the cursor from the top.
  const wanted = effective === '' ? row.reasoning?.defaultEffort ?? '' : effective
  const initialCursor = Math.max(0, rows.findIndex(effort => effort.id === wanted))
  const [cursor, setCursor] = useState(initialCursor)
  useEffect(() => {
    if (rows.length === 0) {
      if (cursor !== 0) setCursor(0)
      return
    }
    if (cursor >= rows.length) setCursor(rows.length - 1)
  }, [rows.length, cursor])
  useInput((input, key) => {
    if (key.escape || input === 'q') return back()
    if (key.ctrl && input === 'c') return onExit()
    if (empty) return
    if (input === 'g') {
      setCursor(0)
      return
    }
    if (input === 'G') {
      setCursor(rows.length - 1)
      return
    }
    if (key.upArrow) {
      setCursor(cursor > 0 ? cursor - 1 : rows.length - 1)
      return
    }
    if (key.downArrow) {
      setCursor(cursor < rows.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.return && rows[cursor] !== undefined) {
      select(rows[cursor].id)
    }
  })
  return createElement(ListFrame, {
    title: t('panel.effort.title', { provider: row.providerName, model: row.modelName }),
    rows: empty
      ? [{ key: 'empty', disabled: true, text: t('panel.effort.empty') }]
      : rows.map(effort => ({
        key: effort.id,
        text: `${effort.id === effective ? '●' : '○'} ${effort.name}${effort.id === row.reasoning?.defaultEffort ? ` · ${t('panel.default')}` : ''}${effort.description === undefined ? '' : ` · ${effort.description}`}`,
      })),
    cursor,
    loading: false,
    query: '',
    footer: empty ? t('panel.footer.effortEmpty') : t('panel.footer.effort'),
  })
}

/** One merged /agents row: live feed state or a persisted child session. */
interface AgentsEntry {
  readonly id: string
  readonly label: string
  readonly activity: string
  readonly running: boolean
  readonly done: boolean
  readonly live: boolean
}

/**
 * The /agents panel (the Codex agent-picker contract, read-only): this
 * conversation's subagent conversations — live rows from the activity feed
 * first, persisted children the feed has not seen this process after — with
 * Enter/t opening the child's full transcript in the shared read-only
 * document view (the same projection the exporter uses).
 */
export function AgentsPanel({ live, load, readTranscript, close }: {
  /** Live feed rows (child sessions observed this process). */
  live: readonly SubagentRow[]
  /** Load this session's persisted child sessions by lineage. */
  load: () => Promise<readonly SessionRow[]>
  /** Read one child session's full transcript as markdown. */
  readTranscript: (id: string, signal?: AbortSignal) => Promise<string>
  close: () => void
}): ReactElement {
  const [dirRows, setDirRows] = useState<readonly SessionRow[] | undefined>(undefined)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState(0)
  const [transcript, setTranscript] = useState<{ id: string; text?: string; error?: string }>()
  const transcriptLoad = useRef<AbortController>()
  useEffect(() => () => transcriptLoad.current?.abort(), [])
  const refresh = (): void => {
    setLoading(true)
    setError(undefined)
    Promise.resolve().then(load).then(value => {
      setDirRows(value)
      setLoading(false)
    }, reason => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
  }
  useEffect(refresh, [])
  // Live feed rows first (they carry the running state), then persisted
  // children only the directory knows — settled subagents from earlier turns.
  const rows = useMemo<readonly AgentsEntry[]>(() => {
    const seen = new Set(live.map(row => row.id))
    const feedRows: AgentsEntry[] = live.map(row => ({
      id: row.id,
      label: row.label,
      activity: row.activity,
      running: row.state === 'running',
      done: row.state === 'done',
      live: true,
    }))
    const persisted: AgentsEntry[] = (dirRows ?? [])
      .filter(row => !seen.has(row.id))
      .map(row => ({
        id: row.id,
        label: row.title ?? row.id.slice(-12),
        activity: row.workspace,
        running: false,
        done: !row.live,
        live: row.live,
      }))
    return [...feedRows, ...persisted]
  }, [live, dirRows])
  useEffect(() => setCursor(value => Math.min(value, Math.max(0, rows.length - 1))), [rows.length])
  const openTranscript = (): void => {
    const row = rows[cursor]
    if (row === undefined) return
    transcriptLoad.current?.abort()
    setTranscript({ id: row.id })
    const controller = new AbortController()
    transcriptLoad.current = controller
    Promise.resolve().then(() => readTranscript(row.id, controller.signal)).then(
      text => {
        if (!controller.signal.aborted) setTranscript({ id: row.id, text })
      },
      reason => {
        if (!controller.signal.aborted) setTranscript({ id: row.id, error: reason instanceof Error ? reason.message : String(reason) })
      },
    )
  }
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (input === 'r') return refresh()
    if (key.upArrow) return setCursor(value => rows.length === 0 ? 0 : (value + rows.length - 1) % rows.length)
    if (key.downArrow) return setCursor(value => rows.length === 0 ? 0 : (value + 1) % rows.length)
    if ((key.return || input === 't') && rows[cursor] !== undefined) return openTranscript()
  }, { isActive: transcript === undefined })
  if (transcript !== undefined) {
    return createElement(DocumentPanel, {
      title: t('panel.subagent.transcriptTitle', { id: transcript.id.slice(-12) }),
      text: transcript.text,
      error: transcript.error,
      close: () => {
        transcriptLoad.current?.abort()
        setTranscript(undefined)
      },
    })
  }
  return createElement(ListFrame, {
    title: t('panel.agents.title', { live: live.length, total: rows.length }),
    rows: rows.map(row => ({
      key: row.id,
      text: `${row.running ? '●' : row.done ? '✓' : row.live ? '⏸' : '○'} ${row.label} · ${row.activity}${row.live ? ' · live' : ''}`,
    })),
    cursor,
    loading,
    ...error === undefined ? {} : { error },
    query: '',
    footer: t('panel.footer.agents'),
  })
}

/**
 * The /subagent model panel: which model configuration delegated subagents
 * run on. The kernel seeds child agents from the parent's CREATE-TIME
 * AgentOptions, so a mid-session /model switch would otherwise leave them on
 * the launch-time route; the TUI mirrors the selection onto subagent-origin
 * requests (or an explicit override picked here) via an agent/request
 * listener. The leading "inherit" row restores follow-the-current-model
 * behavior; picking a model with several advertised efforts opens the same
 * effort stage /model uses. Effort overrides are not offered separately —
 * the kernel's AgentOptions has no effort channel for children, so the level
 * rides the selected model exactly as /model applies it.
 */
export function SubagentPanel({ current, load, pick, inherit, close }: {
  /** Display label of the override in force, '' when following the current model. */
  current: string
  load: () => Promise<ModelDirectory>
  /** Apply one model (with an advertised effort, when picked) as the override. */
  pick: (row: ModelRow, effortId?: string) => void
  /** Drop the override: subagents follow the current model again. */
  inherit: () => void
  close: () => void
}): ReactElement {
  const [directory, setDirectory] = useState<ModelDirectory | undefined>(undefined)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [cursor, setCursor] = useState(0)
  const [effortFor, setEffortFor] = useState<ModelRow | undefined>(undefined)
  const refresh = (): void => {
    setLoading(true)
    setError(undefined)
    Promise.resolve().then(load).then(value => {
      setDirectory(value)
      setLoading(false)
    }, reason => {
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
  }
  useEffect(refresh, [])
  const rows = useMemo(() => directory?.rows ?? [], [directory])
  // The list opens on the override's own row (index 0 is the inherit row).
  useEffect(() => {
    if (current === '' || rows.length === 0) return
    const index = rows.findIndex(row => current.startsWith(`${row.provider}/${row.model}`))
    if (index >= 0) setCursor(index + 1)
  }, [rows, current])
  useEffect(() => setCursor(value => Math.min(value, rows.length)), [rows.length])
  // Hooks stay unconditional: the effort stage below swaps the rendered
  // subtree but must never skip the input hook (an early return here would
  // change the hook count when the stage opens and closes).
  useInput((input, key) => {
    if (effortFor !== undefined) return
    if (key.escape || input === 'q') return close()
    if (input === 'r' && !loading) return refresh()
    if (key.upArrow) return setCursor(value => (value + rows.length) % (rows.length + 1))
    if (key.downArrow) return setCursor(value => (value + 1) % (rows.length + 1))
    if (key.return) {
      if (cursor === 0) return inherit()
      const row = rows[cursor - 1]
      if (row === undefined) return
      if (row.reasoning !== undefined && row.reasoning.efforts.length > 1) {
        setEffortFor(row)
        return
      }
      const effortId = row.reasoning?.efforts.length === 1 ? row.reasoning.efforts[0].id : undefined
      pick(row, effortId)
    }
  })
  if (effortFor !== undefined) {
    return createElement(EffortPanel, {
      row: effortFor,
      current: current === '' ? undefined : current.split('@')[1],
      select: effortId => pick(effortFor, effortId),
      back: () => setEffortFor(undefined),
      onExit: close,
    })
  }
  return createElement(ListFrame, {
    title: `${t('panel.subagent.title')}${current === '' ? '' : t('panel.subagent.override', { value: current })}`,
    rows: [
      { key: '__inherit__', text: `${current === '' ? '●' : '○'} ${t('panel.subagent.inherit')}` },
      ...rows.map(row => ({
        key: `${row.provider}/${row.model}`,
        text: `${current.startsWith(`${row.provider}/${row.model}`) ? '●' : '○'} ${row.providerName} · ${row.modelName}`,
      })),
    ],
    cursor,
    loading,
    ...error === undefined ? {} : { error },
    query: '',
    footer: t('panel.footer.subagent'),
  })
}

/**
 * The /schedule panel: the read-only catalog of active reminders folded from
 * durable schedule/change events (the web ui-schedule contract: overdue
 * first, then ascending target; the model creates and cancels through its
 * schedule_* tools, the panel only shows state). A local second-hand keeps
 * the relative labels live while the panel is open.
 */
export interface ScheduleDisplayRow {
  readonly key: string
  readonly text: string
  readonly tone?: 'error'
}

/** Human frequency label: one-shot kinds read as Once, every rows carry the interval. */
export function scheduleFrequency(row: ScheduleRow): string {
  if (row.kind !== 'every') return 'Once'
  const seconds = row.everySeconds ?? 0
  if (seconds >= 3600 && seconds % 3600 === 0) return `Every ${seconds / 3600}h`
  if (seconds >= 60 && seconds % 60 === 0) return `Every ${seconds / 60}m`
  return `Every ${seconds}s`
}

/** Relative label for the next target: in N unit, or N unit overdue. */
export function scheduleRelative(targetAt: number, now: number): string {
  const delta = Math.max(0, Math.abs(targetAt - now))
  const minutes = Math.floor(delta / 60_000)
  const unit = minutes === 0
    ? '<1m'
    : minutes >= 60
      ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
      : `${minutes}m`
  return targetAt <= now ? `${unit} overdue` : `in ${unit}`
}

/** Ordered display rows: overdue first (error tone), then ascending target. */
export function scheduleDisplayRows(rows: readonly ScheduleRow[], now: number): readonly ScheduleDisplayRow[] {
  return [...rows]
    .sort((left, right) => (Number(left.targetAt > now) - Number(right.targetAt > now)) || (left.targetAt - right.targetAt))
    .map(row => ({
      key: row.id,
      text: `${row.prompt} · ${scheduleFrequency(row)} · ${new Date(row.targetAt).toLocaleString()} (${scheduleRelative(row.targetAt, now)})`,
      tone: row.targetAt <= now ? 'error' as const : undefined,
    }))
}

export function SchedulePanel({ rows, close }: { rows: () => readonly ScheduleRow[]; close: () => void }): ReactElement {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(value => value + 1), 1_000)
    return () => clearInterval(id)
  }, [])
  const display = scheduleDisplayRows(rows(), Date.now())
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
  })
  if (viewport.maxHeight === 0 || viewport.compact) {
    const summary = display.length === 0 ? t('panel.schedule.none') : singleLineText(display[0].text)
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`/schedule · ${summary}`, viewport.contentColumns))
  }
  const budget = Math.max(1, viewport.bodyRows)
  const visible = display.slice(0, budget)
  const hidden = display.length - visible.length
  const accent = panelAccent('schedule', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(display.length === 1 ? t('schedule.title', { count: display.length }) : t('schedule.titlePlural', { count: display.length }), viewport.contentColumns)),
    ...(display.length === 0
      ? [createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(`  ${t('schedule.empty')}`, viewport.contentColumns))]
      : visible.map(row => createElement(Text, {
        key: row.key,
        color: row.tone === 'error' ? inkColor(getPalette().error) : undefined,
        wrap: 'truncate-end',
      }, truncateColumns(`  ${singleLineText(row.text)}`, viewport.contentColumns)))),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('panel.schedule.footer', { more: hidden > 0 ? t('panel.schedule.more', { count: hidden }) : '' }), viewport.contentColumns)),
  )
}

/**
 * The /usage panel: the session's provider-reported token totals, its context
 * pressure and estimated composition, and the exact per-turn accounting, in
 * one bounded scrollable surface. Read-only — Esc or q closes it.
 */
export function UsagePanel({ load, close }: {
  /** Read the current session's usage blocks from the mounted projections. */
  load: () => Promise<UsageView>
  close: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const [view, setView] = useState<UsageView>()
  const [error, setError] = useState<string>()
  // The panel opens on the loading row and swaps in the numbers when the
  // loader settles: materializing the projection units folds the whole log,
  // and that must not run inside the keystroke that opened the panel.
  useEffect(() => {
    let live = true
    Promise.resolve().then(load).then(
      loaded => {
        if (live) setView(loaded)
      },
      reason => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason))
      },
    )
    return () => {
      live = false
    }
  }, [load])
  const lines = useMemo(
    () => view === undefined ? [] : usageLines(view, viewport.contentColumns),
    [view, viewport.contentColumns],
  )
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (key.upArrow) return setScroll(value => Math.max(0, value - 1))
    if (key.downArrow) return setScroll(value => Math.min(Math.max(0, lines.length - viewport.bodyRows), value + 1))
    if (key.pageUp) return setScroll(value => Math.max(0, value - Math.max(1, viewport.bodyRows - 1)))
    if (key.pageDown) return setScroll(value => Math.min(Math.max(0, lines.length - viewport.bodyRows), value + Math.max(1, viewport.bodyRows - 1)))
    if (input === 'g') return setScroll(0)
    if (input === 'G') return setScroll(Math.max(0, lines.length - viewport.bodyRows))
  })
  if (viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.usage.compact'), viewport.contentColumns))
  }
  const body: readonly StyledLine[] = error !== undefined
    ? textLines(`error: ${singleLineText(error)}`, viewport.contentColumns, 'error')
    : view === undefined
      ? textLines(t('panel.loading'), viewport.contentColumns, 'dim')
      : lines.slice(scroll, scroll + viewport.bodyRows)
  const accent = panelAccent('usage', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(t('panel.usage.title'), viewport.contentColumns)),
    createElement(DocumentRows, { lines: body }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('panel.usage.footer'), viewport.contentColumns)),
  )
}
