import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { redactToken } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, "src/redact-token.mjs")));
for (const [args, expected] of [[["x token=a y token=b"],"x token=[REDACTED] y token=[REDACTED]"],[["TOKEN=abc"],"TOKEN=abc"],[["no secret"],"no secret"]]) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(redactToken(...input), expected); assert.deepStrictEqual(input, before); }
console.log('hidden checks passed');
