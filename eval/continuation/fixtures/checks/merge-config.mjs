import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { mergeConfig } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/merge-config.mjs")));
for (const [args, expected] of [[[{"a":1},{"a":null}],{"a":1}],[[{"a":true,"b":3},{"a":false,"b":0}],{"a":false,"b":0}],[[{},{"x":4}],{"x":4}]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(mergeConfig(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
