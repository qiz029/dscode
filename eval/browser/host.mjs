import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { BudgetAdapter } from '../compaction/adapters.mjs';
import { EVAL_KEY_ENV, EVAL_PROVIDER, liveAdapter } from './routes.mjs';
import { BrowserAccess } from '../../plugins/browser/access.mjs';
import { browserHome } from '../../plugins/browser/config.mjs';
import { createFixture } from './fixture.mjs';
import { ScriptedAdapter } from './scripted.mjs';
import { redact } from '../../plugins/auto-review/policy.mjs';

export const name = 'browser-evaluation';
export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'permissionPresets', 'commands'];
const browserTools = new Set(['browser_start', 'browser_stop', 'browser_tabs', 'browser_handoff']);
const rawTools = new Set(['list_pages', 'new_page', 'select_page', 'close_page', 'navigate_page', 'take_snapshot', 'take_screenshot', 'click', 'fill', 'fill_form', 'press_key', 'hover', 'wait_for', 'handle_dialog', 'resize_page']);
export const allowedTool = tool => browserTools.has(tool) || (tool.startsWith('mcp__browser__') && rawTools.has(tool.slice('mcp__browser__'.length)));
export const redactedJson = (value, key, space) => JSON.stringify(value, (_name, item) => typeof item === 'string' ? redact(item).split(key || '\u0000').join('[redacted]') : item, space);

class BrowserAdapter extends BudgetAdapter {
  async *stream(options) {
    // Session titles are irrelevant to task quality and must not consume a paid
    // evaluation call. All actual task/compaction calls remain budgeted.
    if (options.purpose === 'session-title') {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Browser evaluation' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    yield* super.stream({ ...options, tools: options.tools?.filter(tool => allowedTool(tool.name)) });
  }
}

export function actionDenial(name, args, origin) {
  if (!allowedTool(name)) return 'This browser evaluation permits only browser observation and ordinary UI interaction.';
  if (Object.keys(args).some(key => /file|path/i.test(key))) return 'This evaluation does not export or upload files.';
  if (args.url !== undefined) {
    try { if (new URL(args.url).origin !== origin) return 'Only this case\'s loopback website is in scope.'; }
    catch { return 'Use an absolute URL on this case\'s loopback website.'; }
  }
}

export function apply(ctx) {
  void run(ctx).catch(() => {
    // The parent keeps the partial manifest and traces. Never print a provider
    // exception that could include a credential or request headers.
    console.error('Browser evaluation host failed; inspect the partial report.');
    ctx.get('appExit')(1);
  });
}

async function run(ctx) {
  await ctx.get('loader').await();
  const options = JSON.parse(readFileSync(process.env.DSCODE_BROWSER_EVAL_OPTIONS, 'utf8'));
  const key = process.env[EVAL_KEY_ENV];
  const safeText = text => redact(text).split(key || '\u0000').join('[redacted]');
  const rows = [];
  const save = () => writeFileSync(join(options.out, 'results.json'), redactedJson({
    backend: options.route.backend,
    qualityScore: options.selfTest || rows.length !== options.cases.length || rows.some(row => ['evaluation-runtime-error', 'agent-or-provider-error'].includes(row.error)) ? null : rows.filter(row => row.success).length / rows.length,
    infrastructurePassed: rows.length === options.cases.length && rows.every(row => row.success),
    rows,
  }, key, 2) + '\n');
  save();
  for (const id of options.cases) {
    const site = await createFixture(id);
    // Fixture-only consent; never broadens the user's own browser permissions.
    await new BrowserAccess(browserHome()).update('allow', site.origin);
    const started = performance.now();
    const budget = { used: 0, limit: options.maxCalls };
    const row = { id, success: false, modelCalls: 0, toolCalls: 0, toolErrors: 0, approvals: 0, handoffs: 0, elapsedMs: 0, usage: [], stopReason: null, error: null, finalText: '' };
    let agent, handle, latest, timer, exceeded = false;
    const disposers = [];
    const trace = value => appendFileSync(join(options.out, 'traces.jsonl'), redactedJson({ case: id, at: new Date().toISOString(), ...value }, key) + '\n');
    try {
      const adapter = options.selfTest ? new ScriptedAdapter(id, site.origin, () => latest)
        : liveAdapter(options.route, options, ctx, key);
      disposers.push(ctx.llm.registerAdapter([EVAL_PROVIDER], new BrowserAdapter(adapter, budget, options.callTimeoutMs)));
      handle = await ctx.agents.create({ sessionId: `browser-eval-${id}`, meta: { cwd: options.workspace, agentPreset: 'dscode' }, agentOptions: { provider: EVAL_PROVIDER, model: options.model }, setup: async (agentCtx, current) => {
        await ctx.agentPresets.mount(agentCtx, 'dscode');
        installModelSelection(agentCtx, { get current() { return current.session.requestHeader()?.config ?? current.options; }, assembled: undefined });
        agentCtx.tools.restrict({ allow: [...browserTools] });
        agentCtx.tools.guard(exec => actionDenial(exec.name, exec.arguments, site.origin));
      } });
      agent = handle.agent;
      // Exercise ordinary approval dispatch, but the fixture itself grants only
      // its small UI allowlist. There are no external accounts or real purchases.
      ctx.permissionPresets.set(agent.session, 'workspace-write');
      disposers.push(ctx.on('approval/request', (req, next) => {
        if (req.agent?.id !== agent.id) return next();
        row.approvals++;
        return 'allowed-once';
      }, { prepend: true }));
      disposers.push(ctx.on('tools/pre-execute', (exec, next) => {
        if (exec.agent?.id !== agent.id) return next();
        row.toolCalls++;
        trace({ type: 'tool-call', name: exec.name, arguments: exec.arguments });
        if (row.toolCalls > options.maxTools) { exceeded = true; return { kind: 'deny', reason: 'Browser evaluation tool budget exhausted.' }; }
        return next();
      }, { prepend: true }));
      disposers.push(ctx.on('tools/result', (exec, result) => {
        if (exec.agent?.id !== agent.id) return;
        latest = result;
        if (result.isError) row.toolErrors++;
        if (exec.name === 'browser_handoff' && !result.isError) row.handoffs++;
        trace({ type: 'tool-result', name: exec.name, isError: result.isError, text: safeText(result.content.filter(b => b.type === 'text').map(b => b.text).join('\n')).slice(0, 16000) });
        if (exceeded) agent.cancel({ kind: 'hook', reason: 'Browser evaluation tool budget exhausted.' });
      }));
      disposers.push(ctx.on('session/event', (session, event) => {
        if (session.id !== agent.session.id) return;
        if (event.type === 'assistant/message') {
          const text = event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
          if (text) row.finalText = safeText(text);
        }
        if (event.type === 'turn/end') {
          row.stopReason = event.data.reason?.kind ?? 'completed';
          const code = event.data.reason?.error?.code;
          if (typeof code === 'string' && /^[A-Z_0-9-]{1,64}$/.test(code)) row.errorCode = code;
        }
      }));
      disposers.push(ctx.on('llm/stream', async function* (request, next) {
        if (request.provider !== EVAL_PROVIDER) { yield* next(); return; }
        for await (const chunk of next()) {
          if (chunk.type === 'usage') row.usage.push(chunk.usage);
          yield chunk;
        }
      }));
      trace({ type: 'task', prompt: site.prompt });
      timer = setTimeout(() => { exceeded = true; agent.cancel({ kind: 'hook', reason: 'Browser evaluation case deadline.' }); }, options.caseTimeoutMs);
      agent.followup(createUserMessage({ content: [{ type: 'text', text: site.prompt }], source: { kind: 'user' } }));
      await agent.whenIdle();
      clearTimeout(timer);
      const tabs = (await ctx.commands.execute(agent, '/browser tabs --json', [], new AbortController().signal)).result;
      const observed = tabs.kind === 'success' ? JSON.parse(tabs.text).pages : [];
      row.oracle = site.judge(row.finalText, observed);
      row.success = row.oracle.success && !exceeded && ['completed', 'stop'].includes(row.stopReason);
      if (exceeded || (budget.used >= budget.limit && row.stopReason === 'error')) row.error = 'budget-or-deadline';
      else if (!['completed', 'stop'].includes(row.stopReason)) row.error = 'agent-or-provider-error';
    } catch (error) { row.error = 'evaluation-runtime-error'; if (options.selfTest) row.errorDetail = redact(error.message).slice(0, 1000); }
    finally {
      clearTimeout(timer);
      row.oracle ??= site.judge(row.finalText);
      row.serverState = site.inspect();
      if (agent) {
        await ctx.commands.execute(agent, '/browser stop', [], new AbortController().signal).catch(() => {});
        await handle.dispose().catch(() => {});
      }
      for (const dispose of disposers.reverse()) dispose();
      await site.close();
      row.modelCalls = budget.used;
      row.elapsedMs = Math.round(performance.now() - started);
      rows.push(row); save();
      console.log(`BROWSER_EVAL_CASE: ${id} ${row.success ? 'pass' : 'fail'}; calls=${row.modelCalls}; tools=${row.toolCalls}; elapsed=${row.elapsedMs}ms`);
    }
  }
  console.log('BROWSER_EVAL_FINISHED');
  ctx.get('appExit')(rows.every(row => row.success) ? 0 : 1);
}
