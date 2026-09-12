import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { normalizeTags } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/unique-tags.mjs")));
for (const [args, expected] of [[[[" Foo ","foo","BAR"," bar "]],["foo","bar"]],[[["","  ","X"]],["x"]],[[[]],[]]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(normalizeTags(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
