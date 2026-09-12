import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { pageWindow } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/paging.mjs')));
assert.deepEqual(pageWindow(10, 2, 0), { start: 2, end: 2, nextOffset: null });
assert.deepEqual(pageWindow(10, 8, 10), { start: 8, end: 10, nextOffset: null });
assert.deepEqual(pageWindow(10, 20, 3), { start: 10, end: 10, nextOffset: null });
assert.deepEqual(pageWindow(10, 0, 3), { start: 0, end: 3, nextOffset: 3 });
assert.deepEqual(pageWindow(0, 0, 4), { start: 0, end: 0, nextOffset: null });
console.log('hidden checks passed');
