import test from 'node:test';
import assert from 'node:assert/strict';
import { dscodeFilterModels, patchModelSearch } from '../scripts/patch-model-search.mjs';

const row = (provider, providerName, model, modelName) => ({ provider, providerName, model, modelName });
const ROWS = [
  row('deepseek-official', 'DeepSeek', 'deepseek-flash', 'DeepSeek Flash'),
  row('deepseek-official', 'DeepSeek', 'deepseek-v4-pro', 'DeepSeek V4 Pro'),
  row('openrouter', 'OpenRouter', 'deepseek/deepseek-v4-flash', 'DeepSeek: DeepSeek V4 Flash'),
  row('openrouter', 'OpenRouter', 'moonshotai/kimi-k2.6', 'MoonshotAI: Kimi K2.6'),
  row('openrouter', 'OpenRouter', 'z-ai/glm-5.3-flash', 'Z.ai: GLM 5.3 Flash'),
  row('openrouter', 'OpenRouter', 'z-ai/glm-5.2', 'Z.ai: GLM 5.2'),
  row('openrouter', 'OpenRouter', 'qwen/qwen3.8-27b', 'Qwen: Qwen3.8 27B'),
  row('openrouter', 'OpenRouter', 'meta/muse-spark-1.3', 'Meta: Muse Spark 1.3'),
];
const ids = query => dscodeFilterModels(ROWS, query).map(entry => entry.model);
const sorted = values => [...values].sort();

test('every keystroke searches, matching the word being typed as a prefix', () => {
  assert.deepEqual(ids('k'), ['moonshotai/kimi-k2.6'], 'one character already narrows the list');
  assert.deepEqual(ids('kim'), ['moonshotai/kimi-k2.6']);
  assert.deepEqual(ids('kim '), [], 'a finished word must match a whole token');
  assert.deepEqual(sorted(ids('glm5')), ['z-ai/glm-5.2', 'z-ai/glm-5.3-flash'], 'letters and digits split into tokens');
  assert.deepEqual(ids('glm 5.3'), ['z-ai/glm-5.3-flash']);
  assert.deepEqual(sorted(ids('deepseek fl')), ['deepseek-flash', 'deepseek/deepseek-v4-flash']);
  assert.deepEqual(sorted(ids('openrouter flash')), ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash'], 'the provider narrows too');
  assert.equal(dscodeFilterModels(ROWS, '   '), ROWS, 'an empty search keeps the directory');
});

test('results rank by BM25, and rows matching some words show only when none matches all', () => {
  const partial = ids('muse flash');
  assert.equal(partial[0], 'meta/muse-spark-1.3', 'the rarer word ranks its row first');
  assert.deepEqual(sorted(partial), ['deepseek-flash', 'deepseek/deepseek-v4-flash', 'meta/muse-spark-1.3', 'z-ai/glm-5.3-flash']);
  assert.equal(ids('glm')[0], 'z-ai/glm-5.2', 'a shorter entry with the same match ranks higher');
  const ties = [row('p', 'P', 'a/x', 'X'), row('p', 'P', 'a/y', 'Y')];
  assert.deepEqual(dscodeFilterModels(ties, 'a').map(entry => entry.model), ['a/x', 'a/y'], 'ties keep directory order');
});

test('an install on an earlier search patch upgrades to type-to-search in place', () => {
  const panel = 'function ModelPanel({ directory }) {\n\tconst [dscodeSearching] = useState(false);\n\treturn null;\n}\n';
  const v1 = '// dscode-model-search-v1\nimport x from "y";\nfunction dscodeFilterModels(rows, query) {\n  return rows;\n}\n' + panel + 'function After() {}\n';
  const upgraded = patchModelSearch(v1);
  assert(upgraded.startsWith('// dscode-model-search-v3\n'));
  assert(upgraded.includes('idf'), 'the injected search is the BM25 source');
  assert(upgraded.includes('setDscodeFocused') && !upgraded.includes('dscodeSearching'), 'the whole panel is replaced');
  assert(upgraded.endsWith('\nfunction After() {}\n'), 'the code after the panel is kept');
  assert.equal(patchModelSearch(upgraded), upgraded);
  const v2 = v1.replace('dscode-model-search-v1', 'dscode-model-search-v2');
  assert.equal(patchModelSearch(v2), upgraded, 'v1 and v2 end identical');
  assert.throws(() => patchModelSearch('// dscode-model-search-v3\nno panel here'), /drift/);
});
