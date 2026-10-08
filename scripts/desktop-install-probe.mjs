import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
// Loaded by the official Electron Host after native package-manager operations.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';

export const inject = ['agents', 'agentPresets', 'llm', 'commands', 'tools', 'systemPrompt', 'subagents'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    writeFileSync(join(resolveDshHome(), 'install-probe-failure.txt'), error.stack ?? String(error));
    console.error(error);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const phase = process.env.DSCODE_INSTALL_PHASE;
  const connection = ctx.get('connection');
  const origin = `http://127.0.0.1:${ctx.get('webServer').port}`;
  const auth = await fetch(connection.authenticatedUrl(origin), { redirect: 'manual' });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const browserRpc = payload => fetch(origin + '/api/dscode-browser', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-browser', payload }),
  });
  const customRpc = payload => fetch(origin + '/api/dscode-custom', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-custom', payload }),
  });
  const custom = async payload => {
    const response = await customRpc(payload); assert.equal(response.status, 200);
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value;
  };
  const accountRpc = payload => fetch(origin + '/api/dscode-accounts', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-accounts', payload }),
  });
  const schedulingRpc = payload => fetch(origin + '/api/dscode-triggers', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-triggers', payload }),
  });
  const scheduling = async payload => {
    const response = await schedulingRpc(payload); assert.equal(response.status, 200);
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value;
  };
  const emailRpc = payload => fetch(origin + '/api/dscode-email', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-email', payload }),
  });
  const email = async payload => {
    const response = await emailRpc(payload); assert.equal(response.status, 200);
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value;
  };
  const metricsRpc = sessionId => fetch(origin + '/api/dscode-metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-metrics', payload: { action: 'status', sessionId } }),
  });
  const delegationRpc = sessionId => fetch(origin + '/api/dscode-delegation', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: origin },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'dscode-delegation', payload: { action: 'status', sessionId } }),
  });
  let customCancellationVerified = false, browserStopVerified = false, installedBrowserAccessVerified = false;
  let browserConfigurationVerified = false, browserModeSettingsVerified = false, browserTabRefreshVerified = false;
  let commandInputsVerified = false, browserResumeVerified = false, browserStatusVerified = false;
  let shellPatchVerified = false;
  if (phase === 'removed') {
    assert.equal((await browserRpc({ action: 'tabs', sessionId: 'desktop-install-preserved' })).status, 404);
    assert.equal(ctx.get('dscodeCustom'), undefined);
    assert.equal((await customRpc({ action: 'list' })).status, 404);
    assert.equal(ctx.get('sessionCommunication'), undefined);
    assert.equal(ctx.get('sessionCards'), undefined);
    assert.equal(ctx.get('dscodeOpenCodeLogin'), undefined);
    assert.equal((await accountRpc({ action: 'status' })).status, 404);
    assert.equal(ctx.get('dscodeTriggers'), undefined);
    assert.equal((await schedulingRpc({ action: 'status' })).status, 404);
    assert.equal(ctx.get('dscodeEmail'), undefined);
    assert.equal((await emailRpc({ action: 'status' })).status, 404);
    assert.equal((await metricsRpc('desktop-install-preserved')).status, 404);
    assert.equal((await delegationRpc('desktop-install-preserved')).status, 404);
    const preset = await ctx.agentPresets.resolve('dscode').catch(() => undefined);
    assert(!preset || preset.broken, 'Removed bundle still supplies its preset');
  } else {
    const meta = JSON.parse(readFileSync(join(resolveDshHome(), 'profiles/desktop/node_modules', process.env.DSCODE_INSTALL_PACKAGE, 'package.json'), 'utf8'));
    assert.equal(meta.version, process.env.DSCODE_INSTALL_VERSION);
    const preset = await ctx.agentPresets.resolve('dscode');
    assert.equal(preset.broken, undefined, preset.broken);
    const service = ctx.get('dscodeCustom');
    assert(service);
    const ids = ctx.llm.listProviders().map(row => row.id);
    for (const id of ['deepseek-official', 'dscode-openrouter', 'grok', 'dscode-opencode-go']) assert(ids.includes(id), `Missing ${id}`);
    const accountResponse = await accountRpc(phase === 'installed'
      ? { action: 'save-openrouter', key: 'desktop-lifecycle-openrouter-key' }
      : { action: 'status' });
    assert.equal(accountResponse.status, 200);
    const accounts = await accountResponse.json();
    assert.equal(accounts.result.ok, true, accounts.result.error?.message);
    assert.equal(accounts.result.value.openrouter.configured, true);
    assert(!JSON.stringify(accounts).includes('desktop-lifecycle-openrouter-key'));
    assert.equal((await ctx.get('credentials').resolve('OPENROUTER_API_KEY')).value, 'desktop-lifecycle-openrouter-key');
    // The older implementation did not persist an explicitly blank output
    // choice. Seed a numeric override when qualifying migration from that code.
    const legacyBaseline = process.env.DSCODE_INSTALL_LEGACY_BASELINE === '1';
    const userOutput = legacyBaseline ? { maxTokens: 2000, outputSource: 'user' } : { outputSource: 'user' };
    if (phase === 'installed') {
      await custom({ action: 'save', profile: {
        id: 'custom-lifecycle', name: 'Preserved Desktop model', baseURL: 'http://127.0.0.1:9/v1', api: 'chat-completions', auth: 'bearer', backend: 'omlx',
        models: [
          { id: 'lifecycle-model', contextWindow: 48000, contextSource: 'user', ...userOutput, thinking: 'on', inputModalities: ['text', 'image'] },
          { id: 'reported-model', contextWindow: 32768, contextSource: 'server', maxTokens: 8192, outputSource: 'server', thinking: 'default' },
        ],
      }, key: 'local-lifecycle-fixture-key', revision: (await custom({ action: 'list' })).revision });
    }
    const customCatalog = await custom({ action: 'list' });
    const customProfile = customCatalog.providers.find(provider => provider.id === 'custom-lifecycle');
    assert.equal(customProfile.name, 'Preserved Desktop model');
    assert.equal(customProfile.credentialStatus, 'Key saved');
    assert(!JSON.stringify(customCatalog).includes('local-lifecycle-fixture-key'));
    assert.deepEqual(customProfile.models, [
      { id: 'lifecycle-model', name: 'lifecycle-model', contextWindow: 48000, contextSource: 'user', ...userOutput, thinking: 'on', inputModalities: ['text', 'image'] },
      { id: 'reported-model', name: 'reported-model', contextWindow: 32768, contextSource: 'server', maxTokens: 8192, outputSource: 'server', thinking: 'default', inputModalities: ['text'] },
    ]);
    assert.equal(await service.resolveKey(customProfile), 'local-lifecycle-fixture-key');
    if (phase !== 'installed' || !legacyBaseline) {
      await verifyCancellation(customRpc, custom, customProfile);
      customCancellationVerified = true;
    }
    const customModels = await ctx.llm.listModels(customProfile.id);
    assert.deepEqual(customModels.map(model => model.id), ['lifecycle-model', 'reported-model']);
    const customInfo = await ctx.llm.resolveModelInfo(customProfile.id, 'lifecycle-model');
    assert.deepEqual(customInfo.inputModalities, ['text', 'image']);
    assert.equal(customInfo.context.contextWindow, 48000);
    assert.equal(customInfo.defaultMaxTokens, legacyBaseline ? 2000 : 4096);
    assert.equal(customInfo.reasoning.defaultEffort, 'high');
    const reportedInfo = await ctx.llm.resolveModelInfo(customProfile.id, 'reported-model');
    assert.deepEqual(reportedInfo.inputModalities, ['text']);
    assert.equal(reportedInfo.defaultMaxTokens, 8192);
    let inspectChild;
    class Adapter extends LlmAdapter {
      async resolveModel(provider, model) { return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 100000 } }; }
      async *stream(options) {
        if (inspectChild) await inspectChild(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'LIFECYCLE_SESSION_PRESERVED' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['lifecycle-fixture'], new Adapter());
    const setup = async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'dscode');
      installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
    };
    const handle = phase === 'installed'
      ? await ctx.agents.create({ sessionId: 'desktop-install-preserved', meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: 'lifecycle-fixture', model: 'scripted' }, setup })
      : await ctx.agents.resume({ resumeSessionId: 'desktop-install-preserved', setup });
    const agent = handle.agent;
    for (const name of ['dscode-status', 'dscode-doctor', 'dscode-skills', 'dscode-mcp']) assert(ctx.commands.find(agent, name));
    const diagnostic = await ctx.commands.execute(agent, '/dscode-status', [], AbortSignal.timeout(10000));
    assert.equal(diagnostic.result.kind, 'success', diagnostic.result.text);
    assert.match(diagnostic.result.text, /Host plugins:/);
    const docs = (await ctx.systemPrompt.assemble({ scope: agent })).sections.find(section => section.name === 'dscode:docs')?.text;
    assert(docs?.includes(`${process.env.DSCODE_INSTALL_PACKAGE}/docs/`), docs);
    assert.match(readFileSync(join(resolveDshHome(), 'profiles/desktop/node_modules', process.env.DSCODE_INSTALL_PACKAGE, 'docs/tui-commands.md'), 'utf8'), /Experimental Desktop diagnostics/);
    const emailService = ctx.get('dscodeEmail'); assert(emailService);
    for (const name of ['send_email', 'set_email_alias', 'resolve_email_recipient', 'email_send_status']) assert(ctx.tools.schemas(agent).some(tool => tool.name === name));
    const emailTool = (name, arguments_) => ctx.tools.execute({ name, arguments: arguments_, agent, callId: randomUUID(), signal: AbortSignal.timeout(10000) });
    if (phase === 'installed') {
      emailService.inbox.receive({ format: 'dscode.email.v1', connector: 'fixture', account: 'reader@example.test', id: 'lifecycle-mail',
        from: 'reviewer@example.test', subject: '[ToAgent] Preserved mail', body: 'Local lifecycle reference only.',
        receivedAt: '2026-10-06T12:00:00Z', updatedAt: '2026-10-06T12:00:00Z' });
      await email({ action: 'background', enabled: false });
      assert.equal((await emailTool('set_email_alias', { alias: 'lifecycle-reviewer', address: 'reviewer@example.test' })).isError, false);
    }
    assert.equal((await email({ action: 'status' })).enabled, false);
    const inbox = await email({ action: 'list' }); assert.equal(inbox.emails.length, 1);
    const mail = await email({ action: 'read', key: inbox.emails[0].key }); assert.equal(mail.body, 'Local lifecycle reference only.');
    const admission = await email({ action: 'inject', key: mail.key, revision: mail.revision, sessionId: agent.id, requestId: 'lifecycle-mail-admission' });
    assert.equal(admission.duplicate, phase !== 'installed');
    await agent.whenIdle();
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'dscode-email').length, 1);
    assert.equal((await emailTool('resolve_email_recipient', { to: 'lifecycle-reviewer' })).value.to, 'reviewer@example.test');
    const usageResponse = await metricsRpc(agent.id); assert.equal(usageResponse.status, 200);
    const usage = (await usageResponse.json()).result; assert(usage.ok, usage.error?.message);
    assert.equal(usage.value.sessionId, agent.id); assert(usage.value.calls > 0);
    assert(!JSON.stringify(usage).includes('LIFECYCLE_SESSION_PRESERVED'));
    if (phase === 'installed') await emailTool('delegate_board', { action: 'add', tasks: [{ title: 'Preserve delegation across installation', child: 'preserve', detail: 'Lifecycle fixture only.' }] });
    const boardResponse = await delegationRpc(agent.id); assert.equal(boardResponse.status, 200);
    const board = (await boardResponse.json()).result; assert(board.ok, board.error?.message);
    assert.equal(board.value.columns.pending.length, 1);
    assert.equal(board.value.columns.pending[0].title, 'Preserve delegation across installation');
    const coordinatorId = 'desktop-install-delegation';
    const coordinatorHandle = phase === 'installed'
      ? await ctx.agents.create({ sessionId: coordinatorId, meta: { cwd: realpathSync(join(resolveDshHome(), 'delegation-workspace')), agentPreset: 'dscode' }, agentOptions: { provider: 'lifecycle-fixture', model: 'scripted' }, setup })
      : await ctx.agents.resume({ resumeSessionId: coordinatorId, setup });
    const coordinator = coordinatorHandle.agent;
    const control = (name, args, owner = coordinator) => ctx.tools.execute({ name, arguments: args, agent: owner, callId: randomUUID(), signal: AbortSignal.timeout(30000) });
    const readBoard = async () => {
      const value = (await (await delegationRpc(coordinator.id)).json()).result;
      assert(value.ok, value.error?.message); return value.value;
    };
    const ended = new Map();
    const settlement = id => { if (!ended.has(id)) ended.set(id, Promise.withResolvers()); return ended.get(id); };
    coordinator.ctx.on('subagent/end', event => settlement(event.id).resolve());
    ctx.on('approval/request', (request, next) => ['subagent', 'bash', 'shell_retry'].includes(request.toolName) ? Promise.resolve('allowed-once') : next(), { prepend: true });
    if (['upgraded', 'rejected', 'reinstalled'].includes(phase)) {
      const hostPath = process.env.PATH;
      const file = join(agent.session.header.cwd, 'desktop-installed-patch.txt');
      writeFileSync(file, 'before\n');
      const diff = 'diff --git a/desktop-installed-patch.txt b/desktop-installed-patch.txt\n--- a/desktop-installed-patch.txt\n+++ b/desktop-installed-patch.txt\n@@ -1 +1 @@\n-before\n+after\n';
      const applied = await control('bash', { command: `apply_patch <<'PATCH'\n${diff}PATCH` }, agent);
      assert.equal(readFileSync(file, 'utf8'), 'after\n', JSON.stringify(applied));
      const checked = await control('shell_retry', { command: `apply_patch --check --reverse <<'PATCH'\n${diff}PATCH`, workdir: agent.session.header.cwd, description: 'Check the installed patch helper without writing' }, agent);
      assert.equal(checked.value?.exitCode, 0, JSON.stringify(checked));
      assert.equal(readFileSync(file, 'utf8'), 'after\n');
      assert.equal(process.env.PATH, hostPath);
      shellPatchVerified = true;
    }
    const savedChild = join(resolveDshHome(), 'delegation-install.json');
    let childState, observed = false;
    try {
      inspectChild = async ({ sessionId }) => {
        const sender = ctx.agents.get(sessionId);
        if (sender?.session.header.parentSession !== coordinator.id) return;
        observed = (await readBoard()).columns.running.some(task => task.child === 'persist');
        const shell = await control('bash', { command: (phase === 'installed' ? "printf 'DSCODE_CHILD_WORKTREE\\n' > lifecycle-child.txt\n" : '') + 'pwd -P\ncat lifecycle-child.txt' }, sender);
        assert.equal(shell.isError, false, JSON.stringify(shell));
        const output = shell.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        assert(output.includes(realpathSync(sender.session.header.cwd)), output);
        assert(output.includes('DSCODE_CHILD_WORKTREE'), output);
        assert.equal(readFileSync(join(sender.session.header.cwd, 'lifecycle-child.txt'), 'utf8'), 'DSCODE_CHILD_WORKTREE\n');
        if (phase === 'installed') {
          const question = await control('send_message', { agent_id: '/', message: 'Fixture question: reply after upgrading the installed package.' }, sender);
          assert.equal(question.isError, false, JSON.stringify(question));
        }
      };
      if (phase === 'installed') {
        assert.equal((await control('delegate_board', { action: 'add', tasks: [{ title: 'Resume installed child', child: 'persist' }] })).isError, false);
        const launched = await control('subagent', { name: 'persist', description: 'Installed lifecycle child', prompt: 'Return the scripted fixture response.', worktree: true, run_in_background: true });
        assert.equal(launched.value?.kind, 'continuable', JSON.stringify(launched));
        childState = { id: launched.value.subagentId, worktree: launched.value.worktree };
        assert(childState.worktree.startsWith(realpathSync(join(resolveDshHome(), 'delegation-workspace')) + '/'));
        writeFileSync(savedChild, JSON.stringify(childState));
      } else {
        childState = JSON.parse(readFileSync(savedChild, 'utf8'));
        assert.equal(ctx.agents.get(childState.id), undefined, 'Saved child must remain cold until explicitly addressed');
        const before = await readBoard();
        const task = [...before.columns.running, ...before.columns.verifying].find(task => task.child === 'persist');
        assert(task); assert.equal(task.worktree, childState.worktree); assert.equal(task.waiting, phase === 'upgraded');
        const duplicate = await control('subagent', { name: 'persist', description: 'Reserved alias', prompt: 'Do not start a new child.' });
        assert.equal(duplicate.isError, true); assert.equal(ctx.agents.get(childState.id), undefined);
        const delivered = await control('send_message', { agent_id: '/persist', message: 'Continue the same child after the installation operation.' });
        assert.equal(delivered.isError, false, JSON.stringify(delivered));
      }
      await settlement(childState.id).promise; await coordinator.whenIdle(); inspectChild = undefined;
      assert(observed, 'The installed child must run under its original board task');
      const after = await readBoard();
      const task = (phase === 'installed' ? after.columns.running : after.columns.verifying).find(task => task.child === 'persist');
      assert(task); assert.equal(task.worktree, childState.worktree); assert.equal(task.waiting, phase === 'installed');
      const children = await ctx.subagents.listChildren(coordinator.id);
      assert.equal(children.length, 1); assert.equal(children[0].id, childState.id);
    } finally { inspectChild = undefined; await coordinatorHandle.dispose(); }
    const schedulingState = join(resolveDshHome(), 'scheduler-install.json');
    for (const name of ['trigger_manage', 'trigger_jobs', 'trigger_scheduler', 'trigger_source']) assert(ctx.tools.schemas(agent).some(tool => tool.name === name));
    if (phase === 'installed') {
      assert.equal((await scheduling({ action: 'status' })).scheduler.enabled, false);
      await scheduling({ action: 'manage', sessionId: agent.id, args: { action: 'create', trigger_id: 'lifecycle-scheduled', definition: {
        prompt: 'Inspect the project', goal: { objective: 'Report findings' }, source: { kind: 'external' }, permission: 'read-only',
      } } });
      const queued = await scheduling({ action: 'jobs', sessionId: agent.id, args: { action: 'schedule', trigger_id: 'lifecycle-scheduled', after: '1d', idempotency_key: 'lifecycle-scheduled-once' } });
      writeFileSync(schedulingState, JSON.stringify({ jobId: queued.job.id }));
      await scheduling({ action: 'start' });
    }
    const scheduler = (await scheduling({ action: 'status' })).scheduler;
    assert.equal(scheduler.enabled, true); assert.equal(scheduler.running, true);
    const scheduled = await scheduling({ action: 'workspace', sessionId: agent.id });
    assert(scheduled.definitions.some(row => row.id === 'lifecycle-scheduled'));
    assert.equal(scheduled.jobs.find(row => row.id === JSON.parse(readFileSync(schedulingState)).jobId)?.state, 'pending');
    const communication = ctx.get('sessionCommunication');
    assert(communication);
    assert(ctx.get('sessionCards'));
    await communication.state(agent).ready;
    assert(ctx.tools.schemas(agent).some(tool => tool.name === 'bash'));
    for (const name of ['list_sessions', 'read_session', 'send_session', 'reply_session']) assert(ctx.tools.schemas(agent).some(tool => tool.name === name));
    const browserHome = join(resolveDshHome(), 'browser');
    const expectedLaunch = JSON.parse(readFileSync(join(resolveDshHome(), 'browser-install-launch.json'), 'utf8'));
    const browserCommand = async command => (await ctx.commands.execute(agent, '/browser ' + command, [], AbortSignal.timeout(30000))).result;
    const browserConfig = async command => {
      const result = await browserCommand(command + ' --json');
      assert.equal(result.kind, 'success', result.text);
      return JSON.parse(result.text).config;
    };
    assert.deepEqual(await browserConfig('status'), expectedLaunch);
    browserConfigurationVerified = true;
    if (['upgraded', 'rejected', 'reinstalled'].includes(phase)) {
      for (const [command, mode, profile] of [
        ['use persistent alternate', 'persistent', 'alternate'], ['use isolated', 'isolated', undefined],
        ['use persistent lifecycle', 'persistent', 'lifecycle'],
      ]) {
        const config = await browserConfig(command);
        assert.equal(config.mode, mode); assert.equal(config.profile, profile);
        for (const field of ['headless', 'executablePath', 'webmcp']) assert.equal(config[field], expectedLaunch[field]);
      }
      assert.deepEqual(await browserConfig('status'), expectedLaunch);
      browserModeSettingsVerified = true;
    }
    const { BrowserAccess } = await import(pathToFileURL(join(resolveDshHome(), 'profiles/desktop/node_modules', process.env.DSCODE_INSTALL_PACKAGE, 'plugins/browser/access.mjs')).href);
    const browserAccess = new BrowserAccess(browserHome);
    const permissionCommand = async command => {
      const response = await ctx.commands.execute(agent, '/browser ' + command + ' --json', [], AbortSignal.timeout(10000));
      assert.equal(response.result.kind, 'success', response.result.text);
      return JSON.parse(response.result.text).permissions;
    };
    const permissionState = join(resolveDshHome(), 'browser-install-permissions.json');
    if (phase === 'installed') {
      await permissionCommand('site allow https://lifecycle.example');
      await browserAccess.update('once', 'https://revoked.example');
      await permissionCommand('site block https://revoked.example');
      await permissionCommand('site forget https://revoked.example');
      await assert.rejects(browserAccess.checkUrl('https://revoked.example'), /needs user permission/);
      await permissionCommand('site block https://blocked.example');
      writeFileSync(permissionState, JSON.stringify((await browserAccess.read()).revocations));
    }
    const permissions = await permissionCommand('permissions');
    assert.deepEqual(permissions.sessionSites, []);
    assert.equal(permissions.revocations, undefined, 'Internal markers must not enter the displayed permission status');
    assert.deepEqual((await browserAccess.read()).revocations, JSON.parse(readFileSync(permissionState, 'utf8')));
    await browserAccess.checkUrl('https://lifecycle.example');
    await assert.rejects(browserAccess.checkUrl('https://revoked.example'), /needs user permission/);
    await assert.rejects(browserAccess.checkUrl('https://blocked.example'), /blocked/);
    for (const file of ['permissions.json', 'permissions.guard.sqlite']) assert.equal(statSync(join(browserHome, file)).mode & 0o777, 0o600);
    const previewResponse = await browserRpc({ action: 'tabs', sessionId: agent.id });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()).result;
    assert.equal(preview.ok, false); assert.match(preview.error.message, /Start this session/);
    // The installed baseline may predate the sidebar stop action. All later
    // installed phases carry the current implementation, including rejection.
    if (['upgraded', 'rejected', 'reinstalled'].includes(phase)) {
      const inputNames = ['browser', 'computer', 'delegate', 'shell', 'review', 'opencode', 'memories', 'mailbox', 'trigger', 'triggers', 'dscode-doctor', 'dscode-mcp', 'dscode-skills'];
      const catalog = ctx.commands.list(agent);
      assert.deepEqual(inputNames.filter(name => !catalog.find(command => command.name === name)?.input?.hint), []);
      assert(inputNames.every(name => catalog.find(command => command.name === name).input.attachments !== true));
      commandInputsVerified = true;
      if (phase === 'reinstalled' && process.env.DSCODE_TEST_CHROME) {
        const started = await browserCommand('start');
        assert.equal(started.kind, 'success', started.text);
        const { browserForAgent } = await import(pathToFileURL(join(resolveDshHome(), 'profiles/desktop/node_modules', process.env.DSCODE_INSTALL_PACKAGE, 'plugins/browser/review.mjs')).href);
        const browser = browserForAgent(agent), nativeCall = browser.client.callTool;
        browser.client.callTool = async (request, ...rest) => request.name === 'list_pages'
          ? { isError: true, content: [{ type: 'text', text: 'Fixture installed page list unavailable' }] }
          : nativeCall.call(browser.client, request, ...rest);
        try {
          for (const command of ['tabs', 'tabs --json']) {
            const failed = await browserCommand(command);
            assert.equal(failed.kind, 'error'); assert.match(failed.text, /Could not refresh browser tabs/);
          }
          const failed = await ctx.tools.execute({ name: 'browser_tabs', arguments: { action: 'status' }, agent,
            callId: randomUUID(), signal: AbortSignal.timeout(10000) });
          assert.equal(failed.isError, true); assert.match(JSON.stringify(failed), /Could not refresh browser tabs/);
        } finally { browser.client.callTool = nativeCall; }
        assert.equal((await browserCommand('tabs')).kind, 'success');
        const recovered = await ctx.tools.execute({ name: 'browser_tabs', arguments: { action: 'status' }, agent,
          callId: randomUUID(), signal: AbortSignal.timeout(10000) });
        assert.equal(recovered.isError, false); assert(recovered.value.pages.length > 0);
        browserTabRefreshVerified = true;
      }
      if (process.env.DSCODE_TEST_CHROME) {
        if (phase !== 'reinstalled') {
          const started = await browserCommand('start');
          assert.equal(started.kind, 'success', started.text);
        }
        const rpc = async (action, args = {}) => {
          const response = await browserRpc({ action, sessionId: agent.id, ...args });
          assert.equal(response.status, 200);
          return (await response.json()).result;
        };
        const listed = await rpc('tabs'); assert(listed.ok, listed.error?.message);
        const pageId = listed.value.pages[0].id;
        const captured = await rpc('capture', { pageId }); assert(captured.ok, captured.error?.message);
        assert.match((await browserCommand('permissions')).text, /^Browser: connected/);
        const beforeExternalEdit = await browserAccess.status();
        try {
          await browserAccess.update('developer-mode', beforeExternalEdit.developerMode ? 'off' : 'on');
          const observed = await rpc('handoff'); assert(observed.ok, observed.error?.message);
          assert.equal(observed.value.permissions.developerMode, !beforeExternalEdit.developerMode);
          assert.equal(JSON.parse((await browserCommand('permissions --json')).text).connected, true);
        } finally { await browserAccess.update('developer-mode', beforeExternalEdit.developerMode ? 'on' : 'off'); }
        const paused = await browserCommand(`handoff ${pageId}`);
        assert.equal(paused.kind, 'success', paused.text);
        assert.match((await browserCommand('permissions')).text, /^Browser: waiting for you/);
        assert.equal((await rpc('handoff')).value.handoff.pageId, pageId);
        assert.equal((await rpc('capture', { pageId })).ok, false);
        const beforeResume = agent.session.snapshotEvents().length;
        const resumed = await rpc('resume'); assert(resumed.ok, resumed.error?.message);
        assert.match(resumed.value.message, /Browser control resumed/);
        assert.equal(agent.session.snapshotEvents().slice(beforeResume).find(event => event.type === 'command/done')?.data.text, resumed.value.message);
        assert.equal((await rpc('handoff')).value.handoff, null);
        const stale = await rpc('annotate', { annotation: { token: captured.value.token, x: 0.5, y: 0.5, text: 'Stale installed preview' } });
        assert.equal(stale.ok, false); assert.match(stale.error.message, /expired|replaced/);
        const fresh = await rpc('capture', { pageId }); assert(fresh.ok, fresh.error?.message);
        browserResumeVerified = true;
      }
      const beforeStop = agent.session.snapshotEvents().length;
      const response = await browserRpc({ action: 'stop', sessionId: agent.id });
      assert.equal(response.status, 200);
      const stopped = (await response.json()).result;
      assert(stopped.ok, stopped.error?.message);
      assert.match(stopped.value.message, /^Browser: disconnected/);
      const done = agent.session.snapshotEvents().slice(beforeStop).find(event => event.type === 'command/done');
      assert.equal(done?.data.text, stopped.value.message);
      browserStopVerified = true;
      assert.match((await browserCommand('permissions')).text, /^Browser: disconnected/);
      browserStatusVerified = Boolean(process.env.DSCODE_TEST_CHROME);
    }
    if (phase === 'installed') {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep this session across a Desktop plugin upgrade.' }] }));
      await agent.whenIdle();
    }
    assert(agent.session.snapshotEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.text === 'LIFECYCLE_SESSION_PRESERVED')));
    const sender = phase === 'installed'
      ? await ctx.agents.create({ sessionId: 'desktop-install-sender', meta: { cwd: process.cwd(), agentPreset: 'dscode' }, agentOptions: { provider: 'lifecycle-fixture', model: 'scripted' }, setup })
      : await ctx.agents.resume({ resumeSessionId: 'desktop-install-sender', setup });
    await communication.state(sender.agent).ready;
    if (phase === 'installed') {
      sender.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Send the other fixture session a deferred note.' }] }));
      await sender.agent.whenIdle();
    }
    const args = { session_id: agent.id, kind: 'notify', mode: 'defer', text: 'LIFECYCLE_DEFERRED_ONCE', idempotency_key: 'lifecycle-deferred-once' };
    const result = await ctx.tools.execute({ name: 'send_session', arguments: args, agent: sender.agent, callId: randomUUID(), signal: AbortSignal.timeout(10000) });
    assert.equal(result.isError, false, JSON.stringify(result));
    const sent = result.value;
    assert.equal(sent.delivery, 'accepted', JSON.stringify(sent));
    assert.equal(sent.wake, false);
    const saved = join(resolveDshHome(), 'deferred-message.json');
    if (phase === 'installed') writeFileSync(saved, JSON.stringify({ messageId: sent.messageId }));
    else {
      assert.equal(sent.messageId, JSON.parse(readFileSync(saved, 'utf8')).messageId);
      assert.equal(sent.duplicate, true);
    }
    const occurrences = () => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.communicationId === sent.messageId);
    assert.equal(agent.status, 'idle');
    assert.equal(occurrences().length, 0, 'A deferred note woke the restored session');
    assert.equal(communication.store.get(sent.messageId).delivery, 'accepted');
    for (const command of ['/session', '/mailbox', '/tasks']) {
      const response = await ctx.commands.execute(agent, command, [], AbortSignal.timeout(10000));
      assert.equal(response.result.kind, 'success', response.result.text);
      if (command === '/session') assert(response.result.text.includes('--home '));
      if (command === '/mailbox') assert(response.result.text.includes(sent.messageId));
    }
    if (phase === 'reinstalled') {
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Now read the preserved note.' }] }));
      await agent.whenIdle();
      for (let i = 0; i < 100 && communication.store.get(sent.messageId).delivery !== 'consumed'; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(communication.store.get(sent.messageId).delivery, 'consumed');
      assert.equal(occurrences().length, 1);
    }
    await sender.dispose();
    await handle.dispose();
  }
  if (phase === 'reinstalled' && process.env.DSCODE_TEST_CHROME) {
    const { verifyBrowserAccess } = await import('./browser-access-probe.mjs');
    await verifyBrowserAccess(join(resolveDshHome(), 'profiles/desktop/node_modules', process.env.DSCODE_INSTALL_PACKAGE));
    installedBrowserAccessVerified = true;
  }
  writeFileSync(join(resolveDshHome(), 'install-probe-result.json'), JSON.stringify({ phase, version: process.env.DSCODE_INSTALL_VERSION, nativeHost: true, customCancellationVerified, browserStopVerified, installedBrowserAccessVerified, browserConfigurationVerified, browserModeSettingsVerified, browserTabRefreshVerified, commandInputsVerified, browserResumeVerified, browserStatusVerified, shellPatchVerified }));
  console.log('DESKTOP_INSTALL_PROBE_PASSED ' + phase);
}


// Exercise installed Host code through authenticated RPC, keeping the original
// request open so only the explicit cancellation message can stop inference.
async function verifyCancellation(customRpc, custom, savedProfile) {
  let pending, held;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer local-lifecycle-fixture-key') {
      response.writeHead(401); response.end(); return;
    }
    if (held) {
      const current = held;
      if (current.action === 'metadata' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'lifecycle-model', owned_by: 'omlx', context_window: 48000 }] }));
        return;
      }
      const expected = current.action === 'discover' ? '/v1/models' : current.action === 'metadata' ? '/v1/models/status' : '/v1/chat/completions';
      if (request.url !== expected) { response.writeHead(404); response.end(); return; }
      response.once('close', () => current.closed.resolve());
      request.resume();
      current.started.resolve();
      return;
    }
    if (request.url !== '/v1/models') { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'lifecycle-model', context_window: 48000 }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // The saved fixture deliberately has an oMLX thinking override. The generic
  // cancellation server needs a separate draft with the provider default.
  const profile = { ...savedProfile, backend: 'generic', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    models: savedProfile.models.map(model => ({ ...model, thinking: 'default' })) };
  const deadline = async (promise, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 5000); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    for (const action of ['discover', 'metadata', 'test']) {
      held = { action, started: Promise.withResolvers(), closed: Promise.withResolvers() };
      const requestId = randomUUID();
      pending = customRpc({ action: action === 'metadata' ? 'discover' : action, requestId, profile, model: 'lifecycle-model' })
        .then(async response => { assert.equal(response.status, 200); return (await response.json()).result; })
        .then(result => ({ result }), error => ({ error }));
      await deadline(Promise.race([held.started.promise, pending.then(outcome => {
        throw Error(`Installed ${action} settled before reaching the model server: ${JSON.stringify(outcome.result ?? { error: outcome.error?.message })}`);
      })]), `Installed ${action} never reached the model server`);
      await custom({ action: 'cancel', requestId });
      await deadline(held.closed.promise, `Installed ${action} cancellation did not close model HTTP`);
      const outcome = await deadline(pending, `Cancelled ${action} RPC did not settle`);
      assert(!outcome.error, outcome.error?.message);
      if (action !== 'test') {
        assert.equal(outcome.result.ok, false);
        assert.match(outcome.result.error.message, /cancelled/i);
      } else {
        assert.equal(outcome.result.ok, true);
        assert.deepEqual(outcome.result.value, [{ name: 'Probe', status: 'failed', message: 'Cancelled' }]);
      }
      held = null;
      const retry = await custom({ action: 'discover', requestId: randomUUID(), profile });
      assert.equal(retry.models[0].id, 'lifecycle-model');
      assert.equal(retry.models[0].contextWindow, 48000);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (pending) await deadline(pending, 'Fixture request remained open after cleanup');
  }
}
