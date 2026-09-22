import test from 'node:test';
import assert from 'node:assert/strict';
import { applyModelSelectionToConfig, buildModelSelection, resolveModelEffort } from '../packages/tui/src/models.ts';
import { pickModel } from '../plugins/providers/catalog.mjs';

const row = (provider, model, efforts, defaultEffort) => ({
  provider, providerName: provider, model, modelName: model,
  reasoning: { efforts: efforts.map(id => ({ id, name: id })), defaultEffort },
});
const deepseek = row('deepseek-official', 'deepseek-flash', ['off', 'low', 'high', 'max', 'ultra'], 'high');
const mimo = row('openrouter', 'xiaomi/mimo-v2-flash', ['off', 'low', 'medium', 'high'], 'high');

test('effort selection respects the target catalog, including defaults and models without reasoning', () => {
  assert.equal(resolveModelEffort(deepseek, 'medium'), 'high');
  assert.equal(resolveModelEffort(deepseek, 'max'), 'max');
  assert.equal(resolveModelEffort(deepseek, 'off'), 'off');
  assert.equal(resolveModelEffort(mimo, 'medium'), 'medium');
  assert.equal(resolveModelEffort(mimo, 'ultra'), 'high');
  assert.equal(resolveModelEffort(deepseek), 'high');
  assert.equal(resolveModelEffort(deepseek, ''), 'high');
  assert.equal(resolveModelEffort({ ...deepseek, reasoning: undefined }, 'medium'), undefined);
  assert.equal(resolveModelEffort(row('other', 'no-default', ['low', 'high']), 'medium'), undefined);
});

test('MiMo to DeepSeek clears medium from the request and displays the target default', () => {
  const pick = pickModel([deepseek, mimo], 'deepseek-official', `${mimo.provider}/${mimo.model}`, 'medium');
  const selection = buildModelSelection(pick.row, pick.effort);
  const request = applyModelSelectionToConfig({ provider: mimo.provider, model: mimo.model, reasoningEffort: 'medium' }, selection);
  assert.deepEqual(request, { provider: deepseek.provider, model: deepseek.model });
  assert.equal(resolveModelEffort(pick.row, pick.effort), 'high');
  assert.throws(() => buildModelSelection(deepseek, 'medium'), /does not support reasoning effort/);
});
