import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  MANAGEMENT_REF, OpenRouterAccountError, creditsOf, loadOpenRouterAccount, openRouterAccountLines, parseOpenRouterCredits, parseOpenRouterKeyRemaining,
  summarizeActivity, verifyManagementKey,
} from '../plugins/providers/openrouter-account.mjs';
import { PROVIDERS } from '../plugins/providers/catalog.mjs';
import { balanceNow, refreshBalance } from '../plugins/session-metrics/balance.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ACTIVITY = [
  { date: '2026-09-12', model: 'z-ai/glm-5.3-flash', provider_name: 'Relace', usage: 0.4, requests: 10, prompt_tokens: 1000, completion_tokens: 100, reasoning_tokens: 0 },
  { date: '2026-09-13', model: 'z-ai/glm-5.3-flash', provider_name: 'Z.AI', usage: 0.6, requests: 5 },
  { date: '2026-09-13', model: 'moonshotai/kimi-k2.6', provider_name: 'Inceptron', usage: 2.5, requests: 3 },
  { date: '2026-09-13', provider_name: 'nobody', usage: 9 },
];
const KEYS = [
  { hash: 'a', name: 'dscode', label: 'sk-or-v1-abc...xyz', disabled: false, limit: null, limit_remaining: null, usage_daily: 0.25, usage_weekly: 1, usage_monthly: 3.5 },
  { hash: 'b', name: 'ci', label: 'sk-or-v1-def...uvw', disabled: true, limit: 10, limit_remaining: 4, usage_daily: 0, usage_weekly: 0, usage_monthly: 6 },
];

test('account bodies parse into balances, limits and 30-day spend by model and provider', () => {
  assert.deepEqual(creditsOf({ data: { total_credits: 20, total_usage: 7.25 } }), { total: 20, used: 7.25, remaining: 12.75 });
  assert.equal(parseOpenRouterCredits({ data: { total_credits: 5, total_usage: 9 } }), 0);
  assert.equal(parseOpenRouterCredits({ data: {} }), null);
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit_remaining: 3.5 } }), 3.5);
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit_remaining: null } }), null);
  const activity = summarizeActivity(ACTIVITY);
  assert.equal(activity.usage, 3.5);
  assert.equal(activity.requests, 18);
  assert.equal(activity.days, 2);
  assert.deepEqual(activity.models.map(model => model.model), ['moonshotai/kimi-k2.6', 'z-ai/glm-5.3-flash'], 'ranked by spend; rows without a model are skipped');
  assert.deepEqual(activity.models[1].providers.map(provider => [provider.name, provider.requests]), [['Z.AI', 5], ['Relace', 10]]);
  assert.equal(MANAGEMENT_REF, 'OPENROUTER_MANAGEMENT_KEY');
  assert.equal(PROVIDERS.find(provider => provider.id === 'openrouter').managementRef, MANAGEMENT_REF, 'the credentials store shares the management key across projects');
});

test('the account loads each section with the key it needs and keeps failures to their section', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push([path, init.headers.authorization]);
    if (path === '/api/v1/key') return json({ data: { label: 'sk-or-v1-abc...xyz', limit: null, limit_remaining: null, usage_daily: 0.25, usage_weekly: 1, usage_monthly: 3.5 } });
    if (path === '/api/v1/credits') return json({ data: { total_credits: 50, total_usage: 12.5 } });
    if (path === '/api/v1/keys') return json({ data: KEYS });
    return json({ error: { code: 500, message: 'activity is down' } }, 500);
  };
  const full = await loadOpenRouterAccount({ apiKey: 'sk-or-inference', managementKey: 'sk-or-management', fetch });
  assert.deepEqual(calls.sort(), [['/api/v1/activity', 'Bearer sk-or-management'], ['/api/v1/credits', 'Bearer sk-or-management'], ['/api/v1/key', 'Bearer sk-or-inference'], ['/api/v1/keys', 'Bearer sk-or-management']]);
  assert(!openRouterAccountLines(full).some(line => line.text.includes('press m')), 'with a management key nothing asks for one');
  assert.deepEqual(full.credits.value, { total: 50, used: 12.5, remaining: 37.5 });
  assert.equal(full.keys.value.length, 2);
  assert.equal(full.activity.error, 'activity is down');
  const text = openRouterAccountLines(full).map(line => line.text);
  assert.equal(text[0], 'Account balance  $37.50 · credits $50.00 · used $12.50');
  assert.equal(text[1], 'This key  sk-or-v1-abc...xyz · no limit');
  assert.equal(text[2], '  today $0.25 · week $1.00 · month $3.50');
  assert.equal(text[3], 'API keys (2)');
  assert.equal(text[4], '  ci · disabled · today $0.00 · month $6.00 · limit $10.00, $4.00 left', 'keys rank by this month');
  assert.equal(text[5], '  dscode (this key) · today $0.25 · month $3.50 · no limit');
  assert.equal(text[6], 'Activity unavailable: activity is down');
  calls.length = 0;
  const inferenceOnly = await loadOpenRouterAccount({ apiKey: 'sk-or-inference', fetch });
  assert.deepEqual(calls.sort(), [['/api/v1/credits', 'Bearer sk-or-inference'], ['/api/v1/key', 'Bearer sk-or-inference']], 'the inference key reads the account credits and itself');
  const inferenceLines = openRouterAccountLines(inferenceOnly);
  assert.equal(inferenceLines[0].text, 'Account balance  $37.50 · credits $50.00 · used $12.50');
  assert.deepEqual(inferenceLines.at(-1), { text: 'API keys and 30-day spend  press m to add a management key', tone: 'dim' });
  assert.equal(openRouterAccountLines({ hasApiKey: true, hasManagementKey: false })[0].text, 'Account balance  $--');
  const withActivity = openRouterAccountLines({ hasApiKey: false, hasManagementKey: true, activity: { value: summarizeActivity(ACTIVITY) } }).map(line => line.text);
  assert.equal(withActivity[0], 'No OpenRouter API key: run /login openrouter.');
  assert(withActivity.includes('Last 30 days  $3.50 · 18 requests · 2 models'));
  assert(withActivity.includes('  z-ai/glm-5.3-flash · $1.00 · 15 req · Z.AI $0.60, Relace $0.40'), 'the providers that served a model are shown');
  const many = openRouterAccountLines({ hasApiKey: true, keys: { value: Array.from({ length: 7 }, (_, index) => ({ name: 'k' + index })) } }, { maxKeys: 5 }).map(line => line.text);
  assert.equal(many.at(-1), '  +2 more');
});

test('only a management key is accepted as one', async () => {
  const paths = [];
  await verifyManagementKey('sk-or-management', { fetch: async url => { paths.push(new URL(url).pathname); return json({ data: [] }); } });
  assert.deepEqual(paths, ['/api/v1/activity'], 'account activity is the reading OpenRouter refuses an inference key; /credits serves both');
  await assert.rejects(verifyManagementKey('sk-or-inference', { fetch: async () => json({ error: { code: 403, message: 'Only management keys can fetch activity for an account' } }, 403) }),
    error => error instanceof OpenRouterAccountError && /not a management key/.test(error.message));
  await assert.rejects(verifyManagementKey('sk-or-management', { fetch: async () => { throw new TypeError('fetch failed'); } }), /unreachable/);
});

test('the OpenRouter footer balance is the account credits, and a key refused them shows its own remaining limit', async () => {
  const urls = [];
  const fetch = async (url, init) => {
    const auth = init.headers.Authorization;
    urls.push([url, auth]);
    if (url.endsWith('/credits')) return auth === 'Bearer sk-or-limited' ? json({ error: { code: 403, message: 'refused' } }, 403) : json({ data: { total_credits: 30, total_usage: 10 } });
    return json({ data: { limit_remaining: 2 } });
  };
  assert.equal(await refreshBalance({ provider: 'openrouter', key: 'sk-or-limited', fetch }), 2, 'a refusal falls back to the key limit');
  assert.deepEqual(urls, [['https://openrouter.ai/api/v1/credits', 'Bearer sk-or-limited'], ['https://openrouter.ai/api/v1/key', 'Bearer sk-or-limited']]);
  urls.length = 0;
  assert.equal(await refreshBalance({ provider: 'openrouter', key: 'sk-or-limited', managementKey: 'sk-or-management', fetch }), 20, 'a newly added management key is read without waiting for the cache');
  assert.deepEqual(urls, [['https://openrouter.ai/api/v1/credits', 'Bearer sk-or-management']]);
  assert.equal(balanceNow('openrouter'), 20);
  assert.equal(await refreshBalance({ provider: 'openrouter', key: 'sk-or-limited', managementKey: 'sk-or-management', fetch }), 20);
  assert.equal(urls.length, 1, 'the same source stays cached');
});

