import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-login-runtime-'));
const uiEntry = join(root, 'node_modules/dsh-code/lib', `.dscode-login-runtime-${process.pid}.mjs`);
const catalog = join(root, 'plugins/providers/catalog.mjs');
try {
  provision(home);
  writeFileSync(uiEntry, readFileSync(join(root, 'node_modules/dsh-code/lib/index.mjs'), 'utf8') + '\nexport { loadProviderSettings, saveProviderCredential, loadModelDirectory };\n');
  const probe = join(home, 'probe.mjs');
  writeFileSync(probe, `
import assert from 'node:assert/strict';
import { loadProviderSettings, saveProviderCredential, loadModelDirectory } from ${JSON.stringify(uiEntry)};
import { ensureProviderRoute, waitForModels, pickModel, narrowOpenRouterProfile, isNarrowOpenRouterProfile } from ${JSON.stringify(catalog)};
export const inject = ['credentials', 'llm', 'settings'];
const row = async (ctx, provider) => (await loadProviderSettings(ctx)).rows.find(row => row.provider === provider);
export function apply(ctx) {
  void (async () => {
    await ctx.get('loader').await();
    const save = process.env.DSCODE_LOGIN_CHECK === 'save';
    const official = await row(ctx, 'deepseek-official');
    assert(official, 'missing official provider');
    assert.equal(official.credential.writable, true);
    if (save) await saveProviderCredential(ctx, official, 'synthetic-runtime-key');
    assert.equal((await ctx.credentials.resolve('DEEPSEEK_API_KEY')).value, 'synthetic-runtime-key');

    // /provider openrouter: declare the pi-ai route once, then store its key through the native TUI callback.
    if (save) {
      // The narrow profile 0.7.3 to 0.7.5 wrote, read back as the resolved settings describe it, is recognised and replaced.
      const piAi = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === 'llm-pi-ai');
      await ctx.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'openrouter'], value: narrowOpenRouterProfile() }], piAi.revision);
      const stored = ctx.settings.describe({ redactSecrets: true }).find(entry => entry.ns === 'llm-pi-ai').value.providers.openrouter;
      assert.equal(isNarrowOpenRouterProfile(stored), true, 'the described narrow profile is recognised: ' + JSON.stringify(stored));
    }
    assert.equal(await ensureProviderRoute(ctx.settings, 'openrouter'), save, 'the route is written once (replacing the narrow profile) and persists');
    const directory = await waitForModels(async () => {
      const loaded = await loadModelDirectory(ctx);
      return loaded.rows.filter(row => row.provider === 'openrouter').length > 300 ? loaded : { ...loaded, rows: [] };
    }, 'openrouter');
    const models = directory.rows.filter(row => row.provider === 'openrouter');
    assert(models.length > 300, 'the route serves the whole OpenRouter catalog, not ' + models.length + ' models');
    for (const id of ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'qwen/qwen3-coder']) assert(models.some(row => row.model === id), id + ' is listed');
    for (const id of ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash-vision-exp']) {
      const model = models.find(row => row.model === id);
      assert.deepEqual([model.reasoning.defaultEffort, ...model.reasoning.efforts.map(effort => effort.id)], ['high', 'off', 'low', 'high', 'max', 'ultra'], id);
    }
    const gpt = models.find(row => row.model === 'openai/gpt-5').reasoning.efforts.map(effort => effort.id);
    assert(gpt.includes('medium') && !gpt.includes('ultra'), 'other models keep their own levels: ' + gpt.join(','));
    assert.equal(pickModel(directory.rows, 'openrouter', 'deepseek-official/deepseek-flash', 'ultra').row.model, 'deepseek/deepseek-v4-flash');
    const openrouter = await row(ctx, 'openrouter');
    assert.equal(openrouter.credentialRef, 'OPENROUTER_API_KEY');
    assert.equal(openrouter.credential.writable, true);
    if (save) await saveProviderCredential(ctx, openrouter, 'synthetic-openrouter-key');
    assert.equal((await ctx.credentials.resolve('OPENROUTER_API_KEY')).value, 'synthetic-openrouter-key');

    // The wire request OpenRouter would receive, captured before any network I/O.
    const requests = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const request = url instanceof Request ? url : new Request(url, init);
      requests.push({ url: request.url, auth: request.headers.get('authorization'), body: JSON.parse(await request.text()) });
      return new Response('data: {"id":"x","model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\\n\\ndata: {"id":"x","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const tools = ['bash', 'subagent', 'workflow'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
      for (const reasoningEffort of ['ultra', 'low', 'off']) {
        for await (const _chunk of ctx.llm.stream({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoningEffort, tools,
          messages: [{ role: 'system', content: [{ type: 'text', text: 'Probe.' }] }, { role: 'user', content: [{ type: 'text', text: 'Hi.' }] }] })) {}
      }
      // A catalog model without reasoning levels, under the profile's high default, gets no effort instead of a refused request.
      for await (const _chunk of ctx.llm.stream({ provider: 'openrouter', model: 'qwen/qwen3-coder', tools,
        messages: [{ role: 'system', content: [{ type: 'text', text: 'Probe.' }] }, { role: 'user', content: [{ type: 'text', text: 'Hi.' }] }] })) {}
    } finally { globalThis.fetch = original; }
    assert.equal(requests.length, 4);
    assert.equal(requests[3].body.model, 'qwen/qwen3-coder');
    assert.equal(requests[3].body.reasoning, undefined, 'no reasoning control for a model without levels');
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(requests[0].auth, 'Bearer synthetic-openrouter-key');
    assert.equal(requests[0].body.model, 'deepseek/deepseek-v4-flash');
    assert.equal(requests[0].body.reasoning.effort, 'xhigh');
    assert.deepEqual(requests[0].body.tools.map(tool => tool.function.name), ['bash', 'subagent']);
    assert(JSON.stringify(requests[0].body.messages).includes('DSCODE ULTRA'));
    assert.equal(requests[1].body.reasoning.effort, 'high');
    assert.deepEqual(requests[1].body.tools.map(tool => tool.function.name), ['bash', 'subagent'], 'delegation is offered below Ultra; workflow never is');
    assert(!JSON.stringify(requests[1].body.messages).includes('DSCODE ULTRA'));
    assert.equal(requests[2].body.reasoning.effort, 'none');
    console.log('LOGIN_RUNTIME_PASSED');
    ctx.get('appExit')(0);
  })().catch(error => { console.error('Login runtime fixture failed', error?.stack ?? error); ctx.get('appExit')(1); });
}
`);
  const patch = join(home, 'login.patch.yml');
  writeFileSync(patch, `
- id: credentials
  config:
    path: ${JSON.stringify(join(home, 'shared', 'credentials.yaml'))}
- id: tui-startup
  disabled: true
- id: tui-runner
  disabled: true
- id: mcp-chrome
  disabled: true
- id: dscode-memory
  config:
    enabled: false
- id: dscode-session-cards
  config:
    enabled: false
- insert:
    - id: login-probe
      name: ${JSON.stringify(probe)}
`);
  for (const mode of ['save', 'reload']) {
    const env = { ...environment(home), DSCODE_LOGIN_CHECK: mode };
    delete env.DEEPSEEK_API_KEY;
    delete env.OPENROUTER_API_KEY;
    const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
    // A one-shot Host whose work finishes fast can drain its event loop before the boot's
    // dispose settles; `bin.js` then ends on an unsettled top-level await and Node reports
    // 13 regardless of the exit code the plugin asked for. The fixture checks the
    // credential round-trip, so that one code is acceptable — but only with the marker.
    assert(output.includes('LOGIN_RUNTIME_PASSED'), output);
    if (code !== 0) assert(code === 13 && output.includes('unsettled top-level await'), output);
  }
  console.log('Login runtime passed: real provider directory and native TUI save callback for DeepSeek and OpenRouter; the OpenRouter route, its Ultra-capable models and both keys survive a fresh Host; the OpenRouter wire request is captured before network I/O.');
} finally { rmSync(home, { recursive: true, force: true }); rmSync(uiEntry, { force: true }); }
