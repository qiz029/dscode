import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const { parseRetryAfter } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, 'src/retry.mjs')));
assert.equal(parseRetryAfter(' 0 ', 0), 0);
assert.equal(parseRetryAfter(' 12 ', 0), 12000);
assert.equal(parseRetryAfter('Fri, 01 Jan 2027 00:00:10 GMT', Date.UTC(2027, 0, 1, 0, 0, 0)), 10000);
assert.equal(parseRetryAfter('Fri, 01 Jan 2027 00:00:00 GMT', Date.UTC(2027, 0, 1, 0, 0, 10)), 0);
assert.equal(parseRetryAfter('-2', 0), null);
assert.equal(parseRetryAfter(null, 0), null);
console.log('hidden checks passed');
