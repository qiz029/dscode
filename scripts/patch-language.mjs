import { replaceOnce } from './patch-util.mjs';
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
function dscodeFlagFile(name) { return join(homedir(), ".dsh", "dsh-code", name + ".json"); }
function dscodeLoadFlag(name, fallback = false) {
  try { const value = JSON.parse(readFileSync(dscodeFlagFile(name), "utf8"))[name]; return typeof value === "boolean" ? value : fallback; } catch { return fallback; }
}
function dscodeSaveFlag(name, value) {
  try { fs.mkdirSync(join(homedir(), ".dsh", "dsh-code"), { recursive: true }); fs.writeFileSync(dscodeFlagFile(name), JSON.stringify({ [name]: value }, null, 2) + "\\n"); } catch {}
}
`;

// Mode A owns the whole terminal: there is no mouse command, so the language entry rides the verbose entry.
const CATALOG_ANCHOR = '\t{\n\t\tlabel: "/verbose",\n\t\tdescription: "toggle thinking and tool call details in the chat"\n\t},\n';
const CATALOG_ENTRY = '\t{\n\t\tlabel: "/language",\n\t\tdescription: "show or set the interface language: en, zh-CN, zh-TW, ja, ko, es"\n\t},\n';
const DISPATCH_ANCHOR = '\t\t\tif (text === "/todos") {\n\t\t\t\topenTodos();';
const NOARG_V1 = '\t\t\t\tif (!wanted) { notify(dscodeT("language.current", { name: dscodeLanguageName(dscodeLocale) })); return; }';
const NOARG_V2 = '\t\t\t\tif (!wanted) { openLanguage(); return; }';
const DISPATCH_ENTRY = `\t\t\tif (text === "/language" || text.startsWith("/language ")) {
\t\t\t\tconst wanted = text.slice(9).trim();
${NOARG_V2}
\t\t\t\tconst code = dscodeNormalizeLanguage(wanted);
\t\t\t\tif (!code) { notify(dscodeT("language.unknown", { value: wanted }), "warning"); return; }
\t\t\t\tdscodeLocale = code;
\t\t\t\ttry { dscodeSaveLanguage(code); } catch (error) { notify(dscodeT("language.saveFailed", { error: error instanceof Error ? error.message : String(error) }), "error"); }
\t\t\t\tnotify(dscodeT("language.set", { name: dscodeLanguageName(code) }));
\t\t\t\trefresh();
\t\t\t\treturn;
\t\t\t}
`;

// The picker: rows are the supported languages, the current one is marked, ↑↓ moves, enter applies, esc closes.
const PANEL_SOURCE = `function LanguagePanel({ current, select, close }) {
	const rows = DSCODE_LANGUAGES;
	const [cursor, setCursor] = (0, import_react.useState)(() => Math.max(0, rows.findIndex((language) => language.code === current)));
	const stdout = useStdout().stdout;
	const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30);
	useInput((input, key) => {
		if (key.escape || input === "q") return close();
		if (key.upArrow) return setCursor((value) => (value + rows.length - 1) % rows.length);
		if (key.downArrow) return setCursor((value) => (value + 1) % rows.length);
		if (key.return) return select(rows[cursor].code);
	});
	if (viewport.maxHeight === 0 || viewport.compact) return (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns("/language · esc close", viewport.contentColumns));
	const rowBudget = Math.max(1, viewport.bodyRows);
	const first = clampScroll(cursor, rows.length, rowBudget);
	const visible = rows.slice(first, first + rowBudget);
	return (0, import_react.createElement)(Box, { width: viewport.outerColumns, borderStyle: "round", borderColor: inkColor(getPalette().dim), flexDirection: "column", paddingX: 1 },
		(0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright), wrap: "truncate-end" }, truncateColumns(dscodeT("language.title"), viewport.contentColumns)),
		...visible.map((language, index) => {
			const selected = first + index === cursor;
			const active = language.code === current;
			return (0, import_react.createElement)(Text, { key: language.code, color: selected ? inkColor(getPalette().brandBright) : void 0, wrap: "truncate-end" },
				truncateColumns(\`\${selected ? "› " : "  "}\${active ? "● " : "○ "}\${language.name}\${active ? " · " + dscodeT("language.currentMark") : ""} · \${language.code}\`, viewport.contentColumns));
		}),
		(0, import_react.createElement)(Text, { dimColor: true, wrap: "truncate-end" }, truncateColumns("↑↓ choose · enter apply · esc/q close", viewport.contentColumns)));
}
`;
const PANEL_RENDER = `}) : void 0, languageOpen && !approvalPending && !questionPending ? (0, import_react.createElement)(LanguagePanel, {
		current: dscodeLocale,
		select: (code) => {
			dscodeLocale = code;
			try { dscodeSaveLanguage(code); } catch (error) { notify(dscodeT("language.saveFailed", { error: error instanceof Error ? error.message : String(error) }), "error"); }
			notify(dscodeT("language.set", { name: dscodeLanguageName(code) }));
			setLanguageOpen(false);
			refreshScreen();
		},
		close: () => setLanguageOpen(false)
	}) : void 0, historyOpen && !approvalPending && !questionPending ? (0, import_react.createElement)(HistoryPanel, {`;

/** Wire the picker into the App: state, focus and modal conditions, close-all, the Input prop, the render slot and the component. */
function patchLanguagePanel(text) {
  if (text.includes('// dscode-language-v2')) return text;
  text = replaceOnce(text, '\tconst [themeOpen, setThemeOpen] = (0, import_react.useState)(false);\n', '\tconst [themeOpen, setThemeOpen] = (0, import_react.useState)(false);\n\tconst [languageOpen, setLanguageOpen] = (0, import_react.useState)(false);\n');
  if (text.split('!themeOpen').length !== 3) throw Error('Pinned TUI panel focus drift');
  text = text.split('!themeOpen').join('!themeOpen && !languageOpen');
  text = replaceOnce(text, 'themeOpen ||', 'themeOpen || languageOpen ||');
  text = replaceOnce(text, '\t\tsetThemeOpen(false);\n\t\tsetHistoryOpen(false);\n', '\t\tsetThemeOpen(false);\n\t\tsetLanguageOpen(false);\n\t\tsetHistoryOpen(false);\n');
  text = replaceOnce(text, '\t\topenTheme: () => setThemeOpen(true),\n', '\t\topenTheme: () => setThemeOpen(true),\n\t\topenLanguage: () => setLanguageOpen(true),\n');
  text = replaceOnce(text, 'openStatusline, openTheme, openHistory,', 'openStatusline, openTheme, openLanguage, openHistory,');
  text = replaceOnce(text, '}) : void 0, historyOpen && !approvalPending && !questionPending ? (0, import_react.createElement)(HistoryPanel, {', PANEL_RENDER);
  text = replaceOnce(text, 'function ThemePanel({ current, select, close }) {', PANEL_SOURCE + 'function ThemePanel({ current, select, close }) {');
  text = text.replace(NOARG_V1, NOARG_V2);
  if (!text.includes(NOARG_V2)) throw Error('Pinned TUI /language dispatch drift');
  return '// dscode-language-v2\n' + text;
}

/** Append the live locale to the dscodeFooterFor call, whatever width expression the style patch left inside it. Runs last in the chain. */
function withFooterLocale(text) {
  const marker = 'dscodeFooterFor(facts.fullSessionId, stats, ';
  const at = text.indexOf(marker);
  if (at < 0) throw new Error('Pinned TUI footer call drift');
  let depth = 1, index = at + marker.length;
  while (index < text.length && depth > 0) { const char = text[index++]; if (char === '(') depth++; else if (char === ')') depth--; }
  const close = index - 1;
  if (text.slice(at, close).includes('dscodeLocale')) return text;
  return text.slice(0, close) + ', dscodeLocale' + text.slice(close);
}

export function patchLanguage(text) {
  // The composer placeholder and the footer labels follow the interface language; plain, idempotent swaps.
  text = text.split('value === "" ? "type a message" :').join('value === "" ? dscodeT("composer.placeholder") :');
  text = withFooterLocale(text);
  if (text.includes('// dscode-language-v1')) {
    // Refresh the embedded message tables so translation edits reach an already-patched bundle.
    const start = text.indexOf('const DSCODE_LANGUAGES = ');
    const marker = text.includes('function dscodeSaveFlag(') ? 'function dscodeSaveFlag(' : 'function dscodePadEnd(';
    const end = text.indexOf(marker, start);
    const close = marker === 'function dscodeSaveFlag(' ? text.indexOf('\n}\n', end) + 3 : text.indexOf('\n', end) + 1;
    if (start < 0 || end < 0) throw Error('Patched TUI language runtime drift');
    const current = text.slice(start, close);
    if (current !== LANGUAGE_SOURCE) text = text.slice(0, start) + LANGUAGE_SOURCE + text.slice(close);
    return patchLanguagePanel(text);
  }
  text = replaceOnce(text, CATALOG_ANCHOR, CATALOG_ANCHOR + CATALOG_ENTRY);
  text = replaceOnce(text, DISPATCH_ANCHOR, DISPATCH_ENTRY + DISPATCH_ANCHOR);
  return patchLanguagePanel('// dscode-language-v1\n' + LANGUAGE_SOURCE + text);
}
