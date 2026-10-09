import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomStore } from '../plugins/custom/config.mjs';
import { CustomProviders } from '../plugins/custom/index.mjs';
import { CustomProviderPanel, clearReportedLimits } from '../packages/tui/src/custom-provider-panel.ts';
import { DscodeProviderPanel } from '../packages/tui/src/app.ts';
import { mount, assertFits } from './fixtures/tui-mount.mjs';

const p = { id: 'custom-ui', name: 'Studio', baseURL: 'http://studio:8000/v1', api: 'chat-completions', auth: 'bearer', backend: 'omlx', timeoutMs: 180000, models: [{ id: 'qwen', contextWindow: 32768, maxTokens: 4096, contextSource: 'server', thinking: 'default' }] };
const fake = extra => ({ list: async () => ({ providers: [structuredClone(p)], revision: 'v1' }), newProfile: () => ({ ...p, models: [] }), ...extra });
const down = async (ui, n) => { for (let i = 0; i < n; i++) await ui.write('\x1b[B'); };

test('changing endpoint or model drops old server facts while retaining explicit overrides', () => {
  assert.equal(clearReportedLimits(p.models[0]).contextWindow, undefined);
  assert.equal(clearReportedLimits({ ...p.models[0], contextSource: 'user' }).contextWindow, 32768);
  assert.equal(clearReportedLimits({ ...p.models[0], outputSource: 'server' }).maxTokens, undefined);
});

test('/provider has a Custom entry and focuses it for a custom session', async () => {
  const choices = [];
  const ui = await mount(DscodeProviderPanel, { current: 'custom-ui', load: async () => ({ rows: [] }), choose: p => choices.push(p), back() {} });
  try { assert.match(ui.frame(), /› Custom/); await ui.write('\r'); assert.deepEqual(choices, ['custom']); }
  finally { ui.close(); }
});

test('/provider lists saved services as switch targets separately from Custom setup', async () => {
  const choices = [];
  const ui = await mount(DscodeProviderPanel, {
    current: 'deepseek-official', load: async () => ({ rows: [] }), loadCustom: fake({}).list,
    choose: id => choices.push(id), back() {},
  });
  try {
    assert.match(ui.frame(), /Studio · 1 model\(s\)/);
    assert.match(ui.frame(), /Custom · add \/ edit/);
    await ui.write('\x1b[A'); await ui.write('\x1b[A'); await ui.write('\r');
    assert.deepEqual(choices, ['custom-ui']);
    await down(ui, 1); await ui.write('\r');
    assert.deepEqual(choices, ['custom-ui', 'custom']);
    assertFits(ui);
  } finally { ui.close(); }
});

test('/provider focuses the actual saved custom service when reopening', async () => {
  const choices = [];
  const ui = await mount(DscodeProviderPanel, {
    current: 'custom-second', load: async () => ({ rows: [] }),
    loadCustom: async () => ({ providers: [p, { ...p, id: 'custom-second', name: 'Second Studio' }], revision: 'v1' }),
    choose: id => choices.push(id), back() {},
  });
  try {
    assert.match(ui.frame(), /› ● Second Studio/);
    await ui.write('\r'); assert.deepEqual(choices, ['custom-second']);
  } finally { ui.close(); }
});

test('custom editor masks pasted keys, accepts q in fields, preserves metadata and saves before switching', async () => {
  const saves = [], choices = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; } }), select: (...args) => choices.push(args), back() {} }, { columns: 60, rows: 26 });
  try {
    await ui.write('\r'); await ui.write('\x15'); await ui.write('q Studio'); await ui.write('\r');
    assert.match(ui.frame(), /q Studio/);
    await down(ui, 4); await ui.write('\r'); await ui.write('synthetic-secret-q');
    assert(!ui.frame().includes('synthetic-secret-q')); await ui.write('\r');
    await down(ui, 3); await ui.write('\r');
    assert.match(ui.frame(), /Context \(server\)/);
    await down(ui, 1); await ui.write('\r'); await ui.write('\x15'); await ui.write('65536'); await ui.write('\r');
    assert.match(ui.frame(), /Context \(user\): 65536/);
    await down(ui, 5); await ui.write('\r');
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].models[0].contextWindow, 65536);
    assert.equal(saves[0][1], 'synthetic-secret-q');
    assert.equal(saves[0][2], 'v1');
    assert.deepEqual(choices, [['custom-ui', 'qwen']]);
    assertFits(ui);
  } finally { ui.close(); }
});

test('discovery cancellation aborts the pending HTTP operation and does not save', async () => {
  let signal, saves = 0;
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async () => { saves++; }, discover: async (_profile, _key, s) => {
    signal = s; return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
  } }), select() {}, back() {} });
  try { await down(ui, 6); await ui.write('\r'); assert.match(ui.frame(), /Working/); await ui.write('\x1b'); assert.equal(signal.aborted, true); assert.equal(saves, 0); }
  finally { ui.close(); }
});

test('terminal model-test results stay attributable across model changes, cancellation and failed retries', async () => {
  let attempts = 0, aborted = false;
  const requests = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({
    list: async () => ({ revision: 'first', providers: [{ ...p, models: [p.models[0], { ...p.models[0], id: 'second' }] }] }),
    test: async (_profile, model, _key, signal) => {
      requests.push(model);
      if (++attempts === 1) return [{ name: 'Text and streaming', status: 'passed' }];
      if (attempts === 3) throw Error('Test connection failed');
      if (attempts === 4) return [{ name: 'Probe', status: 'failed', message: 'Unexpected answer' }];
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')); }, { once: true }));
    },
  }), select() {}, back() {} });
  try {
    await down(ui, 7); await ui.write('\r'); await down(ui, 5); await ui.write('\r');
    assert.match(ui.frame(), /Test results: qwen/);
    assert.match(ui.frame(), /Text and streaming: passed/);
    await ui.write('\x1b'); await down(ui, 8); await ui.write('\r');
    assert.match(ui.frame(), /Model ID: second/);
    assert.match(ui.frame(), /Test results: qwen/);
    await down(ui, 5); await ui.write('\r');
    assert.match(ui.frame(), /Working/);
    assert.doesNotMatch(ui.frame(), /Text and streaming: passed|Test results:/);
    await ui.write('\x1b');
    assert.equal(aborted, true);
    assert.doesNotMatch(ui.frame(), /Text and streaming: passed|Test results:/);
    await ui.write('\r');
    assert.match(ui.frame(), /Test connection failed/);
    assert.doesNotMatch(ui.frame(), /Text and streaming: passed|Test results:/);
    await ui.write('\r');
    assert.match(ui.frame(), /Test results: second/);
    assert.match(ui.frame(), /Probe: failed · Unexpected answer/);
    assert.deepEqual(requests, ['qwen', 'second', 'second', 'second']);
    assertFits(ui);
  } finally { ui.close(); }
});

test('image input requires explicit selection, survives rediscovery and is saved before switching', async () => {
  const saves = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({
    discover: async () => ({ backend: 'omlx', models: [{ id: 'qwen', contextWindow: 65536, contextSource: 'server' }] }),
    save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; },
  }), select() {}, back() {} }, { columns: 60, rows: 26 });
  try {
    await down(ui, 7); await ui.write('\r'); await down(ui, 4);
    assert.match(ui.frame(), /Input: Text only/);
    await ui.write('\r'); await down(ui, 1); await ui.write('\x1b');
    assert.match(ui.frame(), /Input: Text only/);
    await ui.write('\r'); await down(ui, 1); await ui.write('\r');
    assert.match(ui.frame(), /Input: Text and images/);
    await ui.write('\x1b'); await down(ui, 6); await ui.write('\r');
    await down(ui, 1); await ui.write('\r'); // Adopt the refreshed model metadata.
    await down(ui, 7); await ui.write('\r');
    assert.match(ui.frame(), /Input: Text and images/);
    await down(ui, 6); await ui.write('\r');
    assert.deepEqual(saves[0][0].models[0].inputModalities, ['text', 'image']);
    assert.equal(saves[0][0].models[0].contextWindow, 65536);
    assertFits(ui);
  } finally { ui.close(); }
});

test('terminal output-default selection survives save, a fresh editor and rediscovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'custom-output-ui-'));
  const path = join(dir, 'providers.yaml');
  const saves = [], saveGate = Promise.withResolvers();
  let holdSaves = false;
  const service = () => {
    const client = new CustomProviders({ store: new CustomStore(path),
      credentials: { describe: async () => ({ configured: false }) },
      fetch: async () => Response.json({ data: [{ id: 'qwen', context_window: 65536, max_output_tokens: 8192 }] }),
    });
    const save = client.save.bind(client);
    client.save = (...args) => {
      const pending = (async () => { if (holdSaves) await saveGate.promise; return save(...args); })();
      saves.push(pending);
      return pending;
    };
    return client;
  };
  let ui;
  try {
    const client = service();
    await client.save({ ...p, auth: 'none' }, '', (await client.list()).revision);
    holdSaves = true;
    const props = client => ({ initialId: p.id, client, select() {}, back() {} });
    ui = await mount(CustomProviderPanel, props(client));
    await down(ui, 7); await ui.write('\r'); await down(ui, 2);
    await ui.write('\r'); await ui.write('\x15'); await ui.write('\r');
    await down(ui, 4); await ui.write('\r');
    assert.equal(saves.length, 2, 'The editor started a save after the initial seed');
    assert.match(ui.frame(), /Working/);
    assert.equal((await client.list()).providers[0].models[0].maxTokens, 4096, 'The held save has not changed durable settings');
    saveGate.resolve();
    await saves[1];
    assert.equal((await client.list()).providers[0].models[0].maxTokens, undefined);
    ui.close(); ui = null;
    const reopened = service();
    ui = await mount(CustomProviderPanel, props(reopened));
    await down(ui, 6); await ui.write('\r');
    await down(ui, 1); await ui.write('\r');
    await down(ui, 7); await ui.write('\r');
    assert.match(ui.frame(), /Context \(server\): 65536/);
    assert.match(ui.frame(), /^\s*Output budget \(user\):[ \t]*$/m);
    await down(ui, 6); await ui.write('\r');
    assert.equal(saves.length, 3, 'The reopened editor started a second save');
    await saves[2];
    const saved = (await new CustomStore(path).read()).providers[0].models[0];
    assert.equal(saved.maxTokens, undefined);
    assert.equal(saved.outputSource, 'user');
    assertFits(ui);
  } finally { saveGate.resolve(); ui?.close(); await Promise.allSettled(saves); await rm(dir, { recursive: true, force: true }); }
});

for (const field of ['endpoint', 'protocol', 'model']) test(`changing ${field} resets image input for the new deployment`, async () => {
  const saved = { ...p, models: [{ ...p.models[0], inputModalities: ['text', 'image'] }] }, saves = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ list: async () => ({ providers: [saved], revision: 'v1' }),
    save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; },
  }), select() {}, back() {} });
  try {
    if (field === 'model') { await down(ui, 7); await ui.write('\r'); }
    else await down(ui, field === 'endpoint' ? 1 : 2);
    await ui.write('\r');
    if (field === 'protocol') await down(ui, 1);
    else { await ui.write('\x15'); await ui.write(field === 'endpoint' ? 'http://other:8000/v1' : 'other-model'); }
    await ui.write('\r');
    if (field === 'model') await ui.write('\x1b');
    else await ui.write('\x1b[A');
    // Save on the provider page, where all nine preceding rows are unchanged.
    if (field === 'protocol') await ui.write('\x1b[A');
    await down(ui, 9); await ui.write('\r');
    assert.deepEqual(saves[0][0].models[0].inputModalities, ['text']);
  } finally { ui.close(); }
});

test('bracketed URL and key pastes strip terminal markers and do not submit newline chunks', async () => {
  const saves = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; } }), select() {}, back() { assert.fail('paste must not exit'); } });
  try {
    await down(ui, 1); await ui.write('\r'); await ui.write('\x15');
    await ui.write('\x1b[200~http://new-studio:8000/v1\r\n\x1b[201~');
    assert.match(ui.frame(), /Enter apply/);
    assert.doesNotMatch(ui.frame(), /20[01]~/);
    await ui.write('\r');
    await down(ui, 3); await ui.write('\r');
    await ui.write('[200~'); await ui.write('synthetic-'); await ui.write('\r');
    assert.match(ui.frame(), /Enter apply/);
    await ui.write('secret'); await ui.write('[201~');
    assert(!ui.frame().includes('synthetic-'));
    await ui.write('\r'); await down(ui, 5); await ui.write('\r');
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].baseURL, 'http://new-studio:8000/v1');
    assert.equal(saves[0][1], 'synthetic-secret');
  } finally { ui.close(); }
});

test('Esc cancels the protocol picker without leaving the provider or changing its format', async () => {
  const saves = [];
  const ui = await mount(CustomProviderPanel, { initialId: p.id, client: fake({ save: async (...args) => { saves.push(args); return { providers: [args[0]], revision: 'v2' }; } }), select() {}, back() { assert.fail('picker must not exit'); } });
  try {
    await down(ui, 2); await ui.write('\r'); await down(ui, 1);
    assert.match(ui.frame(), /API format: responses/);
    await ui.write('\x1b');
    assert.match(ui.frame(), /API format: chat-completions/);
    assert.match(ui.frame(), /Base URL/);
    await ui.write('\r'); await down(ui, 2); await ui.write('\r');
    assert.match(ui.frame(), /API format: anthropic/);
    assert.match(ui.frame(), /Authentication: x-api-key/);
    await down(ui, 7); await ui.write('\r');
    assert.equal(saves.length, 1);
    assert.equal(saves[0][0].api, 'anthropic');
    assert.equal(saves[0][0].auth, 'x-api-key');
    assertFits(ui);
  } finally { ui.close(); }
});
