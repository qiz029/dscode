// Process-owned adapter for the CLI. Desktop can use startTriggerSession without
// exiting its shared Host when a task completes or reaches its deadline.
import { startTriggerSession } from './session-run.mjs';
import { readRunSpec, writeRunResult } from './options.mjs';
import { sessionSpend } from '../session-metrics/view.mjs';
export { triggerOverlay } from './overlay.mjs';

export const name = 'dscode-trigger-host';
export const inject = ['agents', 'sessions', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'llm', 'goals', 'appExit'];
export function apply(ctx) {
  void runTriggerHost(ctx).catch(error => { process.stderr.write(`dscode trigger run: ${error.message}\n`); ctx.get('appExit')(1); });
}
export async function runTriggerHost(ctx, { optionsPath = process.env.DSCODE_TRIGGER_OPTIONS, home = process.env.DSH_HOME, spend = sessionSpend } = {}) {
  await ctx.get('loader').await();
  if (!optionsPath) throw Error('DSCODE_TRIGGER_OPTIONS is missing');
  const run = await startTriggerSession(ctx, { spec: readRunSpec(optionsPath), home, spend });
  void run.done.then(result => {
    writeRunResult(`${optionsPath}.result.json`, result);
    ctx.get('appExit')(result.exitCode);
  }).catch(error => {
    process.stderr.write(`dscode trigger run: ${error.message}\n`);
    ctx.get('appExit')(1);
  });
}
