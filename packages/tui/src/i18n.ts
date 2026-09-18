/**
 * Interface language for the TUI: a module-level current language with a
 * message accessor, mirroring the theme module's setTheme/getPalette shape
 * so a language switch re-renders every translated surface on the next
 * render without touching call sites. English is the default; the persisted
 * choice lives in language.json next to theme.json (see the runner's
 * persistence block).
 *
 * The selectable list and the alias table come from the DSCODE message
 * tables, so `/language` offers everything those tables translate. The
 * terminal's own catalogues still only cover English and Simplified Chinese:
 * any other choice paints the shell in English and DSCODE's labels in the
 * chosen language, which is exactly what `/language` promises.
 *
 * @module @deepseek-ai/dsh-tui/i18n
 */

import { en, type MessageCatalog, type MessageKey } from './locales/en.ts'
import { zh } from './locales/zh.ts'
import { LANGUAGES as DSCODE_LANGUAGES, normalizeLanguage } from '../../../plugins/i18n/messages.mjs'

export type { MessageKey } from './locales/en.ts'

/** Selectable interface languages, exactly the codes the DSCODE tables carry. */
export type LanguageName = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'es'

/** Valid language names for argument parsing, in picker order. */
export const LANGUAGE_NAMES: readonly LanguageName[] = DSCODE_LANGUAGES.map(language => language.code as LanguageName)

/** One language's picker row. */
export interface LanguageDescriptor {
  readonly id: LanguageName
  readonly label: string
}

/** The /language picker rows in canonical order. */
export const LANGUAGES: readonly LanguageDescriptor[] = DSCODE_LANGUAGES.map(language => ({ id: language.code as LanguageName, label: language.name }))

/** Catalogues this module can paint; anything else keeps English. */
const CATALOGS: Readonly<Partial<Record<LanguageName, MessageCatalog>>> = { en, 'zh-CN': zh, 'zh-TW': zh }

/** The language in force. */
let activeName: LanguageName = 'en'

/**
 * Parse a persisted or typed language name through the DSCODE alias table, so
 * `zh`, `jp` or `简体中文` all resolve. An unknown value falls back to English.
 */
export function parseLanguageName(value: unknown): LanguageName {
  const code = normalizeLanguage(value)
  return code !== null && (LANGUAGE_NAMES as readonly string[]).includes(code) ? code as LanguageName : 'en'
}

/** The language name in force. */
export function getLanguage(): LanguageName {
  return activeName
}

/** Switch the active language; the next render paints with the new catalog. */
export function setLanguage(name: LanguageName): void {
  activeName = name
}

/**
 * One message from the active catalog, with `{n}`-style placeholders filled
 * from the params record. Unknown placeholders stay literal; a language the
 * terminal cannot paint, or a missing key, falls back to the English entry so
 * a catalog gap degrades visibly but never crashes.
 */
export function t(key: MessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  const template = CATALOGS[activeName]?.[key] ?? en[key]
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]))
}
