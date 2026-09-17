import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS, OPENROUTER_EFFORTS, providerArgument, splitModelLabel, providerOfLabel, providerOfHeader,
  pickModel, credentialState, ensureProviderRoute, waitForModels, migrateOpenRouterProfile,
} from '../plugins/providers/catalog.mjs';
import { EFFORT_LEVELS, chooseEffort, effortFor } from '../plugins/providers/effort.mjs';

test('auxiliary calls get the nearest effort a model offers, or none when it offers no levels', async () => {
  const deepseek = ['off', 'low', 'high', 'max', 'ultra'], gpt = ['minimal', 'low', 'medium', 'high'];
  assert.deepEqual(EFFORT_LEVELS, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(chooseEffort(deepseek, 'low'), 'low');
  assert.equal(chooseEffort(['off', 'high'], 'low'), 'high', 'the nearest level above');
  assert.equal(chooseEffort(gpt, 'max'), 'high', 'else the highest below');
  assert.equal(chooseEffort(['off'], 'low'), undefined, 'a model without levels gets no effort');
  assert.equal(chooseEffort([], 'high'), undefined);
  assert.equal(chooseEffort(gpt, 'ultra'), undefined, 'Ultra is not a level to approximate');
  assert.equal(chooseEffort(undefined, 'low'), 'low', 'an unknown capability keeps the request');
  assert.equal(chooseEffort(deepseek, undefined), undefined);
  const service = { async resolveModelInfo(provider, model) {
    const models = { 'openai/gpt-5': gpt, 'qwen/qwen3-coder': null };
    if (!(model in models)) throw Error('unknown model');
    return { provider, id: model, name: model, ...(models[model] ? { reasoning: { efforts: models[model].map(id => ({ id })) } } : {}) };
  } };
  assert.equal(await effortFor(service, { provider: 'openrouter', model: 'openai/gpt-5' }, 'max'), 'high');
  assert.equal(await effortFor(service, { provider: 'openrouter', model: 'qwen/qwen3-coder' }, 'low'), undefined);
  assert.equal(await effortFor(service, { provider: 'openrouter', model: 'missing' }, 'low'), 'low', 'a failed lookup keeps the request');
  assert.equal(await effortFor({}, { provider: 'openrouter', model: 'openai/gpt-5' }, 'low'), 'low', 'no model metadata keeps the request');
});

const efforts = ids => ({ efforts: ids.map(id => ({ id })), defaultEffort: 'high' });
const ladder = efforts(['off', 'low', 'high', 'max', 'ultra']);
const rows = [
  { provider: 'deepseek-official', model: 'deepseek-flash', reasoning: ladder },
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoning: ladder },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoning: ladder },
  { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', reasoning: efforts(['off', 'high']) },
];

test('command arguments name a provider or are refused without interpretation', () => {
  assert.equal(providerArgument(''), undefined);
  assert.equal(providerArgument('   '), undefined);
  assert.equal(providerArgument(' OpenRouter '), 'openrouter');
  assert.equal(providerArgument('deepseek'), 'deepseek-official');
  assert.equal(providerArgument('deepseek-official'), 'deepseek-official');
  assert.equal(providerArgument('sk-or-v1-synthetic'), null);
  assert.deepEqual(PROVIDERS.map(provider => provider.credentialRef), ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'GROK_CLI_TOKEN']);
});

test('labels split at the first slash so OpenRouter model ids keep their vendor', () => {
  assert.deepEqual(splitModelLabel('openrouter/deepseek/deepseek-v4-flash'), { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(splitModelLabel('deepseek-flash'), { provider: '', model: 'deepseek-flash' });
  assert.equal(providerOfLabel('openrouter/deepseek/deepseek-v4-pro'), 'openrouter');
  assert.equal(providerOfLabel('anthropic/claude'), 'deepseek-official');
  assert.equal(providerOfHeader('openrouter: deepseek/deepseek-v4-flash @ high'), 'openrouter');
  assert.equal(providerOfHeader('deepseek-flash @ high'), undefined);
});

test('a switch lands on the counterpart model and keeps an effort the target offers', () => {
  const pick = (provider, label, effort) => { const result = pickModel(rows, provider, label, effort); return result && `${result.row.provider}/${result.row.model}@${result.effort}`; };
  assert.equal(pick('openrouter', 'deepseek-official/deepseek-flash', 'ultra'), 'openrouter/deepseek/deepseek-v4-flash@ultra');
  assert.equal(pick('openrouter', 'deepseek-official/deepseek-v4-pro', 'ultra'), 'openrouter/deepseek/deepseek-v4-pro@undefined', 'an unoffered effort falls back to the model default');
  assert.equal(pick('deepseek-official', 'openrouter/deepseek/deepseek-v4-pro', 'high'), 'deepseek-official/deepseek-v4-pro@high');
  assert.equal(pick('deepseek-official', 'openrouter/deepseek/deepseek-v4-flash', 'max'), 'deepseek-official/deepseek-flash@max');
  assert.equal(pick('openrouter', 'custom/some-model', 'low'), 'openrouter/deepseek/deepseek-v4-flash@low', 'unknown models land on the default');
  assert.equal(pick('openrouter', 'openrouter/deepseek/deepseek-v4-pro', 'off'), 'openrouter/deepseek/deepseek-v4-pro@off');
  assert.equal(pickModel(rows.slice(0, 2), 'openrouter', 'deepseek-official/deepseek-flash', 'high'), undefined);
  assert.equal(pick('openrouter', 'deepseek-official/deepseek-flash'), 'openrouter/deepseek/deepseek-v4-flash@undefined');
});

test('credential state distinguishes saved, environment, missing and unreadable keys', () => {
  const facts = extra => ({ credential: { kind: 'facts', ...extra } });
  assert.equal(credentialState(undefined), 'unavailable');
  assert.equal(credentialState({}), 'missing');
  assert.equal(credentialState(facts({ configured: true, writable: true, source: 'file' })), 'saved');
  assert.equal(credentialState(facts({ configured: true, writable: false, source: 'env' })), 'env');
  assert.equal(credentialState(facts({ configured: false, writable: true })), 'missing');
  assert.equal(credentialState(facts({ configured: false, writable: false })), 'readonly');
  assert.equal(credentialState({ credential: { kind: 'error', message: 'denied' } }), 'error');
});

test('DeepSeek V4 on OpenRouter keeps the official detents in the wire spelling OpenRouter accepts', () => {
  assert.deepEqual(OPENROUTER_EFFORTS, { off: 'none', low: 'high', high: 'high', max: 'xhigh' });
});

test('switching to OpenRouter clears the inert pi-ai profile earlier builds wrote, and nothing else', async () => {
  const writes = [];
  const settings = (value, extra = {}) => ({
    writable: true, ...extra,
    describe: () => [{ ns: 'llm-deepseek', value: {}, revision: 1 }, ...(value === undefined ? [] : [{ ns: 'llm-pi-ai', value, revision: 7 }])],
    mutate: async (...args) => { writes.push(args); },
  });
  assert.equal(await ensureProviderRoute(settings({ providers: { openrouter: { displayName: 'OpenRouter' } } }), 'deepseek-official'), false);
  assert.equal(await ensureProviderRoute(settings({ providers: { openrouter: { displayName: 'OpenRouter' } } }), 'openrouter'), true);
  assert.deepEqual(writes, [['llm-pi-ai', [{ op: 'unset', path: ['providers', 'openrouter'] }], 7]]);
  assert.equal(await ensureProviderRoute(settings({ providers: { other: {} } }), 'openrouter'), false, 'other pi-ai providers are left alone');
  assert.equal(await ensureProviderRoute(settings(undefined), 'openrouter'), false, 'without the pi-ai section there is nothing to clear');
  assert.equal(await migrateOpenRouterProfile(settings({ providers: { openrouter: {} } }, { writable: false })), false);
  assert.equal(await migrateOpenRouterProfile(undefined), false, 'a profile without settings still opens /model');
  assert.equal(await migrateOpenRouterProfile({ writable: true, describe: () => { throw new Error('boom'); } }), false);
  assert.equal(await ensureProviderRoute(undefined, 'openrouter'), false);
  assert.equal(writes.length, 1);
});

test('a route is awaited until its models reach the directory', async () => {
  let calls = 0;
  const loadModels = async () => ({ rows: ++calls < 3 ? rows.slice(0, 2) : rows });
  const directory = await waitForModels(loadModels, 'openrouter', { delayMs: 1 });
  assert.equal(calls, 3);
  assert(directory.rows.some(row => row.provider === 'openrouter'));
  calls = -100;
  const gaveUp = await waitForModels(async () => ({ rows: [] }), 'openrouter', { attempts: 2, delayMs: 1 });
  assert.deepEqual(gaveUp.rows, []);
});
