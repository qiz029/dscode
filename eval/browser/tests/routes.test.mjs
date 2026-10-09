import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomStore, validateProfile, keyRef } from '../../../plugins/custom/config.mjs';
import { parseOptions, runEvaluation } from '../runner.mjs';
import { resolveRoute, liveAdapter, EVAL_PROVIDER, readCredential } from '../routes.mjs';
import { Context } from '@deepseek-ai/cordis';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { redactedJson } from '../host.mjs';
import { REPLAY_KIND } from '../../../plugins/custom/wire.mjs';

const profile = extra => validateProfile({ id: 'custom-eval-fixture', name: 'Fixture', baseURL: 'http://localhost:8000/v1', api: 'responses', auth: 'bearer', models: [{ id: 'vision', contextWindow: 65536, inputModalities: ['text', 'image'] }, { id: 'other', contextWindow: 4096 }], ...extra });
const options = extra => parseOptions(['--provider', 'custom-eval-fixture', '--model', 'vision', ...extra]);

test('custom eval requires an explicit model and refuses ambiguous or silently ignored options', () => {
  const parsed = options(['--providers-file', './fixture.yaml', '--key-env', 'FIXTURE_KEY']);
  assert.equal(parsed.thinking, undefined); assert.equal(parsed.keyEnv, 'FIXTURE_KEY');
  for (const args of [['--provider', 'custom-eval-fixture'], ['--provider', 'unknown'], ['--key-env', 'KEY'], ['--providers-file', './x'], ['--model', 'bad\nmodel']]) assert.throws(() => parseOptions(args));
  for (const args of [['--self-test'], ['--thinking', 'disabled'], ['--key-env', 'raw-secret-value']]) assert.throws(() => options(args));
});

test('custom route snapshots only the selected model and resolves its exact credential separately', async () => {
  const p = profile({}), seen = [];
  const result = await resolveRoute(options([]), { store: { read: async () => ({ providers: [p] }) }, resolveCredential: async ref => { seen.push(ref); return 'synthetic-key'; } });
  assert.deepEqual(seen, [keyRef(p.id)]);
  assert.deepEqual(result.route.profile.models.map(m => m.id), ['vision']);
  assert.equal(result.route.contextWindow, 65536);
  assert.equal(result.key, 'synthetic-key');
  assert(!JSON.stringify(result.route).includes('synthetic-key'));
  const env = await resolveRoute(options(['--key-env', 'EXPLICIT_KEY']), { env: { EXPLICIT_KEY: 'override' }, store: { read: async () => ({ providers: [p] }) }, resolveCredential: () => assert.fail('explicit override must not use stored key') });
  assert.equal(env.key, 'override');
  const noAuth = await resolveRoute(options([]), { store: { read: async () => ({ providers: [profile({ auth: 'none' })] }) }, resolveCredential: () => assert.fail('no-auth must not read keys') });
  assert.equal(noAuth.key, undefined);
});

test('custom configuration and credential failures stop before report creation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'browser-eval-route-')); t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'providers.yaml'), store = new CustomStore(path);
  await store.update((await store.read()).revision, () => [profile({})]);
  const out = join(home, 'report');
  const missing = 'DSCODE_EVAL_TEST_ABSENT_KEY';
  const previous = process.env[missing]; delete process.env[missing];
  try { await assert.rejects(runEvaluation(options(['--providers-file', path, '--key-env', missing, '--out', out])), /API key is missing/); }
  finally { if (previous !== undefined) process.env[missing] = previous; }
  await assert.rejects(access(out));
  await assert.rejects(resolveRoute(options([]), { store: { read: async () => ({ providers: [] }) } }), /not found/);
  await assert.rejects(resolveRoute(options([]), { store: { read: async () => { throw Error('secret YAML contents'); } } }), error => !error.message.includes('secret YAML'));
});

test('native saved credentials resolve read-only with environment precedence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'browser-eval-credential-')), ctx = new Context();
  const path = join(home, 'credentials.yaml'), ref = keyRef('custom-eval-fixture');
  try {
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    await ctx.plugin(LocalCredentialProvider, { path, watch: false });
    await ctx.credentials.set(ref, 'synthetic-stored');
    const before = await readFile(path, 'utf8');
    assert.equal(await readCredential(ref, {}, path), 'synthetic-stored');
    assert.equal(await readCredential(ref, { [ref]: 'synthetic-env' }, path), 'synthetic-env');
    assert.equal(await readFile(path, 'utf8'), before);
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }); }
});

for (const api of ['responses', 'anthropic']) test(`${api}: evaluation alias preserves native reasoning replay and configured image support`, async () => {
  const p = profile({ api }), resolved = await resolveRoute(options([]), { store: { read: async () => ({ providers: [p] }) }, resolveCredential: async () => 'synthetic' });
  const adapter = liveAdapter(resolved.route, options([]), { get() {} }, resolved.key);
  assert.deepEqual((await adapter.resolveModel(EVAL_PROVIDER, 'vision')).inputModalities, ['text', 'image']);
  let body;
  adapter.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response('data: ' + JSON.stringify(api === 'responses' ? { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } } : { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } }) + '\n\n' + (api === 'anthropic' ? 'data: {"type":"message_stop"}\n\n' : ''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const nativeReasoning = api === 'responses' ? [{ type: 'reasoning', encrypted_content: 'opaque-replay' }] : [{ type: 'thinking', thinking: 'thought', signature: 'opaque-replay' }];
  const chunks = [];
  for await (const chunk of adapter.stream({ provider: EVAL_PROVIDER, model: 'vision', messages: [
    { role: 'assistant', source: { provider: EVAL_PROVIDER, model: 'vision', replayState: { response: { kind: REPLAY_KIND, api, nativeReasoning } } }, content: [{ type: 'text', text: 'Earlier' }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ] })) chunks.push(chunk);
  assert.match(JSON.stringify(body), /opaque-replay/); assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('report redaction preserves JSON types and removes an exact echoed credential', () => {
  for (const key of ['null', 'synthetic-secret', 'quote"and\\slash']) {
    const parsed = JSON.parse(redactedJson({ finalText: `echo ${key}`, values: [null, false, 5, key] }, key));
    assert.equal(parsed.finalText, 'echo [redacted]');
    assert.deepEqual(parsed.values, [null, false, 5, '[redacted]']);
  }
});
