import { Context } from '@deepseek-ai/cordis';
import { Session } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { TokenMeter } from '@deepseek-ai/dsh-token-meter';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import { LlmRuntime, BlockAssembler, createUserMessage, createAssistantMessage, createSystemMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm';

export const user = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dscode-eval' } });
export const visibleMessages = session => session.surface.nodes.map(seq => session.deriveEventMessage(session.eventAt(seq))).filter(Boolean);

// Detached sessions, no Host, user state, filesystem tools or live agent turns.
// Selection, token measurement, tool pairing, pruning, summary prompt and
// replacement events all come from the pinned production DSH implementation.
export function createRuntime({ policy, adapter, provider, model, contextWindow, maxTokens = 8192, tools = [], onCall = () => {} }) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx);
  new TokenMeter(ctx);
  new LlmRuntime(ctx);
  const unregister = ctx.llm.registerAdapter([provider], adapter);
  const calls = [];
  ctx.on('llm/stream', async function* (options, next) {
    const started = performance.now();
    const call = { purpose: options.purpose ?? 'probe', usage: null, status: 'error' };
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') call.usage = chunk.usage;
        if (chunk.type === 'finish') call.finish = chunk.reason.kind;
        yield chunk;
      }
      call.status = ['stop', 'tool-calls'].includes(call.finish) ? 'ok' : 'incomplete';
    } finally {
      call.elapsedMs = Math.round(performance.now() - started);
      calls.push(call); onCall(call);
    }
  });
  if (policy.compact) new ToolResultPruner(ctx, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 });
  const engine = policy.compact ? new BasicCompactionEngine(ctx, { auto: false, thresholdRatio: policy.thresholdRatio, retainRatio: policy.retainRatio, maxTokens, compactionRetries: 1 }) : null;
  const session = Session.create('compaction-eval');
  session.append('request/header', { header: { config: { provider, model }, ...(tools.length ? { tools } : {}) }, reason: 'initial' });
  const agent = { session, options: { provider, model } };
  let turn = 0;
  return {
    session, agent, engine, calls,
    initialize(system) {
      session.append('system/message', { turn: 0, step: 0, message: createSystemMessage(system, 'dscode-eval') }, { surfaceOp: 'append' });
    },
    measure: () => ctx.tokenMeter.measure(session),
    async append(message, signal) {
      signal.throwIfAborted();
      turn++;
      session.append('turn/start', { turn });
      const text = message.text.repeat(message.repeat ?? 1);
      if (message.role === 'user') session.append('user/message', user(text), { surfaceOp: 'append' });
      // Trigger at a pre-step boundary, with the new user input visible but
      // before replaying that step's assistant/tool output.
      try {
        await engine?.compactIfNeeded(agent, 'pressure', signal);
        if (message.role !== 'user') {
          session.append('step/start', { turn, step: 1 });
          const content = message.role === 'tool'
            ? [{ type: 'tool-call', id: `call-${turn}`, name: message.name, arguments: '{}' }]
            : [{ type: 'text', text }];
          session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content, source: { kind: 'model', provider, model } }) }, { surfaceOp: 'append' });
          if (message.role === 'tool') session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: `call-${turn}`, content: [{ type: 'text', text }], isError: false }) }, { surfaceOp: 'append' });
          session.append('step/end', { turn, step: 1 });
        }
      } finally { session.append('turn/end', { turn, reason: { kind: 'completed' } }); }
    },
    async answer(prompt, signal) {
      const messages = [...visibleMessages(session), user(prompt)];
      const measured = ctx.tokenMeter.measure(session).totalTokens + ctx.tokenMeter.estimateMessage(messages.at(-1));
      if (measured + 2048 > contextWindow) throw Error('probe-context-overflow');
      const assembler = new BlockAssembler();
      for await (const chunk of ctx.llm.stream({ provider, model, messages, maxTokens: 2048, signal, purpose: 'eval-probe' })) assembler.push(chunk);
      if (assembler.finish?.kind !== 'stop') throw Error('incomplete-probe-response');
      return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
    },
    async agentStep(executeTool, signal, outputTokens = 4096) {
      signal.throwIfAborted();
      turn++;
      session.append('turn/start', { turn });
      try {
        await engine?.compactIfNeeded(agent, 'pressure', signal);
        const measured = ctx.tokenMeter.measure(session).totalTokens;
        if (measured + outputTokens > contextWindow) throw Error('continuation-context-overflow');
        const assembler = new BlockAssembler();
        for await (const chunk of ctx.llm.stream({ provider, model, messages: visibleMessages(session), tools, maxTokens: outputTokens, signal, purpose: 'eval-continuation' })) assembler.push(chunk);
        const finish = assembler.finish?.kind;
        if (!['stop', 'tool-calls'].includes(finish)) throw Error('incomplete-continuation-response');
        const blocks = assembler.blocks().filter(block => ['text', 'tool-call'].includes(block.type));
        const toolCalls = blocks.filter(block => block.type === 'tool-call');
        if (finish === 'tool-calls' && !toolCalls.length) throw Error('empty-continuation-tool-call');
        session.append('step/start', { turn, step: 1 });
        try {
          session.append('assistant/message', { turn, step: 1, stream: [], message: createAssistantMessage({ content: blocks, source: { kind: 'model', provider, model } }) }, { surfaceOp: 'append' });
          const results = [];
          for (const call of toolCalls) {
            let result;
            try { result = await executeTool(call.name, call.arguments, signal); }
            catch (error) { result = { ok: false, error: error?.code ?? 'tool-error' }; }
            results.push({ name: call.name, arguments: call.arguments, result });
            session.append('tool/result', { turn, step: 1, message: createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: JSON.stringify(result) }], isError: result.ok === false }) }, { surfaceOp: 'append' });
          }
          return { done: finish === 'stop', text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''), tools: results };
        } finally { session.append('step/end', { turn, step: 1 }); }
      } finally { session.append('turn/end', { turn, reason: { kind: 'completed' } }); }
    },
    async judge(system, prompt, signal) {
      // A fresh request with no session history, tools, strategy labels or
      // compressed context. This output is never appended to the session.
      const assembler = new BlockAssembler();
      const messages = [createSystemMessage(system, 'dscode-eval-judge'), user(prompt)];
      for await (const chunk of ctx.llm.stream({ provider, model, messages, maxTokens: 4096, signal, purpose: 'eval-judge' })) assembler.push(chunk);
      if (assembler.finish?.kind !== 'stop') throw Error('incomplete-judge-response');
      return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
    },
    async close() { unregister(); await ctx.fiber.dispose(); },
  };
}
