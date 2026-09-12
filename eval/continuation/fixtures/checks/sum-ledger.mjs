import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { netAmount } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/sum-ledger.mjs")));
for (const [args, expected] of [[[[{"amount":4,"status":"refunded"}]],-4],[[[{"amount":10,"status":"posted"},{"amount":3,"status":"refunded"}]],7],[[[]],0]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(netAmount(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
