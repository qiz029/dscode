import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '../plugins/credentials/index.mjs';
import * as MiniMax from '../plugins/minimax/index.mjs';
import { MiniMaxAdapter } from '../plugins/minimax/adapter.mjs';
import { MODELS, getModel } from '../plugins/minimax/models.mjs';
import { requestBody } from '../plugins/minimax/wire.mjs';
import { providerArgument, pickModel } from '../plugins/providers/catalog.mjs';
import { loadModelDirectory } from '../packages/tui/src/models.ts';
import { cacheReadRatio, estimateCost, priceVersionFor } from '../plugins/session-metrics/pricing.mjs';

const user = text => ({ role: 'user', content: [{ type: 'text', text }] });
const base = { provider: 'minimax', model: 'MiniMax-M3.1-Flash', messages: [user('hello')] };
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const events = content => [
  { type: 'message_start', message: { id: 'msg_test', usage: { input_tokens: 7, cache_read_input_tokens: 11 } } },
  ...content.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 17 } },
  { type: 'message_stop' },
];
const adapter = fetch => new MiniMaxAdapter({ options: () => MiniMax.resolveOptions(), resolveApiKey: async () => 'synthetic-key', fetch });

test('MiniMax catalog exposes both direct models and selects M3.1 Flash by default', async () => {
  const instance = adapter(() => { throw Error('catalog must not fetch'); });
  assert.equal(providerArgument(' MiniMax '), 'minimax');
  assert.equal(providerArgument('mini-max'), 'minimax');
  assert.deepEqual((await instance.listModels('minimax')).map(model => model.id), ['MiniMax-M3.1-Flash', 'MiniMax-M3']);
  for (const model of MODELS) {
    const info = await instance.resolveModel('minimax', model.id);
    assert.equal(info.context.contextWindow, 1_000_000);
    assert.equal(info.defaultMaxTokens, 131_072);
    assert.deepEqual(info.inputModalities, ['text', 'image', 'video']);
  }
  assert.deepEqual((await instance.resolveModel('minimax', base.model)).reasoning.efforts.map(effort => effort.id), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal((await instance.resolveModel('minimax', 'MiniMax-M3')).reasoning, undefined);
  const rows = MODELS.toReversed().map(model => ({ provider: 'minimax', model: model.id }));
  assert.equal(pickModel(rows, 'minimax', 'missing/model').row.model, base.model);
  await assert.rejects(instance.resolveModel('minimax', 'unknown'), /Unknown/);
});

test('MiniMax request bodies apply each model thinking policy and output limit', () => {
  const flash = requestBody(base, getModel(base.model), undefined, 'account');
  assert.deepEqual(flash.thinking, { type: 'adaptive' });
  assert.deepEqual(flash.output_config, { effort: 'max' });
  assert.equal(flash.max_tokens, 131_072);
  const m3 = requestBody({ ...base, model: 'MiniMax-M3' }, getModel('MiniMax-M3'), undefined, 'account');
  assert.equal(m3.thinking, undefined);
  assert.equal(m3.output_config, undefined);
  assert.equal(m3.service_tier, 'standard');
  assert.equal(requestBody({ ...base, model: 'MiniMax-M3' }, getModel('MiniMax-M3'), undefined, 'account', 'priority').service_tier, 'priority');
  assert.equal(flash.service_tier, undefined);
  assert.throws(() => requestBody({ ...base, reasoningEffort: 'off' }, getModel(base.model)), /effort/);
  assert.throws(() => requestBody({ ...base, maxTokens: 524_289 }, getModel(base.model)), /budget/);
});

test('MiniMax streams the direct endpoint with bearer auth and preserves usage', async () => {
  const instance = adapter(async (url, init) => {
    assert.equal(url, 'https://api.minimax.io/anthropic/v1/messages');
    assert.equal(init.headers.authorization, 'Bearer synthetic-key');
    const body = JSON.parse(init.body);
    assert.equal(body.model, base.model);
    assert.deepEqual(body.output_config, { effort: 'max' });
    return sse(events([{ type: 'text', text: 'done' }]));
  });
  const chunks = await collect(instance.stream(base));
  assert.equal(chunks.find(chunk => chunk.type === 'block-end').block.text, 'done');
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, { inputTokens: 7, outputTokens: 17, totalTokens: 35, cacheReadTokens: 11 });
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('MiniMax registers with the runtime and reports a missing key safely', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dscode-minimax-')), ctx = new Context();
  try {
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(Credentials, { path: join(home, 'credentials.yaml'), dshHome: home, watch: false });
    await ctx.plugin(MiniMax);
    assert.equal((await loadModelDirectory(ctx)).rows.filter(row => row.provider === 'minimax').length, 2);
    assert(ctx.llm.listConfigurableProviders().some(provider => provider.provider === 'minimax'));
    const result = (await collect(ctx.llm.stream(base))).at(-1);
    assert.equal(result.reason.failure.code, 'MISSING_CREDENTIAL');
    assert(!result.reason.failure.message.includes('synthetic-key'));
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

test('MiniMax M3.1 Flash usage uses the published rates', () => {
  const time = Date.parse('2026-10-28T00:00:00Z');
  assert.equal(estimateCost('minimax', 'MiniMax-M3.1-Flash', { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }, time), 0.765);
  assert.equal(estimateCost('minimax', 'MiniMax-M3', { inputTokens: 1, outputTokens: 1 }, time), null);
  assert.equal(cacheReadRatio('minimax', 'MiniMax-M3.1-Flash'), 0.1);
  assert.equal(priceVersionFor('minimax'), 'minimax-2026-10-27');
});
