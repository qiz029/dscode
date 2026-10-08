import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import * as diagnostics from '../plugins/tui-tools/desktop-host.mjs';
import { doctorLogPath } from '../plugins/tui-tools/doctor.mjs';

export const inject = ['llm', 'agents', 'agentPresets', 'commands', 'skills', 'systemPrompt', 'sessions', 'sessionPersistence'];
export function apply(ctx) {
  void run(ctx).catch(error => {
    console.error(error.stack);
    if (process.env.DSCODE_DIAGNOSTICS_ELECTRON) process.send({ type: 'dscode-diagnostics-failed' });
    else ctx.get('appExit')(1);
  });
}
async function run(ctx) {
  await ctx.get('loader').await();
  const handles = [], calls = [], ui = !!process.env.DSCODE_DIAGNOSTICS_UI;
  let cursor = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model,
      reasoning: { efforts: [{ id: 'low', name: 'low' }], defaultEffort: 'low' }, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const doctor = options.messages.at(-1)?.source?.kind === 'dscode-doctor';
      if (doctor) {
        calls.push(options); assert.equal(options.tools, undefined); assert.equal(options.reasoningEffort, 'low');
      }
      const load = !doctor && cursor++ === 0;
      const block = doctor ? { type: 'text', text: 'DESKTOP_DIAGNOSTIC_MODEL_OK' }
        : load ? { type: 'tool-call', id: 'diagnostic-skill-load', name: 'skill', arguments: JSON.stringify({ name: 'browser-use' }) }
          : { type: 'text', text: 'PRIVATE_ASSISTANT_BODY' };
      yield { type: 'block-start', index: 0, blockType: block.type };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: load ? 'tool-calls' : 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['desktop-diagnostics-fixture'], new Adapter());
  const make = async (id, preset, cwd = process.cwd()) => {
    const handle = await ctx.agents.create({ sessionId: id, meta: { cwd, agentPreset: preset },
      agentOptions: { provider: 'desktop-diagnostics-fixture', model: 'fixture' },
      setup: async (scope, agent) => {
        await ctx.agentPresets.mount(scope, preset);
        installModelSelection(scope, { get current() { return agent.session.requestHeader()?.config ?? agent.options; }, assembled: undefined });
      },
    });
    handles.push(handle); return handle.agent;
  };
  const command = async (agent, line) => (await ctx.commands.execute(agent, line, [], AbortSignal.timeout(15000)))?.result;
  const names = ['dscode-doctor', 'dscode-status', 'dscode-skills', 'dscode-mcp'];
  const log = ctx.logger('desktop-diagnostics-fixture');
  try {
    const agent = await make('diagnostic-current', 'dscode');
    const standard = await make('diagnostic-standard', 'standard');
    const native = ctx.commands.list(standard).filter(command => !names.includes(command.name));
    for (const name of names) {
      assert(ctx.commands.find(agent, name));
      assert.equal((await command(standard, `/${name}`)).kind, 'error');
    }
    for (const name of ['dscode-update', 'dscode-shell-exec', 'dscode-hooks']) assert(!ctx.commands.find(agent, name));
    const status = await command(agent, '/dscode-status'); assert.equal(status.kind, 'success', status.text);
    assert.match(status.text, /Workspace:/); assert.match(status.text, /preset: dscode/); assert.match(status.text, /\/dscode-doctor/);
    const hostEntries = [...ctx.get('loader').entries()].filter(entry => entry.options.group !== true);
    assert(status.text.includes(`Host plugins: ${hostEntries.filter(entry => !entry.disabled && entry.fiber?.state === 2).length} active`));
    for (const name of ['browser-use', 'dscode-computer-use']) {
      const skill = await command(agent, `/dscode-skills ${name}`); assert.equal(skill.kind, 'success', skill.text); assert.match(skill.text, /provider:/);
    }
    assert.match((await command(agent, '/dscode-skills conflicts')).text, /Incomplete:.*per-agent/);
    const mcp = await command(agent, '/dscode-mcp');
    assert.match(mcp.text, /\/dscode-mcp tools/); assert.match(mcp.text, /Host.*entries/);
    assert.equal((await command(agent, '/dscode-mcp disable dscode')).kind, 'error');
    const policy = realpathSync(fileURLToPath(import.meta.resolve('../plugins/dscode/index.mjs')));
    const bundle = resolve(dirname(policy), '../..');
    const docs = (await ctx.systemPrompt.assemble({ scope: agent })).sections.find(section => section.name === 'dscode:docs')?.text;
    assert(docs?.includes(join(bundle, 'docs')), docs);
    for (const file of ['browser-use.md', 'computer-use.md', 'tui-commands.md', 'memory.md']) assert(existsSync(join(bundle, 'docs', file)));
    assert(!existsSync(join(bundle, 'docs/verification.md')));
    assert(!((await ctx.systemPrompt.assemble({ scope: standard })).sections.some(section => section.name === 'dscode:docs')));
    // Exercise the current native tool-result schema through the actual Agent pipeline.
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_USER_BODY: load the browser-use skill only.' }] }));
    await agent.whenIdle(); await ctx.sessions.flush(agent.session);
    assert(agent.session.snapshotEvents().some(event => event.type === 'tool/result' && event.data.message.isError === false),
      JSON.stringify(agent.session.snapshotEvents().filter(event => ['tool/result', 'assistant/attempt', 'turn/end'].includes(event.type))));
    const unrelated = await make('diagnostic-unrelated', 'standard', join(process.env.DSH_HOME, 'user'));
    await ctx.sessions.flush(unrelated.session);
    log.warn('DIAGNOSTIC_MARKER api_key=sk-abcdefghijklmnop');
    const preview = await command(agent, '/dscode-doctor preview'); assert.equal(preview.kind, 'success', preview.text);
    const evidence = JSON.parse(preview.text);
    assert(evidence.traces.some(trace => trace.id === agent.id)); assert(!evidence.traces.some(trace => trace.id === unrelated.id));
    assert(evidence.traces.find(trace => trace.id === agent.id).timeline.some(event => event.type === 'tool/result'));
    assert(!evidence.traces.some(trace => trace.findings?.some(finding => /tool skill has no result/.test(finding))));
    for (const secret of ['PRIVATE_USER_BODY', 'PRIVATE_ASSISTANT_BODY', 'sk-abcdefghijklmnop']) assert(!preview.text.includes(secret));
    assert(evidence.logs.some(row => row.detail.includes('DIAGNOSTIC_MARKER')));
    assert(!readFileSync(doctorLogPath(process.env.DSH_HOME), 'utf8').includes('sk-abcdefghijklmnop'));
    const local = await command(agent, '/dscode-doctor local'); assert.equal(local.kind, 'success', local.text); assert.match(local.text, /Core tools:/);
    assert.equal(calls.length, 0);
    const modeled = await command(agent, '/dscode-doctor'); assert.equal(modeled.kind, 'success', modeled.text);
    assert.match(modeled.text, /DESKTOP_DIAGNOSTIC_MODEL_OK/); assert.equal(calls.length, 1);
    for (const secret of ['PRIVATE_USER_BODY', 'PRIVATE_ASSISTANT_BODY', 'sk-abcdefghijklmnop']) assert(!JSON.stringify(calls[0]).includes(secret));
    const entry = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'dscode-desktop-diagnostics');
    assert(entry?.fiber); await entry.fiber.dispose();
    for (const name of names) assert(!ctx.commands.find(agent, name));
    assert.deepEqual(ctx.commands.list(standard), native);
    log.warn('DIAGNOSTIC_AFTER_UNLOAD');
    assert(!readFileSync(doctorLogPath(process.env.DSH_HOME), 'utf8').includes('DIAGNOSTIC_AFTER_UNLOAD'));
    const reloaded = ctx.plugin(diagnostics); await reloaded;
    assert.equal((await command(agent, '/dscode-status')).kind, 'success');
    assert.equal((await command(standard, '/dscode-status')).kind, 'error');
    log.warn('DIAGNOSTIC_AFTER_RELOAD');
    const rows = readFileSync(doctorLogPath(process.env.DSH_HOME), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.filter(row => row.detail.includes('DIAGNOSTIC_AFTER_RELOAD')).length, 1);
    if (!ui) await reloaded.dispose();
    console.log('DESKTOP_DIAGNOSTICS_PASSED ' + JSON.stringify({ namespacedCommands: true, standardDenied: true,
      nativeCommandsPreserved: true, packedGuides: true, localDocsPrompt: true, nativeToolTrace: true,
      workspaceIsolation: true, redactedLogs: true, metadataOnlyInference: true, unloadReload: true, loggerDisposal: true }));
    if (ui) {
      await ctx.sessions.flush(agent.session);
      console.log('DESKTOP_DIAGNOSTICS_UI_READY ' + JSON.stringify({ home: process.env.DSH_HOME, sessionId: agent.id }));
      return;
    }
  } finally { if (!ui) for (const handle of handles.reverse()) await handle.dispose(); }
  if (process.env.DSCODE_DIAGNOSTICS_ELECTRON) process.send({ type: 'dscode-diagnostics-shutdown' });
  else ctx.get('appExit')(0);
}
