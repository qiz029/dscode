/**
 * Interface language for the TUI: a module-level current language with a
 * message accessor, mirroring the theme module's setTheme/getPalette shape
 * so a language switch re-renders every translated surface on the next
 * render without touching call sites. English is the default; the persisted
 * choice lives in language.json next to theme.json (see the runner's
 * persistence block).
 *
 * @module @deepseek-ai/dsh-tui/i18n
 */

import { en, type MessageCatalog, type MessageKey } from './locales/en.ts'

export type { MessageKey } from './locales/en.ts'
import { zh } from './locales/zh.ts'

/** Selectable interface languages: English (default) and Chinese. */
export type LanguageName = 'en' | 'zh'

/** Valid language names for argument parsing. */
export const LANGUAGE_NAMES: readonly LanguageName[] = ['en', 'zh']

/** One language's picker row. */
export interface LanguageDescriptor {
  readonly id: LanguageName
  readonly label: string
}

/** The /language picker rows in canonical order. */
export const LANGUAGES: readonly LanguageDescriptor[] = [
  { id: 'en', label: 'English' },
  { id: 'zh', label: '中文' },
]

const CATALOGS: Record<LanguageName, MessageCatalog> = { en, zh }

/** The language in force. */
let activeName: LanguageName = 'en'

/**
 * Parse a persisted or typed language name: only 'en' and 'zh' survive;
 * anything else falls back to English.
 */
export function parseLanguageName(value: unknown): LanguageName {
  return value === 'zh' ? 'zh' : 'en'
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
 * from the params record. Unknown placeholders stay literal; a missing key
 * falls back to the English entry so a catalog gap degrades visibly but
 * never crashes.
 */
export function t(key: MessageKey, params: Readonly<Record<string, string | number>> = {}): string {
  const template = CATALOGS[activeName][key] ?? en[key]
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    params[name] === undefined ? whole : String(params[name]))
}
