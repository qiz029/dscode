import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { parseDuration } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/parse-duration.mjs")));
for (const [args, expected] of [[["0s"],0],[[" 3h "],10800000],[["4s"],4000],[["-1m"],null],[["2d"],null]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(parseDuration(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
