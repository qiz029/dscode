// Host-side half of `dscode exec`: one prompt, one turn, streamed to stdout,
// then the Host exits with a code that reflects how the turn ended. Loaded
// through a --patch overlay; the CLI half lives in scripts/exec.mjs.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

export const name = 'dscode-exec';
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'permissionPresets'];

export function apply(ctx) {
  void run(ctx).catch(error => { process.stderr.write(`dscode exec: ${error.message}\n`); ctx.get('appExit')(1); });
}

export function exitCodeFor(reason) {
  if (!reason || reason.kind === 'completed' || reason.kind === 'stop') return 0;
  if (reason.kind === 'error') return 1;
  if (reason.kind === 'max-tokens') return 2;
  if (reason.kind === 'aborted' || reason.kind === 'interrupted') return 130;
  return 3;
}

export function toolPreview(toolName, rawArguments) {
  let args;
  try { args = typeof rawArguments === 'string' ? JSON.parse(rawArguments) : rawArguments; } catch { args = undefined; }
  const pick = args && typeof args === 'object' ? args.description ?? args.command ?? args.prompt ?? args.query ?? args.path ?? '' : '';
  const text = String(pick ?? '').replace(/\s+/g, ' ').trim();
  return `→ ${toolName}${text ? ' ' + (text.length > 120 ? text.slice(0, 119) + '…' : text) : ''}`;
}

export function messageText(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
}

async function run(ctx) {
  await ctx.get('loader').await();
  const options = JSON.parse(readFileSync(process.env.DSCODE_EXEC_OPTIONS, 'utf8'));
  const prompt = readFileSync(options.promptFile, 'utf8');
  const selection = ctx.agentDefaultModel.currentSelection();
  const [provider, model] = options.model ? splitRoute(options.model) : [selection.provider, selection.model];
  const effort = options.effort ?? selection.reasoningEffort;
  const agentOptions = { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
  const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'dscode'); };
  const handle = options.resume
    ? await ctx.agents.resume({ resumeSessionId: options.resume, agentOptions, setup })
    : await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: options.cwd, agentPreset: 'dscode' }, agentOptions, setup });
  const agent = handle.agent;
  const session = agent.session;
  if (options.permission) { ctx.permissionPresets.resolve(options.permission); ctx.permissionPresets.set(session, options.permission); }

  const out = text => new Promise(resolve => process.stdout.write(text, () => resolve()));
  const err = text => { process.stderr.write(text); };
  const emit = value => out(JSON.stringify(value) + '\n');
  let streamed = false, column = 0, lastText = '', finished = false;
  const disposers = [];
  const finish = async reason => {
    if (finished) return; finished = true;
    for (const dispose of disposers) dispose();
    if (options.json) await emit({ type: 'result', sessionId: session.id, reason: reason?.kind ?? 'completed', text: lastText, ...(reason?.kind === 'error' ? { error: `${reason.error?.code ?? 'ERROR'}: ${reason.error?.message ?? ''}` } : {}) });
    else {
      if (column > 0) await out('\n');
      if (reason?.kind === 'error') err(`error: ${reason.error?.code ?? 'ERROR'}: ${reason.error?.message ?? ''}\n`);
      else if (reason && reason.kind !== 'completed' && reason.kind !== 'stop') err(`turn ended: ${reason.kind}\n`);
      if (!options.quiet) err(`session ${session.id}\n`);
    }
    await out('');
    ctx.get('appExit')(exitCodeFor(reason));
  };
  disposers.push(ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
    if (source.id !== agent.id || frame.type !== 'chunk' || frame.chunk?.type !== 'text-delta' || !frame.chunk.text) return;
    streamed = true;
    if (options.json) void emit({ type: 'text', text: frame.chunk.text });
    else { column = frame.chunk.text.endsWith('\n') ? 0 : column + frame.chunk.text.length; void out(frame.chunk.text); }
  }));
  disposers.push(ctx.on('session/event', (source, event) => {
    if (source.id !== session.id) return;
    if (event.type === 'step/start') streamed = false;
    else if (event.type === 'assistant/message') {
      const text = messageText(event.data.message);
      if (text) lastText = text;
      if (text && !streamed) {
        if (options.json) void emit({ type: 'text', text });
        else { void out(text.endsWith('\n') ? text : text + '\n'); column = 0; }
      } else if (!options.json && column > 0) { void out('\n'); column = 0; }
      streamed = false;
    } else if (event.type === 'tool/call') {
      if (options.json) void emit({ type: 'tool', name: event.data.name, arguments: event.data.arguments });
      else if (!options.quiet) err(toolPreview(event.data.name, event.data.arguments) + '\n');
    } else if (event.type === 'turn/end') void finish(event.data.reason);
  }));
  disposers.push(ctx.on('session/disposed', source => { if (source.id === session.id) void finish({ kind: 'interrupted' }); }));
  disposers.push(ctx.on('approval/request', (request, next) => {
    if (request.agent?.id !== agent.id) return next();
    if (options.approveAll) return 'allowed-once';
    err(`approval needed for ${request.toolName}: rejected (no human present; rerun with --approve-all or use the TUI)\n`);
    return 'rejected';
  }));
  if (options.timeoutMs > 0) setTimeout(() => { err(`dscode exec: timed out after ${Math.round(options.timeoutMs / 1000)}s\n`); ctx.get('appExit')(124); }, options.timeoutMs).unref();
  if (options.json) await emit({ type: 'session', sessionId: session.id, provider, model, ...(effort ? { effort } : {}) });
  agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }));
}

function splitRoute(value) {
  const at = value.indexOf('/');
  if (at <= 0 || at === value.length - 1) throw new Error(`--model expects provider/model, got ${value}`);
  return [value.slice(0, at), value.slice(at + 1)];
}
