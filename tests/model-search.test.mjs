import test from 'node:test';
import assert from 'node:assert/strict';
import { dscodeFilterModels } from '../packages/tui/src/dscode/model-search.ts';

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
  assert.deepEqual(dscodeFilterModels(ROWS, '   ').map(entry => entry.model), [
    'deepseek-flash', 'deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'meta/muse-spark-1.3',
    'moonshotai/kimi-k2.6', 'qwen/qwen3.8-27b', 'z-ai/glm-5.2', 'z-ai/glm-5.3-flash',
  ], 'an empty search lists the whole directory alphabetically by displayed label');
});

test('search narrows to the matching rows, which stay in alphabetical order', () => {
  const partial = ids('muse flash');
  assert.deepEqual(partial, ['deepseek-flash', 'deepseek/deepseek-v4-flash', 'meta/muse-spark-1.3', 'z-ai/glm-5.3-flash'],
    'rows matching some words show only when none matches all, still alphabetical by label');
  assert.deepEqual(ids('glm'), ['z-ai/glm-5.2', 'z-ai/glm-5.3-flash'], 'the display label decides the order');
  const unordered = [row('p', 'P', 'a/y', 'Y'), row('p', 'P', 'a/x', 'X')];
  assert.deepEqual(dscodeFilterModels(unordered, 'a').map(entry => entry.model), ['a/x', 'a/y'], 'directory order is ignored');
});

test('the picker lists one provider, alphabetically, with natural digit order', () => {
  assert.deepEqual(dscodeFilterModels(ROWS, '', 'openrouter').map(entry => entry.model), [
    'deepseek/deepseek-v4-flash', 'meta/muse-spark-1.3', 'moonshotai/kimi-k2.6', 'qwen/qwen3.8-27b', 'z-ai/glm-5.2', 'z-ai/glm-5.3-flash',
  ], 'only the session provider, ordered by label (GLM 5.2 before GLM 5.3)');
  assert.deepEqual(ids('openrouter flash'), ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash']);
  assert.deepEqual(dscodeFilterModels(ROWS, 'deepseek', 'openrouter').map(entry => entry.model), ['deepseek/deepseek-v4-flash'],
    'a same-name model of another provider never leaks into the scoped list');
  assert.deepEqual(dscodeFilterModels(ROWS, '', undefined).length, ROWS.length, 'no provider means the whole directory');
});
