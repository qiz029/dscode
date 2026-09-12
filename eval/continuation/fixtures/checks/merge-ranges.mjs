import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { mergeRanges } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/merge-ranges.mjs")));
for (const [args, expected] of [[[[[7,8],[1,2],[3,5]]],[[1,5],[7,8]]],[[[]],[]],[[[[1,1],[2,2]]],[[1,2]]],[[[[1,4],[9,10]]],[[1,4],[9,10]]]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(mergeRanges(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
