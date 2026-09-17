/**
 * IME cursor anchoring for the composer.
 *
 * Ink keeps the real terminal cursor hidden and parks it just below the
 * dynamic tree (after the status row). IME composition text and candidate
 * windows anchor to that real cursor cell - VS Code's integrated terminal
 * positions its hidden IME textarea there, and Windows consoles behave the
 * same - so CJK input appeared at the bottom of the screen instead of at the
 * caret. The anchor moves the real cursor onto the caret cell without
 * touching Ink's relative erase ledger:
 *
 * - the displacement is owned: before any foreign write or re-anchor, the
 *   wrapper cancels it (cursor down, column 1), so every writer - Ink's
 *   log-update rewrites, the resize replay, protocol pushes - keeps seeing
 *   the cursor exactly where it was left;
 * - log-update frame chunks (which start with the erase-line sequence) get
 *   the anchor re-appended inside the same write, so a repaint can never
 *   leave the cursor behind - in particular the caret blink keeps the anchor
 *   stable while an IME composition is open, because the terminal parses the
 *   rewrite and the re-anchor as one atomic update.
 *
 * @module @deepseek-ai/dsh-code/render/ime-cursor
 */

import { useEffect, useRef } from 'react'
import { useStdout } from 'ink'

/** Cancel `rows` of owned upward displacement and return to column 1. */
export function imeCursorRestore(rows: number): string {
  return rows > 0 ? `\x1b[${rows}B\r` : ''
}

/** Move onto the caret cell: `rows` up from Ink's parked row, 0-based column. */
export function imeCursorMove(rows: number, column: number): string {
  return rows > 0 ? `\x1b[${rows}A\x1b[${column + 1}G` : ''
}

/**
 * Rows between the caret cell and Ink's parked cursor row: the band's bottom
 * blank row, the editor window rows below the caret, the status footer, and
 * Ink's own below-frame row. Rows above the composer (gutter, live content)
 * never enter this distance.
 */
export function imeCursorRowsUp(input: {
  editorWindowRows: number
  caretRowInWindow: number
  rowsBelowComposer: number
}): number {
  return Math.max(1, input.editorWindowRows - input.caretRowInWindow + input.rowsBelowComposer)
}

/** log-update chunks start with the erase-line sequence; a chunk without it
 * leaves no frame behind, so the next commit re-applies the anchor. */
const FRAME_CHUNK_MARKER = '\x1b[2K'

/** The installed anchor handle. */
export interface ImeCursorAnchor {
  /** Anchor on the caret cell: `rows` above Ink's parked row at the 0-based
   * `column`; `rows <= 0` releases the anchor. */
  anchor(rows: number, column: number): void
  /** Cancel the displacement, restore the original write path, and detach. */
  release(): void
}

const ANCHOR_STATE = Symbol.for('dsh-code.ime-cursor-anchor')

/**
 * Take over `stream.write` so the anchor displacement stays invisible to every
 * other writer. Idempotent per stream: a second install returns the live
 * handle. Returns `undefined` on non-TTY streams where anchoring is meaningless.
 */
export function installImeCursorAnchor(stream: NodeJS.WriteStream): ImeCursorAnchor | undefined {
  if (stream?.isTTY !== true) return undefined
  const target = stream as NodeJS.WriteStream & { [ANCHOR_STATE]?: ImeCursorAnchor | undefined }
  const installed = target[ANCHOR_STATE]
  if (installed !== undefined) return installed
  const originalWrite = target.write.bind(target) as (...args: unknown[]) => unknown
  let rows = 0
  let column = -1
  let detached = false
  const anchor: ImeCursorAnchor = {
    anchor(nextRows, nextColumn) {
      if (detached) return
      if (nextRows <= 0) {
        if (rows !== 0) originalWrite(imeCursorRestore(rows))
        rows = 0
        column = -1
        return
      }
      if (rows === nextRows && column === nextColumn) return
      originalWrite(imeCursorRestore(rows) + imeCursorMove(nextRows, nextColumn))
      rows = nextRows
      column = nextColumn
    },
    release() {
      if (detached) return
      detached = true
      if (rows !== 0) originalWrite(imeCursorRestore(rows))
      rows = 0
      column = -1
      target.write = originalWrite as typeof target.write
      delete target[ANCHOR_STATE]
    },
  }
  target.write = ((chunk: unknown, ...rest: unknown[]) => {
    const ownedRows = rows
    const ownedColumn = column
    if (ownedRows === 0 || typeof chunk !== 'string') {
      if (ownedRows !== 0) {
        originalWrite(imeCursorRestore(ownedRows))
        rows = 0
        column = -1
      }
      return originalWrite(chunk, ...rest)
    }
    const reanchor = chunk.startsWith(FRAME_CHUNK_MARKER)
    rows = reanchor ? ownedRows : 0
    column = reanchor ? ownedColumn : -1
    return originalWrite(imeCursorRestore(ownedRows) + chunk + (reanchor ? imeCursorMove(ownedRows, ownedColumn) : ''), ...rest)
  }) as typeof target.write
  target[ANCHOR_STATE] = anchor
  return anchor
}

/**
 * Keep the real terminal cursor on the composer's caret cell while `active`
 * (the editable composer). The second effect runs after every commit without
 * a dep list: frame rewrites restore the anchor themselves, but any other
 * write (protocol push, resize replay) leaves the cursor at Ink's parked
 * position, and the next commit re-anchors it.
 */
export function useImeCursorAnchor(active: boolean, rows: number, column: number): void {
  const { stdout } = useStdout()
  const anchorRef = useRef<ImeCursorAnchor | undefined>(undefined)
  useEffect(() => {
    if (stdout === undefined) return undefined
    const installed = installImeCursorAnchor(stdout)
    anchorRef.current = installed
    return () => {
      installed?.release()
      if (anchorRef.current === installed) anchorRef.current = undefined
    }
  }, [stdout])
  useEffect(() => {
    anchorRef.current?.anchor(active && rows > 0 ? rows : 0, column)
  })
}
