/**
 * Injectable process-facing effects for the TUI runner. Tests substitute the
 * Ink mount with a capturing fake and the streams with string sinks, keeping
 * the runner's lifecycle testable without a terminal.
 *
 * @module @deepseek-ai/dsh-tui/internals
 */

import { render } from 'ink'
import type { ReactElement } from 'react'
import {
  BRACKETED_PASTE_DISABLE,
  BRACKETED_PASTE_ENABLE,
  KEYBOARD_ENHANCE_DISABLE,
  KEYBOARD_ENHANCE_ENABLE,
  TERMINAL_FOCUS_REPORT_DISABLE,
  TERMINAL_FOCUS_REPORT_ENABLE,
  isVsCodeTerminalEnv,
  shouldEnableKeyboardEnhancement,
} from './keyboard.ts'
import { createSplitStdin } from './input-split.ts'
import { ensureVsCodeTabTitleSetting } from './terminal-title.ts'

/** A mounted terminal app instance; the runner owns unmount ordering. */
export interface TuiMount {
  /** Replace the root element while preserving Ink's single terminal owner. */
  rerender(element: ReactElement): void
  /** Tear the terminal app down before flush and exit. */
  unmount(): void
}

/** The Ink mount seam: renders the app element and returns its handle. */
export type Mount = (element: ReactElement) => TuiMount

/** Substitutable runner effects; production values write to the real terminal. */
export const internals: {
  /** Ink renderer mount; tests substitute a fake that captures the element. */
  mount: Mount
  /** Diagnostics stream for direct-driver failures. */
  stderr: { write(chunk: string): unknown }
} = {
  mount: (element: ReactElement): TuiMount => {
    // VS Code's integrated terminal can route Tab to the workbench when Kitty
    // enhancement is enabled. Keep bracketed paste everywhere, but only push
    // the keyboard protocol on terminals that can safely own those key events.
    const keyboardEnhanced = shouldEnableKeyboardEnhancement()
    const focusReporting = isVsCodeTerminalEnv()
    // Enter raw mode BEFORE pushing any protocol: xterm.js answers `?1004h`
    // with an immediate focus report (ESC[I), and while the tty still carries
    // the shell's cooked+ECHO settings that report is echoed to the screen as
    // a literal `^[[I`. Ink only takes raw mode after its first commit, so
    // this mount owns the window; the call is idempotent with Ink's later one.
    if (process.stdin.isTTY === true) process.stdin.setRawMode?.(true)
    try {
      process.stdout.write(
        (keyboardEnhanced ? KEYBOARD_ENHANCE_ENABLE : '')
        + BRACKETED_PASTE_ENABLE
        + (focusReporting ? TERMINAL_FOCUS_REPORT_ENABLE : ''),
      )
      // Cosmetic best effort: inside a VS Code integrated terminal the tab
      // shows the process name ("node") unless the user settings map it to
      // the sequence title; align them once. Total function, never throws.
      ensureVsCodeTabTitleSetting()
      // App owns Ctrl+C's deliberate three-state contract (interrupt, clear
      // draft, quit). Ink's default `exitOnCtrlC: true` would intercept the
      // normalized control byte first, unmount only its renderer, and leave the
      // Harness runner plus the pushed keyboard protocol alive.
      // stdin travels through the keypress splitter: Ink parses one chunk as
      // one keypress, so a coalesced space-then-enter would drop both keys.
      const tuiStdin = createSplitStdin(process.stdin)
      // Ink only touches isTTY/setRawMode/ref/read on stdin; the object-mode
      // proxy satisfies that contract without the full ReadStream surface.
      const instance = render(element, {
        exitOnCtrlC: false,
        stdin: tuiStdin.stdin as unknown as NodeJS.ReadStream,
        stdout: process.stdout,
      })
      return {
        rerender(element: ReactElement): void {
          instance.rerender(element)
        },
        unmount(): void {
          // The cleanup below must run even when Ink's unmount throws (a
          // render-teardown failure): a stdin tap or pushed terminal-protocol
          // stack outliving the app wedges the terminal for whatever runs
          // next, and a stray exception here must not skip the exit sequence.
          // Pop the stack while raw mode still hides echo — xterm.js keeps
          // reporting focus changes until `?1004l` lands, and one arriving
          // after Ink restores the cooked tty would print as `^[[I`.
          try {
            process.stdout.write(
              (keyboardEnhanced ? KEYBOARD_ENHANCE_DISABLE : '')
              + BRACKETED_PASTE_DISABLE
              + (focusReporting ? TERMINAL_FOCUS_REPORT_DISABLE : ''),
            )
          } finally {
            try {
              instance.unmount()
            } finally {
              tuiStdin.dispose()
              // Belt and braces: give the tty back its cooked mode even when
              // Ink never took raw mode over (idempotent at the termios level).
              if (process.stdin.isTTY === true) process.stdin.setRawMode?.(false)
            }
          }
        },
      }
    } catch (error) {
      // The synchronous mount path failed before Ink could own the terminal:
      // undo the raw mode entered above so the shell keeps its echo.
      if (process.stdin.isTTY === true) process.stdin.setRawMode?.(false)
      throw error
    }
  },
  stderr: process.stderr,
}
