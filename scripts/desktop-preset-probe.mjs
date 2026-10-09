import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import assert from 'node:assert/strict';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { verifyDesktopCustom } from './desktop-custom-probe.mjs';
import { verifyDesktopBrowser } from './desktop-browser-probe.mjs';
import { scopeOf } from '@deepseek-ai/dsh-scope';

async function verifySessionCreation(ctx) {
  for (const agentPreset of ['standard', 'dscode', 'standard', 'dscode']) {
    const created = await ctx.sessionController.create({ cwd: process.env.HOME, agentPreset });
    assert(created.sessionId);
    assert.equal(created.agentPreset, agentPreset);
    const presets = await ctx.agentPresets.list();
    assert(presets.every(preset => !preset.broken), 'A new session invalidated a preset');
  }
}

export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'permissionPresets', 'commands', 'skills', 'attachments', 'credentials', 'connection', 'webServer', 'sessionController'];
export function apply(ctx) {
  void run(ctx).catch(error => { console.error(error.stack); ctx.get('appExit')(1); });
}

async function run(ctx) {
  const hostPath = process.env.PATH;
  await ctx.get('loader').await();
  const origin = `http://127.0.0.1:${ctx.webServer.port}`;
  const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const hubResponse = await fetch(`${origin}/api/dscode-hub`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: 'hub-absence', method: 'dscode-hub', payload: { action: 'status' } }) });
  assert.equal(hubResponse.status, 404, 'DSCODE must not expose the Hub endpoint');
  const preset = await ctx.agentPresets.resolve('dscode');
  assert.equal(preset.broken, undefined, preset.broken);
  assert.equal(ctx.permissionPresets.defaultPreset, 'workspace-write', 'Mounting the Desktop bundle must retain the native default');
  for (const id of ['read-only', 'workspace-write', 'danger-full-access', 'auto-review']) assert(ctx.permissionPresets.names.includes(id));
  if (process.env.DSCODE_DESKTOP_PROBE_RELOAD === '1') {
    const receipt = await verifyDesktopCustom(ctx, true);
    const browser = process.env.DSCODE_DESKTOP_BROWSER === '1' ? await verifyDesktopBrowser(ctx, { reload: true }) : {};
    await verifySessionCreation(ctx);
    console.log('DESKTOP_PRESET_PASSED ' + JSON.stringify({ ...receipt, ...browser, sessionCreationAfterRestart: true }));
    ctx.get('appExit')(0);
    return;
  }
  const results = [], calls = new Map(), childRoutes = new Map();
  const workspaceInputs = new Map();
  const parentId = 'desktop-preset-parent';
  ctx.on('approval/request', (request, next) => ['bash', 'shell_retry', 'subagent', 'subagent_fork'].includes(request.toolName) ? Promise.resolve('allowed-once') : next(), { prepend: true });
  ctx.on('tools/result', (exec, result) => { results.push({ session: exec.agent?.session.id, name: exec.name, result }); });
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 100000 },
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } };
    }
    async *stream(options) {
      let action;
      if (!options.purpose && options.sessionId?.startsWith('workspace-')) {
        workspaceInputs.set(options.sessionId, options.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n'));
        const step = calls.get(options.sessionId) ?? 0;
        calls.set(options.sessionId, step + 1);
        if (step === 0) action = ['bash', { command: "printf 'workspace shell check\\n'" }];
      } else if (!options.purpose) {
        const step = calls.get(options.sessionId) ?? 0;
        calls.set(options.sessionId, step + 1);
        if (options.sessionId === parentId) {
          action = [
            ['bash', { command: "export DSCODE_FIXTURE_STATE=retained; printf 'first!\\n'" }],
            ['bash', { command: "printf 'persistent=%s\\n' \"$DSCODE_FIXTURE_STATE\"" }],
            ['shell_retry', { command: "printf 'fresh=%s\\nhelper=%s\\n' \"${DSCODE_FIXTURE_STATE-unset}\" \"$(command -v apply_patch)\"", description: 'Check isolated fresh shell state', workdir: process.cwd() }],
            ['subagent', { name: 'childone', description: 'Check child shell isolation', prompt: 'Execute the scripted child shell check.', reasoning_effort: 'low', run_in_background: false }],
            ['subagent_fork', { name: 'childtwo', description: 'Check fork shell isolation', prompt: 'Execute the scripted fork shell check.', reasoning_effort: 'high', run_in_background: false }],
            ['bash', { command: "printf 'before\\n' > desktop-patch-fixture.txt; apply_patch <<'PATCH'\ndiff --git a/desktop-patch-fixture.txt b/desktop-patch-fixture.txt\n--- a/desktop-patch-fixture.txt\n+++ b/desktop-patch-fixture.txt\n@@ -1 +1 @@\n-before\n+after\nPATCH" }],
            ['shell_retry', { command: "apply_patch --check <<'PATCH'\ndiff --git a/desktop-patch-fixture.txt b/desktop-patch-fixture.txt\n--- a/desktop-patch-fixture.txt\n+++ b/desktop-patch-fixture.txt\n@@ -1 +1 @@\n-after\n+fresh\nPATCH", description: 'Validate a patch without writing it', workdir: process.cwd() }],
          ][step];
        } else {
          childRoutes.set(options.sessionId, { provider: options.provider, model: options.model, effort: options.reasoningEffort });
          if (step === 0) action = ['bash', { command: "printf 'child=%s\\nhelper=%s\\n' \"${DSCODE_FIXTURE_STATE-unset}\" \"$(command -v apply_patch)\"" }];
        }
      }
      if (action) assert(options.tools.some(tool => tool.name === action[0]), `Missing ${action[0]}`);
      const block = action ? { type: 'tool-call', id: `fixture-${options.sessionId}-${calls.get(options.sessionId)}`, name: action[0], arguments: JSON.stringify(action[1]) }
        : { type: 'text', text: 'Desktop preset fixture finished.' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: action ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-preset-fixture'], new Adapter());
  const { agent } = await ctx.agents.create({ sessionId: parentId, meta: { cwd: process.cwd(), agentPreset: 'dscode' },
    agentOptions: { provider: 'desktop-preset-fixture', model: 'scripted', reasoningEffort: 'high' },
    setup: async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'dscode');
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
    },
  });
  assert.equal(ctx.permissionPresets.current(agent.session), 'workspace-write', 'A new Agent must not silently enter model review');
  for (const name of ['plugin_hub_search', 'plugin_hub_info']) assert.equal(ctx.tools.get(name, scopeOf(agent.ctx)), undefined, 'DSCODE must not register Hub tools');
  const commandInputs = ['browser', 'computer', 'delegate', 'shell', 'review', 'opencode', 'memories', 'mailbox', 'trigger', 'triggers', 'dscode-doctor', 'dscode-mcp', 'dscode-skills'];
  const commandCatalog = ctx.commands.list(agent);
  assert.deepEqual(commandInputs.filter(name => !commandCatalog.find(command => command.name === name)?.input?.hint), [],
    'Desktop commands with arguments must advertise input instead of falling through to model messages');
  assert(commandInputs.every(name => commandCatalog.find(command => command.name === name).input.attachments !== true));
  ctx.permissionPresets.set(agent.session, 'workspace-write');
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Run the isolated Desktop preset qualification.' }] }));
  await agent.whenIdle();
  const failures = results.filter(row => row.result.isError);
  assert.deepEqual(failures, [], JSON.stringify(failures));
  const text = row => row.result.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '';
  const parent = results.filter(row => row.session === parentId);
  assert.equal(parent.length, 7, JSON.stringify({ results, events: agent.session.snapshotEvents().slice(-8) }));
  assert.match(text(parent[0]), /first!/);
  assert.match(text(parent[1]), /persistent=retained/);
  assert.match(text(parent[2]), /fresh=unset/);
  assert.match(text(parent[2]), /helper=.*\/installed\/package\/bin\/apply_patch/);
  assert.equal(readFileSync(join(process.cwd(), 'desktop-patch-fixture.txt'), 'utf8'), 'after\n', text(parent[5]));
  assert.equal(parent[6].result.value.exitCode, 0, text(parent[6]));
  assert.equal(process.env.PATH, hostPath, 'Desktop shell helpers must not change the Host environment');
  assert.equal(childRoutes.size, 2, JSON.stringify([...childRoutes]));
  assert.deepEqual([...childRoutes.values()].map(route => route.effort).sort(), ['high', 'low']);
  for (const route of childRoutes.values()) assert.deepEqual({ provider: route.provider, model: route.model }, { provider: 'desktop-preset-fixture', model: 'scripted' });
  const childShells = results.filter(row => row.session !== parentId && row.name === 'bash');
  assert.equal(childShells.length, 2);
  for (const row of childShells) {
    assert.match(text(row), /child=unset/);
    assert.match(text(row), /helper=.*\/installed\/package\/bin\/apply_patch/);
  }
  const standard = await ctx.agents.create({ sessionId: 'desktop-native-standard-shell',
    meta: { cwd: process.cwd(), agentPreset: 'standard' },
    agentOptions: { provider: 'desktop-preset-fixture', model: 'scripted' },
    setup: async scope => { await ctx.agentPresets.mount(scope, 'standard'); } });
  assert.equal(ctx.tools.get('browser_start', scopeOf(standard.agent.ctx)), undefined, 'DSCODE browser entry leaked to Standard');
  assert.equal(ctx.commands.find(standard.agent, 'browser'), undefined, 'DSCODE browser command leaked to Standard');
  assert(!(await ctx.skills.snapshot({ scope: standard.agent })).skills.some(skill => skill.name === 'browser-use'), 'DSCODE browser skill leaked to Standard');
  assert(ctx.tools.get('browser_start', scopeOf(agent.ctx)), 'DSCODE browser entry missing');
  const standardShell = await ctx.tools.execute({ name: 'bash', arguments: { command: 'printf "%s\\n" "$PATH"', description: 'Inspect native Standard shell PATH' },
    agent: standard.agent, callId: 'standard-shell-path', signal: AbortSignal.timeout(10000) });
  assert.equal(standardShell.isError, false, JSON.stringify(standardShell));
  for (const name of ['plugin_hub_search', 'plugin_hub_info']) assert.equal(ctx.tools.get(name, scopeOf(standard.agent.ctx)), undefined, 'Hub tools leaked to the Standard preset');
  assert(!text({ result: standardShell }).includes('/installed/package/bin'), 'Native Standard inherited DSCODE shell helpers');
  await standard.dispose();
  const status = (await ctx.commands.execute(agent, '/shell status', [], new AbortController().signal)).result;
  assert.equal(status.kind, 'success', status.text);
  const workspaces = await Promise.all(['alpha', 'beta'].map(label => ctx.agents.create({
    sessionId: `workspace-${label}`, meta: { cwd: join(process.env.HOME, label, 'project'), agentPreset: 'dscode' },
    agentOptions: { provider: 'desktop-preset-fixture', model: 'scripted' },
    setup: async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'dscode');
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
    },
  })));
  for (const { agent } of workspaces) agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read only this workspace context.' }] }));
  await Promise.all(workspaces.map(({ agent }) => agent.whenIdle()));
  for (const [index, label] of ['alpha', 'beta'].entries()) {
    const other = label === 'alpha' ? 'beta' : 'alpha';
    const input = workspaceInputs.get(`workspace-${label}`);
    assert(input, `No model request from ${label}`);
    assert.match(input, /GLOBAL_FIXTURE_GUIDANCE/);
    assert(input.includes(`ANCESTOR_${label.toUpperCase()}_ONLY`));
    assert(input.includes(`PROJECT_${label.toUpperCase()}_ONLY`));
    assert(!input.includes(`ANCESTOR_${other.toUpperCase()}_ONLY`), 'Ancestor instructions leaked across workspaces');
    assert(!input.includes(`PROJECT_${other.toUpperCase()}_ONLY`), 'Project instructions leaked across workspaces');
    const agent = workspaces[index].agent;
    const catalog = await ctx.skills.snapshot({ scope: agent, cwd: agent.session.header.cwd });
    assert(catalog.skills.some(skill => skill.name === `${label}-skill`));
    assert(!catalog.skills.some(skill => skill.name === `${other}-skill`), 'Ancestor skills leaked across workspaces');
    const hooks = readFileSync(join(agent.session.header.cwd, 'hook-log'), 'utf8').trim().split('\n');
    assert.deepEqual(hooks, ['global-start', ...['start', 'prompt', 'pre', 'post', 'stop'].map(event => `${label}-${event}`)]);
  }
  assert.equal(readdirSync(join(resolveDshHome(), 'desktop-workspaces')).length, 2);
  await workspaces[0].dispose();
  assert.equal(readdirSync(join(resolveDshHome(), 'desktop-workspaces')).length, 1);
  const beta = workspaces[1].agent;
  assert((await ctx.skills.snapshot({ scope: beta, cwd: beta.session.header.cwd })).skills.some(skill => skill.name === 'beta-skill'));
  beta.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Check the surviving workspace.' }] }));
  await beta.whenIdle();
  const betaHooks = readFileSync(join(beta.session.header.cwd, 'hook-log'), 'utf8').trim().split('\n');
  assert.equal(betaHooks.filter(line => line === 'global-start').length, 1);
  assert.equal(betaHooks.filter(line => line === 'beta-start').length, 1);
  assert.equal(betaHooks.filter(line => line === 'beta-prompt').length, 2);
  assert.equal(betaHooks.filter(line => line === 'beta-stop').length, 2);
  assert(!betaHooks.some(line => line.startsWith('alpha-')));
  await workspaces[1].dispose();
  assert.equal(readdirSync(join(resolveDshHome(), 'desktop-workspaces')).length, 0);
  assert.equal(readFileSync(join(resolveDshHome(), 'AGENTS.md'), 'utf8'), 'GLOBAL_FIXTURE_GUIDANCE\n');
  assert.deepEqual(results.filter(row => row.result.isError), [], 'All workspace tools must succeed');
  const custom = await verifyDesktopCustom(ctx);
  const browser = process.env.DSCODE_DESKTOP_BROWSER === '1' ? await verifyDesktopBrowser(ctx) : {};
  await verifySessionCreation(ctx);
  console.log('DESKTOP_PRESET_PASSED ' + JSON.stringify({ browserPresetIsolation: true, sessionCreation: true, commandInputs, persistentShell: true, freshShell: true, bundledPatchHelper: true, freshPatchCheck: true, hostPathUnchanged: true, nativeStandardShellUnchanged: true, spawn: true, fork: true, childEffort: true, childShellIsolation: true, workspaceInstructionIsolation: true, workspaceSkillIsolation: true, workspaceHookIsolation: true, sessionStartOnce: true, workspaceDisposal: true, hubUnbundled: true, ...custom, ...browser, liveModelInference: false }));
  ctx.get('appExit')(0);
}
