import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { maskEmail } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/mask-email.mjs")));
for (const [args, expected] of [[["a@x.io"],"a@x.io"],[["ab@x.io"],"a*@x.io"],[["@x.io"],null],[["x@"],null],[["x@@y"],null]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(maskEmail(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
