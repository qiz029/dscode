import { replaceOnce } from './patch-runtime.mjs';
import { ALIASES, LANGUAGES, MESSAGES, normalizeLanguage, languageName, t } from '../plugins/i18n/messages.mjs';

// Runtime half of /language inside the TUI bundle: the message tables, the
// current locale (from DSCODE_LANGUAGE or ~/.dsh/dsh-code/language.json),
// dscodeT() for every DSCODE-owned string, and the /language command.
export const LANGUAGE_SOURCE = `const DSCODE_LANGUAGES = ${JSON.stringify(LANGUAGES)};
const DSCODE_MESSAGES = ${JSON.stringify(MESSAGES)};
const DSCODE_LANGUAGE_ALIASES = ${JSON.stringify(ALIASES)};
${normalizeLanguage.toString().replace('const wanted', 'const aliasesByCode = DSCODE_LANGUAGE_ALIASES;\n  const wanted').replace('Object.entries(ALIASES)', 'Object.entries(aliasesByCode)').replace('function normalizeLanguage', 'function dscodeNormalizeLanguage')}
${languageName.toString().replace('LANGUAGES.find', 'DSCODE_LANGUAGES.find').replace('function languageName', 'function dscodeLanguageName')}
${t.toString().replace(/MESSAGES/g, 'DSCODE_MESSAGES').replace('function t(locale, key, params)', 'function dscodeTranslate(locale, key, params)')}
function dscodeLanguageFile() { return join(homedir(), ".dsh", "dsh-code", "language.json"); }
function dscodeLoadLanguage() {
  const override = dscodeNormalizeLanguage(process.env.DSCODE_LANGUAGE);
  if (override) return override;
  try { return dscodeNormalizeLanguage(JSON.parse(readFileSync(dscodeLanguageFile(), "utf8")).language) ?? "en"; } catch { return "en"; }
}
let dscodeLocale = dscodeLoadLanguage();
function dscodeT(key, params) { return dscodeTranslate(dscodeLocale, key, params); }
function dscodeSaveLanguage(code) {
  fs.mkdirSync(join(homedir(), ".dsh", "dsh-code"), { recursive: true });
  fs.writeFileSync(dscodeLanguageFile(), JSON.stringify({ language: code }, null, 2) + "\\n");
}
function dscodePadEnd(text, width) { return text + " ".repeat(Math.max(1, width - visibleColumns(text))); }
`;

const CATALOG_ANCHOR = '\t{\n\t\tlabel: "/mouse",\n\t\tdescription: "toggle mouse capture: off to select and copy text, on for wheel scrolling"\n\t},\n';
const CATALOG_ENTRY = '\t{\n\t\tlabel: "/language",\n\t\tdescription: "show or set the interface language: en, zh-CN, zh-TW, ja, ko, es"\n\t},\n';
const DISPATCH_ANCHOR = '\t\t\tif (text === "/todos") {\n\t\t\t\topenTodos();';
const DISPATCH_ENTRY = `\t\t\tif (text === "/language" || text.startsWith("/language ")) {
\t\t\t\tconst wanted = text.slice(9).trim();
\t\t\t\tif (!wanted) { notify(dscodeT("language.current", { name: dscodeLanguageName(dscodeLocale) })); return; }
\t\t\t\tconst code = dscodeNormalizeLanguage(wanted);
\t\t\t\tif (!code) { notify(dscodeT("language.unknown", { value: wanted }), "warning"); return; }
\t\t\t\tdscodeLocale = code;
\t\t\t\ttry { dscodeSaveLanguage(code); } catch (error) { notify(dscodeT("language.saveFailed", { error: error instanceof Error ? error.message : String(error) }), "error"); }
\t\t\t\tnotify(dscodeT("language.set", { name: dscodeLanguageName(code) }));
\t\t\t\trefresh();
\t\t\t\treturn;
\t\t\t}
`;

export function patchLanguage(text) {
  if (text.includes('// dscode-language-v1')) {
    // Refresh the embedded message tables so translation edits reach an already-patched bundle.
    const start = text.indexOf('const DSCODE_LANGUAGES = ');
    const end = text.indexOf('function dscodePadEnd(', start);
    const close = text.indexOf('\n', end) + 1;
    if (start < 0 || end < 0) throw Error('Patched TUI language runtime drift');
    const current = text.slice(start, close);
    return current === LANGUAGE_SOURCE ? text : text.slice(0, start) + LANGUAGE_SOURCE + text.slice(close);
  }
  text = replaceOnce(text, CATALOG_ANCHOR, CATALOG_ANCHOR + CATALOG_ENTRY);
  text = replaceOnce(text, DISPATCH_ANCHOR, DISPATCH_ENTRY + DISPATCH_ANCHOR);
  return '// dscode-language-v1\n' + LANGUAGE_SOURCE + text;
}
