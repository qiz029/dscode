import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { BudgetAdapter, deepseekAdapter } from '../compaction/adapters.mjs';
import { createRuntime } from '../compaction/runtime.mjs';

const tools = [{
  name: 'run_shell',
  description: 'Run one shell command in the isolated DeepSWE task checkout at /app. Use it to inspect files, edit code, run visible project tests, create a branch and commit the finished patch. The hidden verifier is not available here.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
}];

const shippedPolicy = JSON.parse(readFileSync(new URL('../compaction/policies.json', import.meta.url), 'utf8')).find(value => value.id === 'shipped-80');
if (!shippedPolicy || shippedPolicy.thresholdRatio !== .8 || shippedPolicy.retainRatio !== .16) throw Error('Expected shipped 80%/16% policy');

export function selectPolicy(thresholdRatio) {
  if (thresholdRatio === .8) return shippedPolicy;
  if (thresholdRatio === .4) return { ...shippedPolicy, id: 'threshold-40-retain-16', thresholdRatio };
  throw Error('DeepSWE threshold ratio must be 0.8 or 0.4');
}

export async function runAgent({ instruction, out, model = 'deepseek-flash', contextWindow = 1000000, thresholdRatio = .8, maxSteps = 200, maxCalls = 250, timeoutMs = 300000, thinking = 'disabled', apiKey = process.env.DEEPSEEK_API_KEY, executeTool, onFinal = () => {} }) {
  if (!instruction?.trim() || !out || !executeTool) throw Error('Instruction, output directory and tool executor are required');
  const policy = selectPolicy(thresholdRatio);
  const budget = { used: 0, limit: maxCalls };
  const calls = [];
  const runtime = createRuntime({ policy, adapter: new BudgetAdapter(deepseekAdapter({ model, contextWindow, apiKey, thinking }), budget, timeoutMs), provider: 'deepseek-official', model, contextWindow, tools,
    onCall: call => { calls.push(call); appendFileSync(join(out, 'calls.jsonl'), JSON.stringify(call) + '\n'); } });
  let done = false, steps = 0, failure = null, finalText = '';
  const start = Date.now();
  try {
    runtime.initialize('You are a coding agent working on an original DeepSWE task. Work only in /app through run_shell. Inspect the repository, implement the requested behavior, run relevant project tests, and commit your final changes on a new branch. Never inspect /logs, hidden verifier files, or reference solutions. You may use the shell tool repeatedly. Finish with a concise account of what you changed and tested.');
    await runtime.append({ role: 'user', text: instruction }, new AbortController().signal);
    while (!done && steps < maxSteps) {
      steps++;
      const step = await runtime.agentStep(executeTool, new AbortController().signal, 8192);
      appendFileSync(join(out, 'steps.jsonl'), JSON.stringify({ step: steps, ...step }) + '\n');
      done = step.done; finalText = step.text;
    }
    if (!done) failure = 'step-limit';
  } catch (error) {
    failure = error?.code ?? error?.message ?? 'agent-error';
    throw error;
  } finally {
    const events = runtime.session.snapshotEvents();
    const usage = calls.map(call => call.usage).filter(Boolean);
    const report = {
      model, contextWindow, policy, thinking, maxSteps, maxCalls, steps, done, failure, finalText,
      calls: budget.used, compactions: events.filter(event => event.type === 'compaction/summary').length,
      prunes: events.filter(event => event.type === 'compaction/prune').length,
      afterTokens: runtime.measure().totalTokens,
      // DeepSeek reports cache reads separately from uncached input. Pier's
      // n_input_tokens and peak_context_tokens include both portions.
      inputTokens: usage.reduce((sum, item) => sum + (item.inputTokens ?? 0) + (item.cacheReadTokens ?? 0), 0),
      outputTokens: usage.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
      cacheReadTokens: usage.reduce((sum, item) => sum + (item.cacheReadTokens ?? 0), 0),
      peakInputTokens: Math.max(0, ...usage.map(item => (item.inputTokens ?? 0) + (item.cacheReadTokens ?? 0))),
      elapsedMs: Date.now() - start,
    };
    writeFileSync(join(out, 'agent-report.json'), JSON.stringify(report, null, 2) + '\n');
    onFinal(report);
    await runtime.close();
  }
}

async function main() {
  const { values } = parseArgs({ options: { instruction: { type: 'string' }, out: { type: 'string' }, model: { type: 'string', default: 'deepseek-flash' }, 'context-window': { type: 'string', default: '1000000' }, 'threshold-ratio': { type: 'string', default: '0.8' }, 'max-steps': { type: 'string', default: '200' }, 'max-calls': { type: 'string', default: '250' }, 'timeout-ms': { type: 'string', default: '300000' }, thinking: { type: 'string', default: 'disabled' } } });
  const output = resolve(values.out);
  const instruction = JSON.parse(readFileSync(values.instruction, 'utf8')).instruction;
  const pending = new Map();
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    try {
      const message = JSON.parse(line), task = pending.get(message.id);
      if (!task) throw Error('Unexpected tool response');
      pending.delete(message.id); task.resolve(message.result);
    } catch (error) { for (const task of pending.values()) task.reject(error); pending.clear(); }
  });
  const executeTool = (name, argumentsText) => {
    if (name !== 'run_shell') return Promise.resolve({ ok: false, error: 'unknown-tool' });
    let argumentsObject;
    try { argumentsObject = JSON.parse(argumentsText); }
    catch { return Promise.resolve({ ok: false, error: 'invalid-tool-arguments' }); }
    if (typeof argumentsObject?.command !== 'string') return Promise.resolve({ ok: false, error: 'invalid-command' });
    const id = randomUUID();
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); process.stdout.write(JSON.stringify({ type: 'tool', id, name, arguments: argumentsObject }) + '\n'); });
  };
  await runAgent({ instruction, out: output, model: values.model, contextWindow: Number(values['context-window']), thresholdRatio: Number(values['threshold-ratio']), maxSteps: Number(values['max-steps']), maxCalls: Number(values['max-calls']), timeoutMs: Number(values['timeout-ms']), thinking: values.thinking, executeTool,
    onFinal: report => process.stdout.write(JSON.stringify({ type: 'final', report }) + '\n') });
  input.close();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
