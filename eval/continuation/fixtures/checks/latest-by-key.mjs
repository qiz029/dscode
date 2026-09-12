import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { latestByKey } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/latest-by-key.mjs")));
for (const [args, expected] of [[[[{"key":"x","revision":3,"value":"first"},{"key":"x","revision":3,"value":"last"}]],{"x":"last"}],[[[{"key":"a","revision":2,"value":1},{"key":"b","revision":1,"value":2}]],{"a":1,"b":2}],[[[]],{}]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(latestByKey(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
