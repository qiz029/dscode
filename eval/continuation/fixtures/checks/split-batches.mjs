import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { splitBatches } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/split-batches.mjs")));
for (const [args, expected] of [[[[],3],[]],[[[1,2,3,4],2],[[1,2],[3,4]]],[[[1],5],[[1]]]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(splitBatches(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
