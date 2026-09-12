import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { slugify } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/normalize-slug.mjs")));
for (const [args, expected] of [[["  A---B  "],"a-b"],[["!!!"],""],[["Hi, THERE!"],"hi-there"],[["a__b"],"a-b"]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(slugify(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
