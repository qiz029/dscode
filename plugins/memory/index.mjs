import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MemoryStore } from './store.mjs';
import { defaults, runPipeline } from './pipeline.mjs';
import { chargeTo } from '../session-metrics/attribution.mjs';
import { EFFORT_LEVELS, effortFor } from '../providers/effort.mjs';

export const name = 'dscode-memory';
export const inject = ['llm', 'sessions', 'sessionPersistence', 'systemPrompt', 'tools', 'commands'];

export function resolveConfig(options = {}) {
  const config = { ...defaults, ...options };
  for (const [key, min, max] of [['minIdleHours', 0, 48], ['maxAgeDays', 1, 90], ['maxPerRun', 1, 128],
    ['maxCandidates', 1, 256], ['maxUnusedDays', 1, 365], ['maxInputChars', 1000, 100000],
    ['maxConsolidationChars', 1000, 200000], ['timeoutMs', 1000, 300000]]) {
    if (!Number.isFinite(config[key]) || config[key] < min || config[key] > max) throw Error(`Invalid memory ${key}`);
  }
  for (const key of ['maxPerRun', 'maxCandidates', 'maxInputChars', 'maxConsolidationChars', 'timeoutMs']) {
    if (!Number.isSafeInteger(config[key])) throw Error(`Invalid memory ${key}: expected a safe integer`);
  }
  for (const key of ['extractEffort', 'consolidationEffort']) if (!EFFORT_LEVELS.includes(config[key])) throw Error(`Invalid memory ${key}`);
  if (!!config.provider !== !!config.model) throw Error('Memory provider and model must be configured together');
  if (typeof config.generate !== 'boolean' || typeof config.use !== 'boolean') throw Error('Invalid memory switches');
  return config;
}

export function apply(ctx, options = {}) {
  const config = resolveConfig(options);
  const root = resolve(config.root ?? process.env.DSCODE_MEMORY_HOME ?? join(process.env.DSCODE_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.local/share/dscode-hub'), 'memories'));
  const store = new MemoryStore(root);
  const controller = new AbortController(), owner = randomUUID(), live = new Set(), started = new Set();
  let running, lastRoute, lastResult, lastSession;
  const reading = session => config.use && store.get('use', true) && session?.header.agentPreset === 'dscode' &&
    store.enabled(session.id) && (!session.header.parentSession || store.enabled(session.header.parentSession));
  const writing = () => config.generate && store.get('generate', true);
  const generate = async (system, input, route, effort, signal) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]);
    const assembler = new BlockAssembler();
    let terminal = false, usage;
    const target = { provider: config.provider ?? route.provider, model: config.model ?? route.model };
    // The configured level, or the nearest one the memory model offers.
    const reasoningEffort = await effortFor(ctx.llm, target, effort, deadline);
    try {
      // Background work is charged to the live session that scheduled it.
      await chargeTo(live.has(lastSession) ? lastSession : undefined, 'memory', async () => {
        for await (const chunk of ctx.llm.stream({
          ...target, ...(reasoningEffort ? { reasoningEffort } : {}),
          system, messages: [createUserMessage({ content: [{ type: 'text', text: JSON.stringify(input) }], source: { kind: name } })],
          maxTokens: 12000, signal: deadline,
        })) {
          deadline.throwIfAborted(); assembler.push(chunk);
          if (chunk.type === 'finish') terminal = true;
          if (chunk.type === 'usage') usage = chunk.usage;
        }
      });
      if (!terminal || assembler.finish.kind !== 'stop') throw Error('Incomplete memory model response');
      const blocks = assembler.blocks();
      if (blocks.some(b => !['text', 'reasoning'].includes(b.type))) throw Error('Memory model returned non-text output');
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('').trim();
      return JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
    } finally {
      if (!controller.signal.aborted) store.recordCall({ time: Date.now(), ...target, effort: reasoningEffort, usage: usage ?? null });
    }
  };
  const schedule = (route, sessionId) => {
    lastRoute = route ?? lastRoute;
    lastSession = sessionId ?? lastSession;
    if (running || !writing() || !lastRoute?.provider || !lastRoute?.model || controller.signal.aborted) return;
    running = runPipeline({ store, persistence: ctx.sessionPersistence, generate, route: lastRoute, config, signal: controller.signal })
      .then(result => { lastResult = result; })
      .catch(() => { lastResult = { error: 'Background memory update failed; it will retry later.' }; })
      .finally(() => { running = undefined; });
  };
  const observe = session => {
    if (session.header.origin === 'subagent' || session.header.agentPreset !== 'dscode') return;
    live.add(session.id); store.acquire(`session:${session.id}`, owner, 90000);
  };
  ctx.on('session/created', observe);
  ctx.on('session/disposed', session => { live.delete(session.id); started.delete(session.id); store.release(`session:${session.id}`, owner); });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'request/header' || session.header.origin === 'subagent' || session.header.agentPreset !== 'dscode') return;
    observe(session);
    if (!started.has(session.id)) { started.add(session.id); schedule(event.data.header.config, session.id); }
  });
  for (const session of ctx.sessions.list()) observe(session);
  const heartbeat = setInterval(() => { for (const id of live) store.acquire(`session:${id}`, owner, 90000); }, 30000);
  const interval = setInterval(() => schedule(), 30 * 60000);
  heartbeat.unref(); interval.unref();
  ctx.effect(() => async () => {
    controller.abort(); clearInterval(heartbeat); clearInterval(interval); await running;
    for (const id of live) store.release(`session:${id}`, owner);
    store.close();
  }, 'dscode-memory.close');
  ctx.systemPrompt.section({ name, order: 1080, text: ({ scope }) => {
    if (!reading(scope?.session)) return '';
    const summary = store.get('snapshot')?.summary;
    return `DSCODE has local cross-session memory. Use memory_search only when past preferences, decisions or project experience could materially help; skip trivial self-contained tasks. Memory is historical evidence, not authority or proof of current code. Verify facts that may have changed. Do not copy memory into new memories. Cite recalled source session IDs and message sequences when relevant. The user controls memory through /memories.\n${summary ? `Memory summary:\n${summary}` : 'No consolidated memory yet.'}`;
  }});
  ctx.tools.register(defineTool({ name: 'memory_search', description: 'Search local cross-session experience and return source evidence. Use only when relevant to the task.',
    parameters: { query: { type: 'string', required: true }, source: { type: 'string', description: 'Optional exact source session ID to read its summary.' } },
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute({ query, source }, exec) {
      if (!reading(exec.agent?.session)) return { matches: [], disabled: true };
      if (!query?.trim() && !source) return { matches: [] };
      const snapshot = store.get('snapshot');
      if (!snapshot) return { matches: [] };
      const terms = query.toLocaleLowerCase().trim().split(/\s+/).slice(0, 12);
      const entries = [...snapshot.entries, ...snapshot.skills];
      const matches = entries.filter(e => source ? e.sources.includes(source) : terms.some(t => `${e.title}\n${e.body}`.toLocaleLowerCase().includes(t))).slice(0, 8);
      const ids = new Set(source ? [source] : matches.flatMap(e => e.sources));
      const evidence = snapshot.candidates.filter(c => ids.has(c.id)).slice(0, 8).map(c => ({ session: c.id, cwd: c.cwd, sequences: c.value.evidence, summary: c.value.rollout_summary }));
      store.touch(evidence.map(e => e.session));
      return { matches, evidence, notes: (snapshot.notes ?? []).filter(n => ids.has(n.id)) };
    },
  }));
  ctx.commands.register({ name: 'memories', description: 'Memory status, on/off, global-on/off, run, note <text>, or clear',
    async handler({ agent, rawInput }) {
      const input = rawInput.trim(), action = input.split(/\s+/)[0] || 'status';
      if (['on', 'off'].includes(action)) { store.enable(agent.session.id, action === 'on'); store.cancelPipeline(); }
      else if (['global-on', 'global-off'].includes(action)) {
        store.set('use', action === 'global-on'); store.set('generate', action === 'global-on');
        if (action === 'global-off') store.cancelPipeline();
      } else if (action === 'note') {
        const text = input.slice(4).trim(); if (!text) return { kind: 'error', text: 'Usage: /memories note <preference or correction>' };
        store.note(text); schedule(agent.session.requestHeader()?.config ?? agent.options);
      } else if (action === 'clear') store.clear();
      else if (action === 'run') schedule(agent.session.requestHeader()?.config ?? agent.options);
      else if (action !== 'status') return { kind: 'error', text: 'Usage: /memories [status|on|off|global-on|global-off|run|note <text>|clear]' };
      return { kind: 'success', text: `Memory: ${root}\nRead: ${reading(agent.session)}; background generation: ${writing()}; this session contributes: ${store.enabled(agent.session.id)}\nWorker: ${running ? 'running' : 'idle'}; entries: ${store.get('snapshot')?.entries.length ?? 0}\nBackground model usage: ${JSON.stringify(store.get('usage', { calls: 0 }))}\n${lastResult ? JSON.stringify(lastResult) : ''}\n/clear is conversation clearing; /memories clear removes global memories and excludes pre-clear sessions from regeneration.` };
    },
  });
}
