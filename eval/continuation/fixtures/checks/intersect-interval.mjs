import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { intersect } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/intersect-interval.mjs")));
for (const [args, expected] of [[[[1,3],[3,5]],null],[[[0,10],[2,4]],[2,4]],[[[5,7],[1,2]],null]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(intersect(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
