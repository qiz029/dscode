/**
 * VS Code-family terminal keybinding repair. VS Code hands Ctrl+R to the
 * workbench (Open Recent) even while an integrated terminal owns focus, so
 * the reasoning-fold key never reaches the TUI. Workspace-scoped keybindings
 * do not exist, so the fix is one user-level keybindings.json rule that
 * forwards the raw Ctrl byte via sendSequence under terminalFocus. This
 * module detects the hosting editor variant, resolves its user
 * keybindings.json, and merges the rule idempotently; pure merge/detect
 * helpers are separated from the fs orchestration so both stay testable.
 * @module @deepseek-ai/dsh-code/editor-keys
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Integrated-terminal editor variants this module can repair. */
export type EditorTerminalFamily = 'vscode' | 'cursor' | 'vscodium' | 'windsurf'

/** Install directory names per family ('vscode' covers stable and Insiders). */
const FAMILY_DIRS: Record<EditorTerminalFamily, readonly string[]> = {
  vscode: ['Code', 'Code - Insiders'],
  cursor: ['Cursor'],
  vscodium: ['VSCodium'],
  windsurf: ['Windsurf'],
}

/**
 * Detect the editor hosting this integrated terminal.
 * @param env - process environment (TERM_PROGRAM decides; case/whitespace tolerant).
 * @returns the family, or undefined outside VS Code-family terminals.
 */
export function detectEditorTerminalFamily(env: NodeJS.ProcessEnv = process.env): EditorTerminalFamily | undefined {
  const program = env.TERM_PROGRAM?.trim().toLowerCase()
  if (program === 'vscode' || program === 'cursor' || program === 'vscodium' || program === 'windsurf') return program
  return undefined
}

/**
 * Whether the pty is hosted away from the editor UI (ssh/container/tunnel).
 * Keybindings live on the client machine, so a remote session must never
 * write them server-side.
 */
export function isRemoteTerminalEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.VSCODE_IPC_HOOK_CLI ?? '').trim() !== ''
}

/** Filesystem anchors used to resolve editor config paths (injectable for tests). */
export interface EditorPathContext {
  /** User home directory. */
  homedir: string
  /** %APPDATA% on Windows; only read for win32 resolution. */
  appdata?: string
  /** Node platform qualifier. */
  platform: NodeJS.Platform
}

/**
 * Resolve the user keybindings.json candidates for one family, most likely
 * install first. Only paths that exist on disk are repaired.
 */
export function editorKeybindingCandidates(family: EditorTerminalFamily, context: EditorPathContext): readonly string[] {
  return FAMILY_DIRS[family].map(dir => {
    if (context.platform === 'win32') {
      return join(context.appdata ?? join(context.homedir, 'AppData', 'Roaming'), dir, 'User', 'keybindings.json')
    }
    if (context.platform === 'darwin') {
      return join(context.homedir, 'Library', 'Application Support', dir, 'User', 'keybindings.json')
    }
    return join(context.homedir, '.config', dir, 'User', 'keybindings.json')
  })
}

/** The one workbench rule that hands Ctrl+R to the focused terminal. */
export const CTRL_R_PASSTHROUGH_RULE = {
  key: 'ctrl+r',
  command: 'workbench.action.terminal.sendSequence',
  args: { text: '\u0012' },
  when: 'terminalFocus',
} as const

/** Serialized rule block (4-space indent, the editors' default style). */
const RULE_BLOCK = [
  '    {',
  '        "key": "ctrl+r",',
  '        "command": "workbench.action.terminal.sendSequence",',
  '        "args": { "text": "\\u0012" },',
  '        "when": "terminalFocus"',
  '    }',
].join('\n')

/** Fresh-file template carrying the editors' standard header comment. */
const KEYBINDINGS_TEMPLATE = '// Place your key bindings in this file to override the defaults\n[\n' + RULE_BLOCK + '\n]\n'

/** Whether one parsed keybindings entry already forwards Ctrl+R to the terminal. */
function isCtrlRPassthroughEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false
  const record = entry as Record<string, unknown>
  if (record.command !== CTRL_R_PASSTHROUGH_RULE.command) return false
  if (typeof record.key !== 'string' || record.key.trim().toLowerCase() !== CTRL_R_PASSTHROUGH_RULE.key) return false
  const args = record.args
  if (typeof args !== 'object' || args === null) return false
  const text = (args as Record<string, unknown>).text
  if (typeof text !== 'string' || !text.includes('\u0012')) return false
  return typeof record.when === 'string' && /\bterminalFocus\b/u.test(record.when)
}

/**
 * Remove // and block comments from one JSONC document. Double-quoted strings
 * survive untouched, so comment markers inside string values are preserved.
 */
export function stripJsoncComments(text: string): string {
  let out = ''
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === '\\' && index + 1 < text.length) {
        out += text[index + 1]
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') out += '\n'
        index += 1
      }
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Drop commas directly before a closing bracket (string-aware). */
function removeTrailingCommas(text: string): string {
  let out = ''
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === '\\' && index + 1 < text.length) {
        out += text[index + 1]
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      index += 1
      continue
    }
    if (char === ',') {
      let peek = index + 1
      while (peek < text.length && (text[peek] === ' ' || text[peek] === '\t' || text[peek] === '\n' || text[peek] === '\r')) peek += 1
      const next = text[peek]
      if (next === '}' || next === ']') {
        index += 1
        continue
      }
    }
    out += char
    index += 1
  }
  return out
}

/** Parse one JSONC document; trailing commas are tolerated. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(stripJsoncComments(text)))
}

/** Raw index of the top-level rule array's opening bracket, or -1 when absent. */
function rawOpenBracketIndex(text: string): number {
  let index = 0
  let inString = false
  while (index < text.length) {
    const char = text[index]
    if (inString) {
      if (char === '\\') {
        index += 2
        continue
      }
      if (char === '"') inString = false
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '[') return index
    index += 1
  }
  return -1
}

/** Outcome of merging the passthrough rule into one keybindings document. */
export type KeybindingsMerge =
  | { readonly status: 'present' }
  | { readonly status: 'updated'; readonly text: string }
  | { readonly status: 'created'; readonly text: string }

/**
 * Merge the Ctrl+R passthrough into one keybindings.json document. The raw
 * text is preserved verbatim (comments included); the rule is inserted right
 * after the array opener so it cannot be shadowed by later conflicting user
 * rules. Missing files resolve to a fresh template.
 * @throws when the document does not carry a rule array.
 */
export function mergeCtrlRPassthrough(raw: string | undefined): KeybindingsMerge {
  if (raw === undefined) return { status: 'created', text: KEYBINDINGS_TEMPLATE }
  const parsed = parseJsonc(raw)
  if (!Array.isArray(parsed)) throw new Error('keybindings.json does not contain a rule array')
  if (parsed.some(isCtrlRPassthroughEntry)) return { status: 'present' }
  const open = rawOpenBracketIndex(raw)
  if (open === -1) throw new Error('keybindings.json does not contain a rule array')
  const insert = parsed.length > 0 ? '\n' + RULE_BLOCK + ',' : '\n' + RULE_BLOCK
  return { status: 'updated', text: raw.slice(0, open + 1) + insert + raw.slice(open + 1) }
}

/** User-level marker file content: the startup hint fires at most once per install. */
export interface EditorKeysFlag {
  hintShownAt?: string
}

/** Parse one flag file snapshot; missing or corrupt content degrades to unshown. */
export function parseEditorKeysFlag(raw: string | undefined): EditorKeysFlag {
  if (raw === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const shown = (parsed as Record<string, unknown>).hintShownAt
    return typeof shown === 'string' ? { hintShownAt: shown } : {}
  } catch {
    return {}
  }
}

/** Persist the shown marker; best-effort, the hint is cosmetic and never a gate. */
export async function markEditorKeysHintShown(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ hintShownAt: new Date().toISOString() }, null, 2) + '\n', 'utf8')
}

/** Inputs shared by the apply and startup-hint flows. */
export interface EditorKeysEnv {
  /** Process environment (TERM_PROGRAM / VSCODE_IPC_HOOK_CLI). */
  env: NodeJS.ProcessEnv
  /** Filesystem anchors for editor config resolution. */
  paths: EditorPathContext
  /** Absolute path of the one-shot hint marker under the DSH home. */
  flagPath: string
}

/** Read one file if it exists; undefined otherwise (ENOENT and unreadable both). */
async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Apply the Ctrl+R passthrough to every local keybindings.json of the hosting
 * editor and mark the startup hint shown. Existing files get a .dsh-bak
 * backup before the first write.
 * @returns a one-line user-facing summary.
 * @throws with an actionable message when the environment cannot be repaired.
 */
export async function applyCtrlRPassthrough({ env, paths, flagPath }: EditorKeysEnv): Promise<string> {
  const family = detectEditorTerminalFamily(env)
  if (family === undefined) {
    throw new Error(
      'not a VS Code-family terminal (TERM_PROGRAM=' + (env.TERM_PROGRAM?.trim() || 'unset') + '); add the ctrl+r rule to keybindings.json manually',
    )
  }
  if (isRemoteTerminalEnv(env)) {
    throw new Error('remote terminal detected; apply the keybindings rule on the local machine instead')
  }
  const candidates = editorKeybindingCandidates(family, paths)
  const targets: string[] = []
  for (const candidate of candidates) {
    if (await readIfPresent(candidate) !== undefined) targets.push(candidate)
  }
  if (targets.length === 0) targets.push(candidates[0])
  const updated: string[] = []
  const present: string[] = []
  for (const target of targets) {
    const raw = await readIfPresent(target)
    const merge = mergeCtrlRPassthrough(raw)
    if (merge.status === 'present') {
      present.push(target)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    if (raw !== undefined) await writeFile(target + '.dsh-bak', raw, 'utf8')
    await writeFile(target, merge.text, 'utf8')
    updated.push(target)
  }
  await markEditorKeysHintShown(flagPath).catch(() => {})
  const label = (target: string): string => basename(dirname(dirname(target)))
  if (updated.length === 0) {
    return 'ctrl+r passthrough already configured in ' + present.map(label).join(', ')
  }
  return 'ctrl+r passthrough written to ' + updated.map(label).join(', ') + ' — effective immediately'
}

/**
 * Resolve the one-shot startup hint for VS Code-family terminals. Fires at
 * most once per install (flag file), never when the passthrough rule is
 * already present, and never in remote ptys where the repair cannot run.
 * @returns the hint line, or undefined to stay silent.
 */
export async function resolveEditorKeysStartupHint({ env, paths, flagPath }: EditorKeysEnv): Promise<string | undefined> {
  const flag = parseEditorKeysFlag(await readIfPresent(flagPath))
  if (flag.hintShownAt !== undefined) return undefined
  const family = detectEditorTerminalFamily(env)
  if (family === undefined || isRemoteTerminalEnv(env)) return undefined
  for (const candidate of editorKeybindingCandidates(family, paths)) {
    const raw = await readIfPresent(candidate)
    if (raw === undefined) continue
    try {
      const parsed: unknown = parseJsonc(raw)
      if (Array.isArray(parsed) && parsed.some(isCtrlRPassthroughEntry)) {
        await markEditorKeysHintShown(flagPath).catch(() => {})
        return undefined
      }
    } catch {
      // An unparseable config still deserves the hint; apply reports the error.
    }
  }
  await markEditorKeysHintShown(flagPath).catch(() => {})
  return 'run /vscode-keys to pass ctrl+r through this editor (alt+r works meanwhile)'
}
