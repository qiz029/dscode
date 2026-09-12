import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage } from '../usage.mjs';

test('DeepSeek prompt usage includes cached and uncached input', () => {
  assert.deepEqual(summarizeUsage([
    { usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 10 } },
    { usage: { inputTokens: 25, cacheReadTokens: 90, outputTokens: 5 } },
    { usage: null },
  ]), {
    calls: 3,
    callsWithUsage: 2,
    callsMissingUsage: 1,
    uncachedInputTokens: 125,
    cacheReadTokens: 90,
    inputTokensIncludingCache: 215,
    outputTokens: 15,
    peakPromptTokensIncludingCache: 115,
  });
});
