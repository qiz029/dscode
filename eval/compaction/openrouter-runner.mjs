import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { runEvaluation } from './runner.mjs';
import { OpenRouterAdapter } from '../../plugins/openrouter/adapter.mjs';
import { ensureOpenRouterModels } from '../../plugins/openrouter/models.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf('--' + name);
  return index < 0 ? fallback : args[index + 1];
};

// The account key stays inside this process: never printed, never an argument.
const credentials = parse(readFileSync(flag('credentials', '.runtime/.credentials.yaml'), 'utf8'));
const apiKey = credentials.refs?.OPENROUTER_API_KEY;
if (typeof apiKey !== 'string' || apiKey.length === 0) throw Error('OPENROUTER_API_KEY is not configured');

const model = flag('model', 'deepseek/deepseek-v4-flash');
const judgeModel = flag('judge-model', 'deepseek/deepseek-v4-pro');
const contextWindow = Number(flag('window', 131072));
const stride = Number(flag('stride', 10));
const maxCalls = Number(flag('max-calls', 200));

const source = JSON.parse(readFileSync(flag('dataset', 'eval/private/longmemeval/tier1.json'), 'utf8'));
const cases = stride > 1 ? source.cases.filter((_, index) => index % stride === 0) : source.cases;
const dataset = { ...source, id: `${source.id}${stride > 1 ? `-stride${stride}` : ''}`, cases };
const policies = JSON.parse(readFileSync(flag('policies', 'eval/private/longmemeval/policies-tier1.json'), 'utf8'));

const options = () => ({
  apiKeyEnv: credentialRef('OPENROUTER_API_KEY'),
  baseURL: 'https://openrouter.ai/api/v1',
  streamIdleTimeoutMs: 300000,
  maxRequestImageBytes: 20 * 1024 * 1024,
  searchModel: model,
  retryPolicy: resolveRetryPolicy(undefined, 'eval-openrouter'),
});
// The route's live listing reports a 1M window and an output cap, which would price the
// threshold far above every replayed history and never compact. The evaluation owns the
// window, so the adapter reports exactly the context the harness also enforces.
class WindowedAdapter extends OpenRouterAdapter {
  constructor(config, contextWindow) {
    super(config);
    this.contextWindow = contextWindow;
  }
  async resolveModel(provider, model) {
    const info = await super.resolveModel(provider, model);
    delete info.defaultMaxTokens;
    return { ...info, context: { contextWindow: this.contextWindow } };
  }
}

const adapterFactory = () => new WindowedAdapter({
  options,
  ensureModels: () => ensureOpenRouterModels({ home: process.env.DSH_HOME }),
  resolveApiKey: async () => apiKey,
  resolveAttachments: () => undefined,
  resolveImageAccess: () => undefined,
}, contextWindow);

console.log(`cases ${cases.length}; policies ${policies.map(policy => policy.id).join(',')}; window ${contextWindow}; model ${model}; judge ${judgeModel}`);
const result = await runEvaluation({
  dataset, policies, backend: 'deepseek', provider: 'openrouter', model, judgeModel, contextWindow,
  repeats: 1, maxCalls, timeoutMs: 300000, thinking: 'disabled', adapterFactory,
  onProgress: row => console.log(`${row.case} ${row.policy}: ${row.grade.passed}/${row.grade.total} summaries=${row.compactions} prunes=${row.prunes}${row.error ? ' ERR=' + row.error : ''}`),
});
console.log('report', `${result.output}/report.md`);
console.log('status', result.manifest.status, 'calls', result.manifest.callsUsed);
