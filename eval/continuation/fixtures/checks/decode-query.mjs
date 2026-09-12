import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { parseQuery } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/decode-query.mjs")));
for (const [args, expected] of [[["x"],{"x":""}],[["a=one+two"],{"a":"one two"}],[["a=1&a=2"],{"a":"2"}],[[""],{}]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(parseQuery(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
