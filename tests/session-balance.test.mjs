import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBalance, parseOpenRouterKeyRemaining, refreshBalance, balanceNow, trustedNow } from '../plugins/session-metrics/balance.mjs';
import { isPeak, peakEmoji } from '../plugins/session-metrics/pricing.mjs';
import { formatFooter } from '../plugins/session-metrics/view.mjs';

test('peak window follows the UTC billing hours and marks the footer', () => {
  const at = value => Date.parse(value);
  assert.equal(isPeak(at('2026-09-14T02:00:00Z')), true, 'Monday 02:00 UTC is peak');
  assert.equal(isPeak(at('2026-09-14T07:30:00Z')), true, 'Monday 07:30 UTC is peak');
  assert.equal(isPeak(at('2026-09-14T00:30:00Z')), false, 'before the window is off-peak');
  assert.equal(isPeak(at('2026-09-14T04:30:00Z')), false, 'the gap between windows is off-peak');
  assert.equal(isPeak(at('2026-09-19T02:00:00Z')), false, 'weekend early hours are off-peak');
  assert.equal(peakEmoji(at('2026-09-14T02:00:00Z')), '🔥');
  assert.equal(peakEmoji(at('2026-09-14T12:00:00Z')), '❄️');
});

test('balance parses the USD entry and refuses unavailable accounts', () => {
  assert.equal(parseBalance({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.3456' }] }), 12.3456);
  assert.equal(parseBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '80.00' }] }), 80);
  assert.equal(parseBalance({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '3.00' }] }), null);
  assert.equal(parseBalance({}), null);
  assert.equal(parseBalance({ balance_infos: [{ currency: 'USD', total_balance: 'oops' }] }), null);
});

test('balance caches its answer and anchors the clock to the response Date header', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return {
      ok: true,
      headers: { get: name => (name === 'date' ? new Date(Date.now() + 90_000).toUTCString() : null) },
      json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '7.5' }] }),
    };
  };
  assert.equal(await refreshBalance({ key: 'k', fetch }), 7.5);
  assert.equal(balanceNow(), 7.5);
  assert(trustedNow() > Date.now() + 30_000, 'the trusted clock follows the response header');
  assert.equal(await refreshBalance({ key: 'k', fetch }), 7.5);
  assert.equal(calls, 1, 'the cache holds for the refresh window');
});

test('a transient failure keeps the last balance and retries sooner', async () => {
  const before = balanceNow();
  await refreshBalance({ key: 'k', fetch: async () => { throw new Error('offline'); } });
  assert.equal(balanceNow(), before, 'a failed refresh never blanks a known balance');
  assert.equal(await refreshBalance({ key: 'k', fetch: async () => { throw new Error('offline'); } }), before);
});

test('OpenRouter key limits are tracked apart from DeepSeek and the footer drops the peak marker', async () => {
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit: 20, limit_remaining: 12.75, usage: 7.25 } }), 12.75);
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit: 5, limit_remaining: -1, usage: 6 } }), 0);
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit: null, limit_remaining: null, usage: 3 } }), null, 'a key without a limit exposes no balance');
  assert.equal(parseOpenRouterKeyRemaining({ data: { limit_remaining: 'oops' } }), null);
  assert.equal(parseOpenRouterKeyRemaining({ data: {} }), null);
  assert.equal(parseOpenRouterKeyRemaining(null), null);
  const deepseek = balanceNow('deepseek-official');
  const urls = [];
  const fetch = async (url, init) => {
    urls.push([url, init.headers.Authorization]);
    return { ok: true, headers: { get: () => new Date(0).toUTCString() }, json: async () => ({ data: { total_credits: 10, total_usage: 2.5 } }) };
  };
  const clock = trustedNow() - Date.now();
  assert.equal(await refreshBalance({ provider: 'openrouter', key: 'synthetic-or', fetch }), 7.5);
  assert.deepEqual(urls, [['https://openrouter.ai/api/v1/credits', 'Bearer synthetic-or']]);
  assert.equal(balanceNow('openrouter'), 7.5);
  assert.equal(balanceNow('deepseek-official'), deepseek, 'providers keep separate balances');
  assert(Math.abs(trustedNow() - Date.now() - clock) < 1000, 'only DeepSeek anchors the billing clock');
  assert.equal(await refreshBalance({ provider: 'unknown', key: 'k', fetch }), null);
  const metrics = { cost: 0.01, unknown: false, pending: 0, cache: null };
  const line = formatFooter(metrics, 10, 200, undefined, 'en', 'openrouter: deepseek/deepseek-v4-flash @ high');
  assert.match(line, /\$0\.01 \/ \$7\.50 \| cache hit/);
  assert(!/🔥|❄️/.test(line), 'OpenRouter bills no peak window');
  assert.match(formatFooter(metrics, 10, 200, undefined, 'en', 'deepseek-official: deepseek-flash @ high'), /\$0\.01 \/ \$(?:--|\d+\.\d{2}) (?:🔥|❄️)/);
});
