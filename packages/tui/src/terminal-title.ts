/**
 * Terminal tab/window title management for the TUI.
 *
 * Terminals label their tab from the window title, which an application sets
 * with an OSC 0 sequence; without one the tab shows the process name ("node").
 * The title text is untrusted display content (session names arrive through
 * events and user input), so it is sanitized before emission: control
 * characters and bidi/invisible formatting codepoints are stripped, whitespace
 * runs collapse to single spaces, and the result is bounded. Clearing writes
 * an empty OSC payload and the terminal falls back to its own default; the
 * previously set title is not portable to read back and is never restored.
 *
 * @module @deepseek-ai/dsh-code/terminal-title
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { useLayoutEffect, useRef } from 'react'
import { useStdout } from 'ink'

/** The host process title at module load, restored on unmount. On Windows
 * this reaches the tab through SetConsoleTitleW (ConPTY reflects it to VS
 * Code and friends without any user setting); on POSIX it becomes the ps
 * name. Node replaces the argv memory, so the original must be saved before
 * the first assignment. */
const initialProcessTitle = process.title

/** Tab label before a session carries a name. */
export const DEFAULT_TERMINAL_TITLE = 'deepseek'

/** Practical upper bound on title length, in visible characters: long enough
 * for session names, short enough for tab bars and window managers. */
export const MAX_TERMINAL_TITLE_CHARS = 240

/** Control characters, DEL/C1 range, and bidi or invisible formatting
 * codepoints that could terminate the OSC sequence or visually reorder the
 * title relative to its underlying text. */
const DISALLOWED_TITLE_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/

/** Normalize untrusted title text into one bounded display line: disallowed
 * codepoints dropped, whitespace runs collapsed to single spaces, leading and
 * trailing whitespace removed, length bounded. */
export function sanitizeTerminalTitle(text: string): string {
  const chars: string[] = []
  let pendingSpace = false
  for (const ch of text) {
    if (DISALLOWED_TITLE_CHARS.test(ch)) continue
    if (ch.trim() === '') {
      if (chars.length > 0) pendingSpace = true
      continue
    }
    if (pendingSpace) {
      if (chars.length + 1 >= MAX_TERMINAL_TITLE_CHARS) break
      chars.push(' ')
      pendingSpace = false
    }
    if (chars.length >= MAX_TERMINAL_TITLE_CHARS) break
    chars.push(ch)
  }
  return chars.join('')
}

/** Build one OSC 0 title sequence. An empty sanitized title yields an empty
 * string: emitting nothing is distinct from clearing, which is a separate
 * policy decision made by the caller. */
export function terminalTitleSequence(text: string): string {
  const title = sanitizeTerminalTitle(text)
  return title === '' ? '' : `\x1b]0;${title}\x07`
}

/** Clear the managed title with an empty OSC payload; the terminal falls back
 * to its own default label. */
export function clearTerminalTitleSequence(): string {
  return '\x1b]0;\x07'
}

/**
 * Resolve the VS Code stable user-settings file for one platform and
 * environment: `%APPDATA%` on Windows, the bundle data folder on macOS (NOT
 * XDG `~/.config` — VS Code never reads that path there, so writing it
 * silently no-ops and the tab kept showing the process name "node"), and
 * XDG config on Linux.
 */
export function vscodeSettingsPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const windows = platform === 'win32'
  const darwin = platform === 'darwin'
  const base = windows ? env['APPDATA'] : env['HOME']
  if (base === undefined || base === '') return undefined
  return windows
    ? join(base, 'Code', 'User', 'settings.json')
    : darwin
      ? join(base, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
      : join(base, '.config', 'Code', 'User', 'settings.json')
}

/** Outcome of the VS Code settings alignment. */
export interface VsCodeTitleSettingResult {
  wrote: boolean
  reason?: 'not-vscode' | 'unparseable' | 'key-present' | 'error'
}

/** VS Code renders an application-set tab title only when
 * "terminal.integrated.tabs.title" maps to the sequence variable; the editor
 * default shows the process name instead ("node" for a Node CLI). Inside a VS
 * Code integrated terminal, align the user settings once: if the key is
 * absent, insert it and keep a one-shot backup of the original file. A value
 * the user already set is never overwritten, an unparseable file is never
 * touched, and every failure degrades to a no-op - the OSC and process-title
 * channels keep working everywhere else. */
export function ensureVsCodeTabTitleSetting(options: {
  env?: NodeJS.ProcessEnv
  settingsFile?: string
  isTTY?: boolean
} = {}): VsCodeTitleSettingResult {
  const env = options.env ?? process.env
  if (env['TERM_PROGRAM'] !== 'vscode') return { wrote: false, reason: 'not-vscode' }
  if ((options.isTTY ?? process.stdout.isTTY) !== true) return { wrote: false, reason: 'not-vscode' }
  let file = options.settingsFile
  if (file === undefined) {
    const resolved = vscodeSettingsPath(process.platform, env)
    if (resolved === undefined) return { wrote: false, reason: 'error' }
    file = resolved
  }
  try {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '{\n  "terminal.integrated.tabs.title": "${sequence}"\n}\n', 'utf8')
      return { wrote: true }
    }
    const text = readFileSync(file, 'utf8')
    if (text.includes('"terminal.integrated.tabs.title"')) return { wrote: false, reason: 'key-present' }
    try {
      JSON.parse(text)
    } catch {
      return { wrote: false, reason: 'unparseable' }
    }
    const close = text.lastIndexOf('}')
    if (close < 0) return { wrote: false, reason: 'unparseable' }
    const before = text.slice(0, close)
    const trimmedBefore = before.replace(/[ \t\r\n]+$/, '')
    const tail = before.slice(trimmedBefore.length)
    const needsComma = trimmedBefore.trim() !== '' && !trimmedBefore.trimEnd().endsWith('{')
    const inserted = (needsComma ? ',' : '') + '\n    "terminal.integrated.tabs.title": "${sequence}"\n'
    writeFileSync(file + '.dsh-backup', text, 'utf8')
    writeFileSync(file, trimmedBefore + inserted + tail + text.slice(close), 'utf8')
    return { wrote: true }
  } catch {
    return { wrote: false, reason: 'error' }
  }
}

/**
 * Keep the terminal tab label on `title` (sanitized; empty titles leave the
 * current label alone). Two delivery channels run in parallel: the OSC 0
 * sequence to stdout, and the host process title. Writes are deduplicated by
 * title, and on unmount the managed title is cleared and the process title
 * restored so the host shell regains its default label.
 */
export function useTerminalTitle(title: string, options: { clearOnUnmount?: boolean } = {}): void {
  const { clearOnUnmount = true } = options
  const { stdout } = useStdout()
  const writtenRef = useRef<string | undefined>(undefined)
  const processTitleRef = useRef(false)
  // Layout effects: the clear must run synchronously at unmount (passive
  // cleanups are not flushed synchronously when Ink tears the tree down).
  useLayoutEffect(() => {
    if (stdout === undefined) return undefined
    return () => {
      if (processTitleRef.current) {
        processTitleRef.current = false
        process.title = initialProcessTitle
      }
      if (clearOnUnmount && writtenRef.current !== undefined) stdout.write(clearTerminalTitleSequence())
    }
  }, [stdout, clearOnUnmount])
  useLayoutEffect(() => {
    if (stdout === undefined) return
    if (title === writtenRef.current) return
    const sequence = terminalTitleSequence(title)
    if (sequence === '') return
    stdout.write(sequence)
    // The process title is the second delivery channel: on Windows it drives
    // the console title that ConPTY reflects onto the tab without any user
    // setting, where the OSC channel alone only shows once the host maps
    // "terminal.integrated.tabs.title" to the sequence variable.
    process.title = sanitizeTerminalTitle(title)
    processTitleRef.current = true
    writtenRef.current = title
  }, [stdout, title])
}
