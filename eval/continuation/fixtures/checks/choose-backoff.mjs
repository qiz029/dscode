import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { backoff } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/choose-backoff.mjs")));
for (const [args, expected] of [[[0,100,50],50],[[4,100,500],500],[[0,0,10],0],[[3,7,100],56]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(backoff(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
