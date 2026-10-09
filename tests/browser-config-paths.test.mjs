import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { validateConfig } from '../plugins/browser/config.mjs';

const cases = [
  [posix, '/Applications/Chrome for Testing.app/Contents/MacOS/Chrome', true],
  [posix, '/opt/google/chrome/chrome', true],
  [posix, 'chrome', false],
  [posix, './chrome', false],
  [posix, 'C:/Program Files/Google/Chrome/chrome.exe', false],
  [win32, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', true],
  [win32, 'C:/Program Files/Google/Chrome/Application/chrome.exe', true],
  [win32, '\\\\server\\tools\\Chrome\\chrome.exe', true],
  [win32, '\\\\?\\C:\\Chrome\\chrome.exe', true],
  [win32, 'chrome.exe', false],
  [win32, '.\\chrome.exe', false],
  [win32, 'C:chrome.exe', false],
];
for (const [paths, executablePath, allowed] of cases) {
  test(`${paths === win32 ? 'Windows' : 'POSIX'} executable path ${allowed ? 'accepts' : 'rejects'} ${executablePath}`, () => {
    if (allowed) assert.equal(validateConfig({ executablePath }, paths).executablePath, executablePath);
    else assert.throws(() => validateConfig({ executablePath }, paths), /absolute path/);
  });
}
for (const mode of ['connect', 'auto', 'extension']) {
  test(`${mode} still refuses a valid custom Windows executable`, () => {
    assert.throws(() => validateConfig({ mode, ...(mode === 'connect' ? { url: 'http://127.0.0.1:9222' } : {}),
      executablePath: 'C:\\Chrome\\chrome.exe' }, win32), /Existing browser modes/);
  });
}
