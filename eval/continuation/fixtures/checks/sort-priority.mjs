import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { sortByPriority } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/sort-priority.mjs")));
for (const [args, expected] of [[[[{"id":"a","priority":2},{"id":"b","priority":2},{"id":"c","priority":1}]],[{"id":"a","priority":2},{"id":"b","priority":2},{"id":"c","priority":1}]],[[[]],[]]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(sortByPriority(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
