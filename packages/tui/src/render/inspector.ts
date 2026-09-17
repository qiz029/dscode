/** Pure viewport, selection, and scrolling rules for exclusive TUI panels. */

/** Terminal-space allocation for the inspector's one dynamic screen. */
export interface InspectorViewport {
  /** Maximum dynamic rows, kept strictly below the terminal height. */
  maxHeight: number
  /** Rows available to the selected entry after border, title, and footer. */
  bodyRows: number
  /** Optional blank rows separating title/body/footer on roomy terminals. */
  gapRows: 0 | 2
  /** Columns available inside the horizontal border and padding. */
  contentColumns: number
  /** Safe outer width for a bordered dynamic panel; never writes column N. */
  outerColumns: number
  /** Tiny terminals use a borderless one-line close hint. */
  compact: boolean
}

/** Composer (3) + two-row status chrome, plus one optional fixed-height local notice row. */
const INSPECTOR_CHROME_ROWS = 6

/** One transcript-to-composer gutter, collapsed on short terminals. */
export function layoutGutterRows(rows: number): 0 | 1 {
  return Math.max(1, Math.floor(rows)) >= 14 ? 1 : 0
}

/** Measured chrome that sits below (or in) the live region. */
export interface LiveRegionChrome {
  /** Terminal rows. */
  readonly terminalRows: number
  /** Editor rows inside the composer band (frozen reports 1). */
  readonly composerRows: number
  /** Status footer rows. */
  readonly statusBarRows: 1 | 2
  /** Completion menu rows (0 when closed). */
  readonly menuRows: number
  /** Transcript-to-composer gutter. */
  readonly gutterRows: 0 | 1
  /** Notice line present. */
  readonly notice: boolean
  /** Todo summary line present. */
  readonly todo: boolean
  /** Agents summary line present. */
  readonly agents: boolean
}

/**
 * Rows left for live transcript and streaming after pinning the composer and
 * status at the bottom. Variable chrome (menu, notice, todos, agents, extra
 * status row, extra editor rows) is deducted here so those rows cover the
 * live region instead of growing the tree and moving the bottom bar.
 */
export function liveRegionBudget(chrome: LiveRegionChrome): number {
  const terminal = Math.max(1, Math.floor(chrome.terminalRows))
  const editor = Math.max(1, Math.floor(chrome.composerRows))
  const band = editor + 2
  const status = chrome.statusBarRows === 2 ? 2 : 1
  const menu = Math.max(0, Math.floor(chrome.menuRows))
  const gutter = chrome.gutterRows
  const notice = chrome.notice ? 1 : 0
  const todo = chrome.todo ? 1 : 0
  const agents = chrome.agents ? 1 : 0
  // Two spare rows: Ink's parked cursor, plus one so the painted tree never
  // reaches stdout.rows (equality takes the full-terminal clear path).
  const inkSpare = 2
  return Math.max(1, terminal - band - status - menu - gutter - notice - todo - agents - inkSpare)
}

/**
 * Keep the inspector plus its persistent status/composer chrome below
 * `stdout.rows`: at equality Ink clears the terminal and rewrites all
 * accumulated `<Static>` output on every frame.
 */
export function panelViewport(columns: number, rows: number): InspectorViewport {
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRows = Math.max(1, Math.floor(rows))
  // Two spare rows cover Ink's first-frame transition from existing Static
  // scrollback into a tall dynamic panel. A one-row margin is insufficient:
  // the transition can still take the full-terminal rewrite path at rows - 1.
  const maxHeight = Math.max(0, Math.min(
    safeRows - 2 - INSPECTOR_CHROME_ROWS - layoutGutterRows(safeRows),
    Math.floor(safeRows / 2),
  ))
  const compact = maxHeight < 5 || safeColumns < 8
  const gapRows = !compact && maxHeight >= 7 ? 2 : 0
  // A terminal may autowrap a glyph written into its final column. Ink still
  // accounts for that border as one logical row, so the next dynamic update
  // erases too few physical rows and leaves stacked frames behind. Codex
  // renders overlays within an inset surface; reserve the final column here
  // so every Ink panel follows the same contract.
  const outerColumns = compact ? safeColumns : Math.max(1, safeColumns - 1)
  return {
    maxHeight,
    bodyRows: compact ? 0 : maxHeight - 4 - gapRows,
    gapRows,
    contentColumns: compact ? Math.max(1, safeColumns - 1) : Math.max(1, outerColumns - 4),
    outerColumns,
    compact,
  }
}

/** Backward-compatible name for the Ctrl+O-specific caller and tests. */
export function inspectorViewport(columns: number, rows: number): InspectorViewport {
  return panelViewport(columns, rows)
}

/** Clamp a first-visible row to the range representable by one viewport. */
export function clampScroll(offset: number, totalRows: number, visibleRows: number): number {
  const total = Math.max(0, Math.floor(totalRows))
  const size = Math.max(0, Math.floor(visibleRows))
  const last = Math.max(0, total - size)
  return Math.max(0, Math.min(Math.floor(offset), last))
}

/** Move a viewport by a signed row delta without escaping its content. */
export function moveScroll(offset: number, delta: number, totalRows: number, visibleRows: number): number {
  return clampScroll(offset + delta, totalRows, visibleRows)
}

/** Keep one focused row visible while preserving the current window when possible. */
export function revealRow(offset: number, row: number, totalRows: number, visibleRows: number): number {
  const size = Math.max(1, Math.floor(visibleRows))
  const target = Math.max(0, Math.min(Math.floor(row), Math.max(0, totalRows - 1)))
  if (target < offset) return clampScroll(target, totalRows, size)
  if (target >= offset + size) return clampScroll(target - size + 1, totalRows, size)
  return clampScroll(offset, totalRows, size)
}

/** Center a selected list row where possible, clamped at both ends. */
export function selectionWindow(cursor: number, totalRows: number, visibleRows: number): number {
  return clampScroll(cursor - Math.floor(Math.max(1, visibleRows) / 2), totalRows, visibleRows)
}

/** Follow appended history only while the inspector cursor was at the tail. */
export function followInspectorCursor(cursor: number, previousLength: number, nextLength: number): number {
  const nextLast = Math.max(0, nextLength - 1)
  if (cursor >= Math.max(0, previousLength - 1)) return nextLast
  return Math.min(cursor, nextLast)
}
