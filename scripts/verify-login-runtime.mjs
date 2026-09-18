import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';
import { parseOpenRouterModels } from '../plugins/openrouter/models.mjs';
import { LISTING } from '../tests/fixtures/openrouter-listing.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-login-runtime-'));
const uiEntry = join(root, 'node_modules/dsh-code/lib', `.dscode-login-runtime-${process.pid}.mjs`);
const catalog = join(root, 'plugins/providers/catalog.mjs');
try {
  provision(home);
  // The OpenRouter listing, cached as the adapter keeps it, so the fixture needs no network.
  writeFileSync(join(home, 'openrouter-models.json'), JSON.stringify({ version: 2, fetchedAt: Date.now(), models: parseOpenRouterModels(LISTING) }));
  writeFileSync(uiEntry, readFileSync(join(root, 'node_modules/dsh-code/lib/index.mjs'), 'utf8') + '\nexport { loadProviderSettings, saveProviderCredential, loadModelDirectory };\n');
  const probe = join(home, 'probe.mjs');
  writeFileSync(probe, `
import assert from 'node:assert/strict';
import { loadProviderSettings, saveProviderCredential, loadModelDirectory } from ${JSON.stringify(uiEntry)};
import { ensureProviderRoute, waitForModels, pickModel } from ${JSON.stringify(catalog)};
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

    // /provider openrouter: DSCODE's own adapter is always registered, serving the cached listing.
    assert.equal(await ensureProviderRoute(ctx.settings, 'openrouter'), false, 'the OpenRouter route needs no declaration');
    const directory = await waitForModels(() => loadModelDirectory(ctx), 'openrouter');
    const models = directory.rows.filter(row => row.provider === 'openrouter');
    assert.deepEqual(models.map(row => row.model), ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash', 'moonshotai/kimi-k2.6', 'qwen/qwen3.7-plus'], 'every listed model that can drive an agent');
    const deepseek = models.find(row => row.model === 'deepseek/deepseek-v4-flash');
    assert.deepEqual([deepseek.reasoning.defaultEffort, ...deepseek.reasoning.efforts.map(effort => effort.id)], ['high', 'off', 'low', 'high', 'max', 'ultra']);
    const glm = models.find(row => row.model === 'z-ai/glm-5.3-flash').reasoning.efforts.map(effort => effort.id);
    assert.deepEqual(glm, ['low', 'high', 'max', 'ultra'], 'other models keep their own levels: ' + glm.join(','));
    assert.equal(pickModel(directory.rows, 'openrouter', 'deepseek-official/deepseek-flash', 'ultra').row.model, 'deepseek/deepseek-v4-flash');
    const openrouter = await row(ctx, 'openrouter');
    // /provider grok: the CLI-login rail. It must name its own credential reference,
    // because the terminal reads apiKeyEnv off the resolved provider profile and a
    // missing one silently degrades the row to a writable GROK_API_KEY key field.
    const grok = await row(ctx, 'grok');
    assert(grok, 'missing grok provider');
    assert.equal(grok.active, true);
    assert.equal(grok.credentialRef, 'GROK_CLI_TOKEN');
    assert.equal(openrouter.credentialRef, 'OPENROUTER_API_KEY');
    assert.equal(openrouter.credential.writable, true);
    if (save) await saveProviderCredential(ctx, openrouter, 'synthetic-openrouter-key');
    assert.equal((await ctx.credentials.resolve('OPENROUTER_API_KEY')).value, 'synthetic-openrouter-key');

    // The wire request OpenRouter would receive, captured before any network I/O.
    const requests = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const request = url instanceof Request ? url : new Request(url, init);
      requests.push({ url: request.url, auth: request.headers.get('authorization'), title: request.headers.get('x-openrouter-title'), body: JSON.parse(await request.text()) });
      return new Response('data: {"id":"x","model":"m","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\\n\\ndata: {"id":"x","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":1}}\\n\\ndata: [DONE]\\n\\n', { headers: { 'content-type': 'text/event-stream' } });
    };
    try {
      const tools = ['bash', 'subagent', 'workflow'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
      for (const reasoningEffort of ['ultra', 'low', 'off']) {
        for await (const _chunk of ctx.llm.stream({ provider: 'openrouter', model: 'deepseek/deepseek-v4-flash', reasoningEffort, tools,
          messages: [{ role: 'system', content: [{ type: 'text', text: 'Probe.' }] }, { role: 'user', content: [{ type: 'text', text: 'Hi.' }] }] })) {}
      }
      // A catalog model without reasoning levels, under the profile's high default, gets no effort instead of a refused request.
      for await (const _chunk of ctx.llm.stream({ provider: 'openrouter', model: 'qwen/qwen3.7-plus', tools,
        messages: [{ role: 'system', content: [{ type: 'text', text: 'Probe.' }] }, { role: 'user', content: [{ type: 'text', text: 'Hi.' }] }] })) {}
    } finally { globalThis.fetch = original; }
    assert.equal(requests.length, 4);
    assert.equal(requests[3].body.model, 'qwen/qwen3.7-plus');
    assert.equal(requests[0].title, 'DSCODE');
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
- id: dscode-credentials
  config:
    path: ${JSON.stringify(join(home, 'shared', 'credentials.yaml'))}
- id: tui-startup
  disabled: true
- id: tui-runner
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
  console.log('Login runtime passed: real provider directory and native TUI save callback for DeepSeek, OpenRouter and the read-only Grok CLI login; the OpenRouter route, its Ultra-capable models and both keys survive a fresh Host; the OpenRouter wire request is captured before network I/O.');
} finally { rmSync(home, { recursive: true, force: true }); rmSync(uiEntry, { force: true }); }
