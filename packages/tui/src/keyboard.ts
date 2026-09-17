/**
 * Keyboard enhancement protocol (Codex `keyboard_modes` parity) and the
 * kitty CSI-u normalization layer.
 *
 * The TUI pushes the kitty keyboard protocol with DISAMBIGUATE_ESCAPE_CODES
 * and REPORT_ALTERNATE_KEYS (flags 1|4 = `\x1b[>5u`). Event types are
 * deliberately NOT requested: Ink 5's parser cannot decode the
 * `:event-type` suffix, and repeat/release reporting buys this surface
 * nothing.
 *
 * Ink 5 also cannot parse most CSI-u forms at all — they fall through its
 * regex as unnamed sequences and get INSERTED AS DRAFT TEXT. The composer's
 * stdin read patch therefore rewrites every CSI-u form it can decode back
 * to the legacy byte or canonical sequence the existing key handling
 * already understands, before Ink ever parses the chunk.
 * @module @deepseek-ai/dsh-code/keyboard
 */

/** Push keyboard enhancement (modifyOtherKeys off, kitty flags 1|4). */
export const KEYBOARD_ENHANCE_ENABLE = '\x1b[>4;0m\x1b[>5u'

/** Pop the enhancement stack and reset modifyOtherKeys (exit path). */
export const KEYBOARD_ENHANCE_DISABLE = '\x1b[<u\x1b[>4;0m'

/** Explicit environment overrides for terminal keyboard enhancement. */
export const DSH_DISABLE_KEYBOARD_ENHANCEMENT = 'DSH_DISABLE_KEYBOARD_ENHANCEMENT'
export const DSH_ENABLE_KEYBOARD_ENHANCEMENT = 'DSH_ENABLE_KEYBOARD_ENHANCEMENT'

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true
  if (normalized === '0' || normalized === 'false' || normalized === 'no') return false
  return undefined
}

/** True when the process is running inside the VS Code integrated terminal. */
export function isVsCodeTerminalEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM_PROGRAM?.trim().toLowerCase() === 'vscode' || env.VSCODE_INJECTION === '1'
}

/** Whether to push Kitty keyboard enhancement for the current terminal. */
export function shouldEnableKeyboardEnhancement(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitDisable = parseBooleanEnv(env[DSH_DISABLE_KEYBOARD_ENHANCEMENT])
  if (explicitDisable === true) return false
  const explicitEnable = parseBooleanEnv(env[DSH_ENABLE_KEYBOARD_ENHANCEMENT])
  if (explicitEnable !== undefined) return explicitEnable
  return !isVsCodeTerminalEnv(env)
}

/** Enable bracketed paste reporting. */
export const BRACKETED_PASTE_ENABLE = '\x1b[?2004h'

/** Disable bracketed paste reporting. */
export const BRACKETED_PASTE_DISABLE = '\x1b[?2004l'

/** Enable terminal focus-in/focus-out reporting (xterm focus protocol). */
export const TERMINAL_FOCUS_REPORT_ENABLE = '\x1b[?1004h'

/** Disable terminal focus-in/focus-out reporting. */
export const TERMINAL_FOCUS_REPORT_DISABLE = '\x1b[?1004l'

/**
 * Remove xterm focus reports from one input chunk and update the caller's
 * focus state. Focus reports are terminal protocol, not composer text.
 */
export function stripTerminalFocusEvents(chunk: string, onFocus: (focused: boolean) => void): string {
  return chunk.replace(/\x1b\[(I|O)/gu, (_whole, event: string) => {
    onFocus(event === 'I')
    return ''
  })
}

/** Bracketed paste markers as Ink delivers them (it strips the leading ESC). */
export const PASTE_START_MARKER = '[200~'
export const PASTE_END_MARKER = '[201~'

/**
 * How long an unterminated bracketed-paste block may hold buffered bytes
 * before the input splitter strips its start marker and releases them: a
 * terminal that loses the end marker must never take the whole keyboard
 * hostage (Esc/Ctrl+C included). Shared by the splitter and the composer's
 * lost-paste safety net so both use one window.
 */
export const PASTE_BRACKET_TIMEOUT_MS = 1_000

/**
 * Remove bracketed paste markers from one input chunk. Panel drafts accept raw
 * `input` text, where an unhandled paste would otherwise persist the literal
 * "[200~"/"[201~" markers Ink leaves after stripping the ESC byte.
 */
export function stripPasteMarkers(text: string): string {
  return text
    .replaceAll(`\x1b${PASTE_START_MARKER}`, '')
    .replaceAll(`\x1b${PASTE_END_MARKER}`, '')
    .replaceAll(PASTE_START_MARKER, '')
    .replaceAll(PASTE_END_MARKER, '')
}

/** One decoded CSI-u keypress: key code, 1-based modifier param, alternate code. */
interface CsiUKey {
  code: number
  modifiers: number
  alternate?: number
}

/** Match one CSI-u sequence (code, optional ;modifiers, then :event or ;alternate). */
const CSI_U_SOURCE = '\x1b\\[(\\d+)(?:;(\\d+))?(?:(:|;)(\\d+))?u'

/** Kitty private-use keycodes for the numeric keypad and keypad Enter. */
const KITTY_KEYPAD_CODES: Readonly<Record<number, string>> = {
  57399: '0',
  57400: '1',
  57401: '2',
  57402: '3',
  57403: '4',
  57404: '5',
  57405: '6',
  57406: '7',
  57407: '8',
  57408: '9',
  57414: '\r',
}

/** Legacy equivalent for one decoded CSI-u key, or undefined to pass through. */
function legacyForKey(key: CsiUKey): string | undefined {
  const bits = Math.max(0, key.modifiers - 1)
  const shift = (bits & 1) !== 0
  const alt = (bits & 2) !== 0
  const ctrl = (bits & 4) !== 0
  if (key.code === 13) {
    // Modified Enter is the composer's newline family (Codex insert_newline):
    // Ctrl+Enter and Shift+Enter collapse to the LF byte Ctrl+J already sends,
    // Alt keeps its legacy escape form, and plain Enter stays the submit key.
    if (ctrl || shift) return '\n'
    if (alt) return '\x1b\r'
    return '\r'
  }
  if (key.code === 27) return '\x1b'
  if (key.code === 9) return shift ? '\x1b[Z' : '\t'
  if (key.code === 127) return alt || ctrl ? '\x1b\x7f' : '\x7f'
  const keypad = KITTY_KEYPAD_CODES[key.code]
  if (keypad !== undefined) {
    if (alt) return '\x1b' + keypad
    return keypad
  }
  // Kitty disambiguate mode reports the six legacy functional keys as CSI u
  // codes 1-6 (Home, Insert, Delete, End, PageUp, PageDown). Ink 5 cannot
  // parse these forms and would insert literal "[3u" text into the draft, so
  // rewrite them to the legacy sequences the input layer already annotates.
  // The modifier parameter passes through: kitty and xterm share the same
  // 1+bit-field encoding (shift 2, alt 3, ctrl 5, ...). Lock-key bits are
  // dropped because the legacy sequences cannot express them.
  if (key.code >= 1 && key.code <= 6) {
    const mask = (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0)
    const mods = mask === 0 ? '' : `;${mask + 1}`
    if (key.code === 1) return mods === '' ? '\x1b[H' : `\x1b[1${mods}H`
    if (key.code === 4) return mods === '' ? '\x1b[F' : `\x1b[1${mods}F`
    return `\x1b[${key.code}${mods}~`
  }
  if (key.code >= 97 && key.code <= 122) {
    const letter = String.fromCodePoint(key.code)
    if (ctrl) return String.fromCodePoint(key.code - 96)
    if (alt) return '\x1b' + letter
    if (shift) return String.fromCodePoint(key.alternate ?? key.code - 32)
    return letter
  }
  if (key.code >= 65 && key.code <= 90) {
    if (ctrl) return String.fromCodePoint(key.code + 32 - 96)
    if (alt) return '\x1b' + String.fromCodePoint(key.code + 32)
    return String.fromCodePoint(key.code)
  }
  if (key.code >= 32 && key.code <= 126) {
    // Kitty reports ordinary printable keys as CSI-u with no alternate code
    // (for example space is `ESC[32u` and `1` is `ESC[49u`). Keep the
    // alternate form when present, but never leave a plain printable key as
    // an unknown escape sequence for Ink to swallow.
    const base = key.alternate ?? key.code
    if (ctrl && base - 96 >= 1 && base - 96 <= 26) return String.fromCodePoint(base - 96)
    if (alt) return '\x1b' + String.fromCodePoint(base)
    return String.fromCodePoint(base)
  }
  return undefined
}

/**
 * Rewrite every decodable kitty CSI-u sequence in one stdin chunk to the
 * legacy form the input layer already handles. Undecodable or non-key
 * sequences pass through untouched, so terminals without the protocol are
 * unaffected.
 */
export function normalizeKeyboardChunk(chunk: string): string {
  // dscode: xterm's modifyOtherKeys sends Shift+Enter as this CSI sequence and Ink
  // leaves it unparsed, so rewrite it to a newline before the Kitty path.
  chunk = chunk.replace(/\x1b\[27;2;13~/g, '\n')
  if (!chunk.includes('\x1b[') || !chunk.includes('u')) return chunk
  const pattern = new RegExp(CSI_U_SOURCE, 'g')
  return chunk.replace(pattern, (whole, code: string, mods?: string, separator?: ':' | ';', third?: string) => {
    const legacy = legacyForKey({
      code: Number.parseInt(code, 10),
      modifiers: mods === undefined || mods === '' ? 1 : Math.max(1, Number.parseInt(mods, 10)),
      // A colon introduces Kitty's optional event type (`:1` = press), not
      // an alternate key code. Semicolon introduces the alternate code.
      alternate: separator === ';' && third !== undefined && third !== '' ? Number.parseInt(third, 10) : undefined,
    })
    return legacy ?? whole
  })
}

/** Editor actions Ink cannot distinguish reliably when terminal bytes batch. */
export type RawEditorToken =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'home' | 'end' | 'delete-backward' | 'delete-word-backward' | 'delete-forward' | 'delete-word-forward' }

const HOME_SEQUENCES = ['\x1b[H', '\x1b[1~', '\x1b[7~', '\x1bOH'] as const
const END_SEQUENCES = ['\x1b[F', '\x1b[4~', '\x1b[8~', '\x1bOF'] as const

/** Parse one CSI functional-key sequence at `offset`. */
function functionalToken(chunk: string, offset: number): { token: RawEditorToken; length: number } | undefined {
  const tail = chunk.slice(offset)
  for (const sequence of HOME_SEQUENCES) {
    if (tail.startsWith(sequence)) return { token: { kind: 'home' }, length: sequence.length }
  }
  for (const sequence of END_SEQUENCES) {
    if (tail.startsWith(sequence)) return { token: { kind: 'end' }, length: sequence.length }
  }
  const modifiedHome = /^\x1b\[1;(\d+)H/u.exec(tail)
  if (modifiedHome !== null) return { token: { kind: 'home' }, length: modifiedHome[0].length }
  const modifiedEnd = /^\x1b\[1;(\d+)F/u.exec(tail)
  if (modifiedEnd !== null) return { token: { kind: 'end' }, length: modifiedEnd[0].length }
  const modifiedDelete = /^\x1b\[3(?:;(\d+))?~/u.exec(tail)
  if (modifiedDelete !== null) {
    const modifiers = Number.parseInt(modifiedDelete[1] ?? '1', 10) - 1
    const byWord = (modifiers & 2) !== 0 || (modifiers & 4) !== 0
    return {
      token: { kind: byWord ? 'delete-word-forward' : 'delete-forward' },
      length: modifiedDelete[0].length,
    }
  }
  return undefined
}

/**
 * Tokenize a stdin chunk containing at least one editor-only key. Ink calls
 * `useInput` once for a pasted/batched chunk, so preserving each action here
 * prevents repeated Backspace/Home/End/Delete presses from collapsing into
 * one blurred key event. Unknown escape sequences return undefined and stay
 * under Ink's ownership.
 */
export function tokenizeRawEditorChunk(chunk: string): readonly RawEditorToken[] | undefined {
  const tokens: RawEditorToken[] = []
  let text = ''
  let special = false
  const flushText = (): void => {
    if (text === '') return
    tokens.push({ kind: 'text', text })
    text = ''
  }
  for (let offset = 0; offset < chunk.length;) {
    if (chunk.startsWith('\x1b\x7f', offset) || chunk.startsWith('\x1b\b', offset)) {
      flushText()
      tokens.push({ kind: 'delete-word-backward' })
      special = true
      offset += 2
      continue
    }
    const functional = functionalToken(chunk, offset)
    if (functional !== undefined) {
      flushText()
      tokens.push(functional.token)
      special = true
      offset += functional.length
      continue
    }
    const char = chunk[offset]
    if (char === '\x7f' || char === '\b') {
      flushText()
      tokens.push({ kind: 'delete-backward' })
      special = true
      offset += 1
      continue
    }
    if (char === '\x1b') return undefined
    text += char
    offset += 1
  }
  flushText()
  return special ? tokens : undefined
}
