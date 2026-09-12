import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { parsePort } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/parse-port.mjs")));
for (const [args, expected] of [[["0000"],null],[["65535"],65535],[["65536"],null],[["+80"],null],[[80],null]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(parsePort(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
