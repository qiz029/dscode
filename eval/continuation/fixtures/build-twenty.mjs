import { readFileSync, writeFileSync } from 'node:fs';
import { validateContinuationDataset } from '../fixture.mjs';

// Synthetic, self-contained coding tasks. The vectors below are evaluator-only:
// generated hidden checks stay outside each model-visible project workspace.
const root = new URL('./', import.meta.url);
const starter = JSON.parse(readFileSync(new URL('cases.json', root), 'utf8'));
const common = starter.cases[0].system;
const specs = [
  { id: 'normalize-slug', fn: 'slugify', params: 'value', pressure: .28,
    history: 'Implement slugify(value): lowercase an ASCII title, trim it, replace each run of non-ASCII-letter-or-digit characters with one hyphen, and remove edge hyphens. Return an empty string when nothing remains. Do not mutate input.', latest: 'Correction: repeated separators must collapse to one hyphen, including punctuation next to spaces.',
    visible: [[['Hello World'], 'hello-world']], hidden: [[['  A---B  '], 'a-b'], [['!!!'], ''], [['Hi, THERE!'], 'hi-there'], [['a__b'], 'a-b']] },
  { id: 'parse-port', fn: 'parsePort', params: 'value', pressure: .28,
    history: 'Implement parsePort(value): accept a string of decimal digits with optional surrounding whitespace, return its integer port when it is in 1..65535, otherwise null. Leading zeros are allowed. Reject signs, decimals and non-string inputs.', latest: 'Correction: zero is invalid even if written as 0000; 65535 is valid.',
    visible: [[[' 8080 '], 8080]], hidden: [[['0000'], null], [['65535'], 65535], [['65536'], null], [['+80'], null], [[80], null]] },
  { id: 'merge-ranges', fn: 'mergeRanges', params: 'ranges', pressure: .28,
    history: 'Implement mergeRanges(ranges) for inclusive integer [start,end] pairs. Return a new array sorted by start, merging overlapping ranges. Never mutate the input array or its pairs.', latest: 'Correction: adjacent inclusive ranges also merge: [1,2] and [3,5] become [1,5].',
    visible: [[[[[1, 3], [2, 5]]], [[1, 5]]]], hidden: [[[[[7, 8], [1, 2], [3, 5]]], [[1, 5], [7, 8]]], [[[]], []], [[[[1, 1], [2, 2]]], [[1, 2]]], [[[[1, 4], [9, 10]]], [[1, 4], [9, 10]]]] },
  { id: 'unique-tags', fn: 'normalizeTags', params: 'tags', pressure: .28,
    history: 'Implement normalizeTags(tags): trim and lowercase each string, drop empty results, deduplicate, and return a new array in first-seen order. Do not change the input array.', latest: 'Correction: deduplication happens after trimming and lowercasing, so " Foo " and "foo" are the same tag.',
    visible: [[[[ 'A', 'b' ]], ['a', 'b']]], hidden: [[[[ ' Foo ', 'foo', 'BAR', ' bar ' ]], ['foo', 'bar']], [[[ '', '  ', 'X' ]], ['x']], [[[]], []]] },
  { id: 'choose-backoff', fn: 'backoff', params: 'attempt, base, cap', pressure: .28,
    history: 'Implement backoff(attempt, base, cap) for nonnegative integer inputs: return base multiplied by 2 to the attempt power, capped at cap. Inputs are finite and no mutation is needed.', latest: 'Correction: the cap also applies at attempt zero; never return a value greater than cap.',
    visible: [[[2, 100, 1000], 400]], hidden: [[[0, 100, 50], 50], [[4, 100, 500], 500], [[0, 0, 10], 0], [[3, 7, 100], 56]] },
  { id: 'split-batches', fn: 'splitBatches', params: 'items, size', pressure: .45,
    history: 'Implement splitBatches(items, size): split an array into consecutive new arrays of at most positive integer size, keeping order and not mutating items.', latest: 'Correction: an empty items array returns [] rather than a single empty batch.',
    visible: [[[[1, 2, 3], 2], [[1, 2], [3]]]], hidden: [[[[], 3], []], [[[1, 2, 3, 4], 2], [[1, 2], [3, 4]]], [[[1], 5], [[1]]]] },
  { id: 'redact-token', fn: 'redactToken', params: 'text', pressure: .45,
    history: 'Implement redactToken(text): in a string, replace each lowercase token=<non-whitespace-value> occurrence with token=[REDACTED]. Leave other text untouched.', latest: 'Correction: redact every occurrence in the string, not just the first one.',
    visible: [[['token=abc'], 'token=[REDACTED]']], hidden: [[['x token=a y token=b'], 'x token=[REDACTED] y token=[REDACTED]'], [['TOKEN=abc'], 'TOKEN=abc'], [['no secret'], 'no secret']] },
  { id: 'parse-duration', fn: 'parseDuration', params: 'text', pressure: .45,
    history: 'Implement parseDuration(text): parse a trimmed nonnegative integer followed immediately by s, m, or h into milliseconds. Return null for invalid input. Units mean seconds, minutes and hours.', latest: 'Correction: zero is valid for every unit; do not treat 0s as missing.',
    visible: [[['2m'], 120000]], hidden: [[['0s'], 0], [[' 3h '], 10800000], [['4s'], 4000], [['-1m'], null], [['2d'], null]] },
  { id: 'sum-ledger', fn: 'netAmount', params: 'entries', pressure: .45,
    history: 'Implement netAmount(entries): entries have positive integer amount and status. Sum posted amounts and subtract refunded amounts; ignore pending entries. Do not mutate entries.', latest: 'Correction: a refunded entry subtracts its amount even when no matching posted entry appears in the same input.',
    visible: [[[[{ amount: 10, status: 'posted' }, { amount: 3, status: 'pending' }]], 10]], hidden: [[[[{ amount: 4, status: 'refunded' }]], -4], [[[{ amount: 10, status: 'posted' }, { amount: 3, status: 'refunded' }]], 7], [[[]], 0]] },
  { id: 'latest-by-key', fn: 'latestByKey', params: 'rows', pressure: .45,
    history: 'Implement latestByKey(rows): each row has key, integer revision and value. Return an object mapping each key to the value at its highest revision. Do not mutate rows.', latest: 'Correction: when revisions tie for a key, the later row in input order wins.',
    visible: [[[[{ key: 'a', revision: 1, value: 'old' }, { key: 'a', revision: 2, value: 'new' }]], { a: 'new' }]], hidden: [[[[{ key: 'x', revision: 3, value: 'first' }, { key: 'x', revision: 3, value: 'last' }]], { x: 'last' }], [[[{ key: 'a', revision: 2, value: 1 }, { key: 'b', revision: 1, value: 2 }]], { a: 1, b: 2 }], [[[]], {}]] },
  { id: 'compare-version', fn: 'compareVersion', params: 'a, b', pressure: .84,
    history: 'Implement compareVersion(a,b) for dotted nonnegative integer components. Compare numerically from left to right and return -1, 0 or 1. Missing components count as zero.', latest: 'Correction: trailing zero components do not change equality: 1.2 and 1.2.0 compare equal.',
    visible: [[['1.2', '1.10'], -1]], hidden: [[['1.2', '1.2.0'], 0], [['2.0', '1.99'], 1], [['0.9.1', '0.9.2'], -1], [['1', '1.0.0'], 0]] },
  { id: 'mask-email', fn: 'maskEmail', params: 'email', pressure: .84,
    history: 'Implement maskEmail(email): for a simple address with one @, nonempty local part and domain, keep the first local character and full domain, replace every later local character with *. Return null for malformed addresses.', latest: 'Correction: a one-character local part remains unchanged; do not add a star.',
    visible: [[['alice@example.com'], 'a****@example.com']], hidden: [[['a@x.io'], 'a@x.io'], [['ab@x.io'], 'a*@x.io'], [['@x.io'], null], [['x@'], null], [['x@@y'], null]] },
  { id: 'intersect-interval', fn: 'intersect', params: 'a, b', pressure: .84,
    history: 'Implement intersect(a,b) for half-open integer intervals [start,end). Return their intersection as a new two-element array, or null when empty. Do not mutate inputs.', latest: 'Correction: merely touching endpoints is empty, so [1,3) and [3,5) have no intersection.',
    visible: [[[[1, 5], [3, 7]], [3, 5]]], hidden: [[[[1, 3], [3, 5]], null], [[[0, 10], [2, 4]], [2, 4]], [[[5, 7], [1, 2]], null]] },
  { id: 'count-by-type', fn: 'countByType', params: 'events', pressure: .84,
    history: 'Implement countByType(events): return an object counting each nonempty string event.type. Ignore entries with missing or non-string types. Do not mutate events.', latest: 'Correction: an empty-string type is ignored rather than counted as a key.',
    visible: [[[[{ type: 'a' }, { type: 'a' }, { type: 'b' }]], { a: 2, b: 1 }]], hidden: [[[[{ type: '' }, { type: 'a' }]], { a: 1 }], [[[{ type: 3 }, {}, { type: 'x' }]], { x: 1 }], [[[]], {}]] },
  { id: 'merge-config', fn: 'mergeConfig', params: 'base, override', pressure: .84,
    history: 'Implement mergeConfig(base, override): return a new shallow-merged object without mutating either input. Override values replace base values, including false and zero.', latest: 'Correction: a null override means inherit the base value instead of replacing it; false and zero still replace.',
    visible: [[[ { a: 1 }, { a: 2 } ], { a: 2 }]], hidden: [[[ { a: 1 }, { a: null } ], { a: 1 }], [[{ a: true, b: 3 }, { a: false, b: 0 }], { a: false, b: 0 }], [[{}, { x: 4 }], { x: 4 }]] },
  { id: 'sort-priority', fn: 'sortByPriority', params: 'items', pressure: .84,
    history: 'Implement sortByPriority(items): return a new array sorted by descending numeric priority. Do not mutate the original array or its objects.', latest: 'Correction: sorting must be stable for equal priorities; keep their input order.',
    visible: [[[[{ id: 'a', priority: 1 }, { id: 'b', priority: 3 }]], [{ id: 'b', priority: 3 }, { id: 'a', priority: 1 }]]], hidden: [[[[{ id: 'a', priority: 2 }, { id: 'b', priority: 2 }, { id: 'c', priority: 1 }]], [{ id: 'a', priority: 2 }, { id: 'b', priority: 2 }, { id: 'c', priority: 1 }]], [[[]], []]] },
  { id: 'decode-query', fn: 'parseQuery', params: 'query', pressure: .84,
    history: 'Implement parseQuery(query): parse a URL query string (without ?) into an object of decoded key/value strings. Decode percent escapes and plus as space. When a key repeats, the last value wins.', latest: 'Correction: a key without = has an empty-string value; do not omit it.',
    visible: [[['a=1&b=2'], { a: '1', b: '2' }]], hidden: [[['x'], { x: '' }], [['a=one+two'], { a: 'one two' }], [['a=1&a=2'], { a: '2' }], [[''], {}]] },
];

const cases = specs.map(spec => {
  const path = `src/${spec.id}.mjs`;
  const visible = `import assert from 'node:assert/strict';\nimport { ${spec.fn} } from './${path}';\nfor (const [args, expected] of ${JSON.stringify(spec.visible)}) assert.deepStrictEqual(${spec.fn}(...structuredClone(args)), expected);\nconsole.log('visible checks passed');\n`;
  const hidden = `import assert from 'node:assert/strict';\nimport { pathToFileURL } from 'node:url';\nimport { join } from 'node:path';\nconst { ${spec.fn} } = await import(pathToFileURL(join(process.env.EVAL_WORKSPACE, ${JSON.stringify(path)})));\nfor (const [args, expected] of ${JSON.stringify(spec.hidden)}) { const input = structuredClone(args); const before = structuredClone(input); assert.deepStrictEqual(${spec.fn}(...input), expected); assert.deepStrictEqual(input, before); }\nconsole.log('hidden checks passed');\n`;
  writeFileSync(new URL(`checks/${spec.id}.mjs`, root), hidden);
  return { id: spec.id, system: common, history: spec.history + ` Edit only ${path}.`, latest: spec.latest + ' Finish and run the visible checks.', pressureRatio: spec.pressure,
    files: { [path]: `export function ${spec.fn}(${spec.params}) {\n  // TODO: complete this task.\n  return null;\n}\n`, 'visible.mjs': visible }, writable: [path] };
});

const dataset = { version: 1, id: 'coding-continuation-twenty-v1', cases: [...starter.cases, ...cases] };
validateContinuationDataset(dataset);
writeFileSync(new URL('cases-20.json', root), JSON.stringify(dataset, null, 2) + '\n');
console.log(`Generated ${dataset.cases.length} continuation cases.`);
