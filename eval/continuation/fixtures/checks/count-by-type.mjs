import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { countByType } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/count-by-type.mjs")));
for (const [args, expected] of [[[[{"type":""},{"type":"a"}]],{"a":1}],[[[{"type":3},{},{"type":"x"}]],{"x":1}],[[[]],{}]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(countByType(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
