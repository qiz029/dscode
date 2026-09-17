import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LANGUAGES, MESSAGES, ALIASES, normalizeLanguage, languageName, t, readLanguage, saveLanguage, languageFile } from '../plugins/i18n/messages.mjs';

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


test('the update messages interpolate in every language', () => {
  for (const { code } of LANGUAGES) {
    const notice = t(code, 'update.available', { version: '0.7.11' });
    assert.match(notice, /0\.7\.11/, code);
    assert.ok(!notice.includes('{version}'), code);
    const scheduled = t(code, 'update.scheduled', { version: '0.7.11', log: '/tmp/update.log' });
    assert.ok(scheduled.includes('/tmp/update.log'), code);
    assert.equal(scheduled.split('\n').length, 2, code);
    assert.ok(!t(code, 'update.usage').includes('{'), code);
    assert.ok(t(code, 'update.newest').trim().length > 0, code);
  }
});
