import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { compareVersion } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/compare-version.mjs")));
for (const [args, expected] of [[["1.2","1.2.0"],0],[["2.0","1.99"],1],[["0.9.1","0.9.2"],-1],[["1","1.0.0"],0]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(compareVersion(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
