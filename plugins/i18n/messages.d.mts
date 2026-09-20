/**
 * Types for the DSCODE message tables, for the vendored terminal's TypeScript.
 * The module is plain JS on purpose (it ships beside the plugins and is read by
 * both surfaces), so this declares exactly the surface `packages/tui/src` imports:
 * the language list, the alias normalizer, the lookup and the display name.
 */
export interface LanguageEntry {
  code: string;
  name: string;
}

export const LANGUAGES: readonly LanguageEntry[];
export const ALIASES: Readonly<Record<string, readonly string[]>>;
export const MESSAGES: Readonly<Record<string, Readonly<Record<string, string>>>>;

/** Resolve a typed or persisted language name to its code, or null when unknown. */
export function normalizeLanguage(value: unknown): string | null;
/** The display name of a language code, or the code itself. */
export function languageName(code: string): string;
/** One message in one locale, with `{name}` parameters interpolated. */
export function t(locale: string, key: string, params?: Readonly<Record<string, unknown>>): string;
