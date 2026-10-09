import test from 'node:test';
import assert from 'node:assert/strict';
import { posix, win32 } from 'node:path';
import { withinFileRoot } from '../plugins/browser/files.mjs';

const cases = [
  [posix, '/work/project', '/work/project', true],
  [posix, '/work/project', '/work/project/nested/file.txt', true],
  [posix, '/work/project', '/work', false],
  [posix, '/work/project', '/work/secret.txt', false],
  [posix, '/work/project', '/work/project-copy/file.txt', false],
  // A backslash is a legal POSIX filename character, not a directory boundary.
  [posix, '/work/project', '/work/project/..\\notes.txt', true],
  [win32, 'C:\\work\\project', 'C:\\work\\project', true],
  [win32, 'C:\\work\\project', 'c:/WORK/project/nested/file.txt', true],
  [win32, 'C:\\work\\project', 'C:\\work', false],
  [win32, 'C:\\work\\project', 'C:\\work\\secret.txt', false],
  [win32, 'C:\\work\\project', 'C:\\work\\project-copy\\file.txt', false],
  [win32, 'C:\\work\\project', 'D:\\work\\project\\file.txt', false],
  [win32, '\\\\server\\share\\project', '\\\\server\\share\\project\\nested\\file.txt', true],
  [win32, '\\\\server\\share\\project', '\\\\server\\share\\private\\file.txt', false],
  [win32, '\\\\server\\share\\project', '\\\\server\\other\\project\\file.txt', false],
  [win32, '\\\\?\\C:\\work\\project', '\\\\?\\C:\\work\\private\\file.txt', false],
];
for (const [paths, root, target, allowed] of cases) {
  test(`${paths === win32 ? 'Windows' : 'POSIX'} file root ${allowed ? 'allows' : 'rejects'} ${target}`, () => {
    assert.equal(withinFileRoot(root, target, paths), allowed);
  });
}
