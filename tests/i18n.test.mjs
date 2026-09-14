import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LANGUAGES, MESSAGES, ALIASES, normalizeLanguage, languageName, t, readLanguage, saveLanguage, languageFile } from '../plugins/i18n/messages.mjs';
import { patchLanguage, LANGUAGE_SOURCE } from '../scripts/patch-language.mjs';

test('every language carries every key and English is the fallback', () => {
  const keys = Object.keys(MESSAGES.en);
  assert.deepEqual(LANGUAGES.map(l => l.code), ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es']);
  for (const { code } of LANGUAGES) {
    assert.deepEqual(Object.keys(MESSAGES[code]).sort(), [...keys].sort(), code);
    for (const key of keys) assert(MESSAGES[code][key].trim(), `${code}:${key}`);
    assert(ALIASES[code].includes(code.toLowerCase()) && ALIASES[code].includes(languageName(code).toLowerCase()), code);
  }
  assert.equal(t('ja', 'activity.thinking'), '思考中');
  assert.equal(t('xx', 'activity.thinking'), 'Thinking');
  assert.equal(t('es', 'missing.key'), 'missing.key');
  assert.equal(t('zh-CN', 'language.set', { name: '简体中文' }), '语言 → 简体中文');
  assert.equal(t('en', 'doctor.evidence', { traces: 3, logs: 0 }), 'Diagnostic evidence: 3 recent sessions, 0 warnings/errors.');
});

test('language aliases resolve loosely and unknown values are rejected', () => {
  for (const [value, code] of [['en', 'en'], ['English', 'en'], ['zh', 'zh-CN'], ['zh_CN', 'zh-CN'], ['简体中文', 'zh-CN'], ['cn', 'zh-CN'], ['zh-TW', 'zh-TW'], ['繁體中文', 'zh-TW'], ['tw', 'zh-TW'], ['ja', 'ja'], ['jp', 'ja'], ['日本語', 'ja'], ['ko', 'ko'], ['한국어', 'ko'], ['es', 'es'], ['Español', 'es'], ['spanish', 'es']]) assert.equal(normalizeLanguage(value), code, value);
  for (const value of ['', ' ', 'fr', 'klingon', undefined, null]) assert.equal(normalizeLanguage(value), null, String(value));
  assert.equal(languageName('ko'), '한국어');
  assert.equal(languageName('xx'), 'xx');
});

test('the language is stored per machine and DSCODE_LANGUAGE overrides it', () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-i18n-'));
  try {
    assert.equal(readLanguage({ home, env: {} }), 'en');
    assert.equal(saveLanguage('繁體中文', { home }), 'zh-TW');
    assert.deepEqual(JSON.parse(readFileSync(languageFile(home), 'utf8')), { language: 'zh-TW' });
    assert.equal(readLanguage({ home, env: {} }), 'zh-TW');
    assert.equal(readLanguage({ home, env: { DSCODE_LANGUAGE: 'ja' } }), 'ja');
    assert.equal(readLanguage({ home, env: { DSCODE_LANGUAGE: 'nope' } }), 'zh-TW');
    assert.throws(() => saveLanguage('fr', { home }), /Unknown language/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the TUI patch embeds the tables, adds /language, and refreshes an already-patched bundle', () => {
  const upstream = ['\t{\n\t\tlabel: "/mouse",\n\t\tdescription: "toggle mouse capture: off to select and copy text, on for wheel scrolling"\n\t},\n',
    'function Input({ openStatusline, openTheme, openHistory, notify, refresh }) {\n\t\t\tif (text === "/todos") {\n\t\t\t\topenTodos();\n',
    '\tconst [themeOpen, setThemeOpen] = (0, import_react.useState)(false);\n',
    'const inputActive = !themeOpen && x;\nconst transcriptVisible = !themeOpen && y;\nconst modalVisible = themeOpen || z;\n',
    '\t\tsetThemeOpen(false);\n\t\tsetHistoryOpen(false);\n\t\topenTheme: () => setThemeOpen(true),\n',
    '}) : void 0, historyOpen && !approvalPending && !questionPending ? (0, import_react.createElement)(HistoryPanel, {\n',
    'function ThemePanel({ current, select, close }) {\n'].join('');
  const once = patchLanguage(upstream);
  assert(once.startsWith('// dscode-language-v2\n// dscode-language-v1\n'));
  assert(once.includes('label: "/language"') && once.includes('if (text === "/language" || text.startsWith("/language "))'));
  assert(once.includes('if (!wanted) { openLanguage(); return; }'), 'bare /language opens the picker');
  assert(once.includes('function LanguagePanel({ current, select, close })') && once.includes('createElement)(LanguagePanel, {'));
  assert(once.includes('const inputActive = !themeOpen && !languageOpen && x;') && once.includes('const modalVisible = themeOpen || languageOpen || z;'));
  assert(once.includes('openStatusline, openTheme, openLanguage, openHistory,') && once.includes('openLanguage: () => setLanguageOpen(true),') && once.includes('\t\tsetLanguageOpen(false);\n'));
  assert(once.includes(LANGUAGE_SOURCE));
  assert.equal(patchLanguage(once), once);
  const stale = once.replace('"activity.running":"Running"', '"activity.running":"Old"');
  assert.notEqual(stale, once);
  assert.equal(patchLanguage(stale), once, 'embedded translations resync to the current tables');
  const v1 = once.replace('// dscode-language-v2\n', '').replace('if (!wanted) { openLanguage(); return; }', 'if (!wanted) { notify(dscodeT("language.current", { name: dscodeLanguageName(dscodeLocale) })); return; }');
  assert(!v1.includes('LanguagePanel') || v1.includes('createElement)(LanguagePanel'), 'fixture sanity');
  const upgraded = patchLanguage(v1.replace(/function LanguagePanel[\s\S]*?\n}\n/, '').replace(/}\) : void 0, languageOpen[\s\S]*?HistoryPanel, \{/, '}) : void 0, historyOpen && !approvalPending && !questionPending ? (0, import_react.createElement)(HistoryPanel, {').replace(' && !languageOpen', '').replace(' && !languageOpen', '').replace('themeOpen || languageOpen ||', 'themeOpen ||').replace('\t\tsetLanguageOpen(false);\n', '').replace('\t\topenLanguage: () => setLanguageOpen(true),\n', '').replace('openTheme, openLanguage, openHistory,', 'openTheme, openHistory,').replace('\tconst [languageOpen, setLanguageOpen] = (0, import_react.useState)(false);\n', ''));
  assert.equal(upgraded, once, 'a v1-patched bundle upgrades to the picker');
  assert.throws(() => patchLanguage('unknown upstream'), /drift/);
});
