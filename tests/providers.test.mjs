import test from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '@deepseek-ai/dsh-llm-pi-ai';
import {
  PROVIDERS, OPENROUTER_MODELS, openRouterProfile, providerArgument, splitModelLabel, providerOfLabel, providerOfHeader,
  pickModel, credentialState, ensureProviderRoute, waitForModels,
} from '../plugins/providers/catalog.mjs';

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
  assert.deepEqual(PROVIDERS.map(provider => provider.credentialRef), ['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY']);
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

test('the OpenRouter profile is a valid pi-ai route that narrows the catalog to DeepSeek', () => {
  const profile = openRouterProfile();
  assert.equal(profile.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.deepEqual(profile.models.map(model => model.id), OPENROUTER_MODELS.map(model => model.id));
  for (const model of profile.models) assert.deepEqual(model.reasoningEfforts, { off: 'none', low: 'high', high: 'high', max: 'xhigh' });
  assert.doesNotThrow(() => Config({ providers: { openrouter: profile } }));
  profile.models[0].reasoningEfforts.max = 'changed';
  assert.equal(openRouterProfile().models[0].reasoningEfforts.max, 'xhigh', 'each call returns a fresh profile');
});

test('the OpenRouter route is declared once and a user profile is never overwritten', async () => {
  const writes = [];
  const settings = (value, extra = {}) => ({
    writable: true, ...extra,
    describe: () => [{ ns: 'llm-deepseek', value: {}, revision: 1 }, ...(value === undefined ? [] : [{ ns: 'llm-pi-ai', value, revision: 7 }])],
    mutate: async (...args) => { writes.push(args); },
  });
  assert.equal(await ensureProviderRoute(settings({}), 'deepseek-official'), false);
  assert.equal(await ensureProviderRoute(settings({ providers: {} }), 'openrouter'), true);
  assert.deepEqual(writes, [['llm-pi-ai', [{ op: 'set', path: ['providers', 'openrouter'], value: openRouterProfile() }], 7]]);
  assert.equal(await ensureProviderRoute(settings({ providers: { openrouter: { models: [{ id: 'mine' }] } } }), 'openrouter'), false);
  assert.equal(writes.length, 1);
  await assert.rejects(ensureProviderRoute(settings(undefined), 'openrouter'), /not mounted/);
  await assert.rejects(ensureProviderRoute(settings({}, { writable: false }), 'openrouter'), /read-only/);
  await assert.rejects(ensureProviderRoute(undefined, 'openrouter'), /unavailable/);
});

test('a new route is awaited until its models reach the directory', async () => {
  let calls = 0;
  const loadModels = async () => ({ rows: ++calls < 3 ? rows.slice(0, 2) : rows });
  const directory = await waitForModels(loadModels, 'openrouter', { delayMs: 1 });
  assert.equal(calls, 3);
  assert(directory.rows.some(row => row.provider === 'openrouter'));
  calls = -100;
  const gaveUp = await waitForModels(async () => ({ rows: [] }), 'openrouter', { attempts: 2, delayMs: 1 });
  assert.deepEqual(gaveUp.rows, []);
});
