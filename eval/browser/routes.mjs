import { homedir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { CustomStore, isCustomId, keyRef } from '../../plugins/custom/config.mjs';
import { CustomAdapter } from '../../plugins/custom/adapter.mjs';
import { deepseekAdapter } from '../compaction/adapters.mjs';

export const EVAL_PROVIDER = 'browser-eval';
export const EVAL_KEY_ENV = 'DSCODE_BROWSER_EVAL_KEY';

export async function readCredential(ref, env, path = join(homedir(), '.dscode', 'credentials.yaml')) {
  const ctx = new Context();
  try {
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]));
    await ctx.plugin(LocalCredentialProvider, { path, watch: false });
    return (await ctx.credentials.resolve(ref))?.value;
  } finally { await ctx.fiber.dispose(); }
}

/** Validate and snapshot the selected route before creating a report or starting Chrome. */
export async function resolveRoute(options, { env = process.env, store = new CustomStore(options.providersFile), resolveCredential = ref => readCredential(ref, env) } = {}) {
  if (options.selfTest) return { route: { backend: 'scripted', provider: EVAL_PROVIDER }, key: undefined };
  if (options.provider === 'deepseek') {
    if (!env.DEEPSEEK_API_KEY?.trim()) throw Error('DEEPSEEK_API_KEY is required for a live browser evaluation. Set it locally; --self-test only checks the scripted pipeline.');
    return { route: { backend: 'deepseek', provider: 'deepseek-official', endpoint: 'https://api.deepseek.com', contextWindow: 100000 }, key: env.DEEPSEEK_API_KEY };
  }
  if (!isCustomId(options.provider)) throw Error('Choose deepseek or a saved custom provider ID.');
  let snapshot;
  try { snapshot = await store.read(); } catch { throw Error('Could not read the custom provider configuration; repair it in /provider custom.'); }
  const profile = snapshot.providers.find(p => p.id === options.provider);
  if (!profile) throw Error('Custom provider was not found in the selected configuration.');
  const model = profile.models.find(m => m.id === options.model);
  if (!model?.contextWindow) throw Error('Choose a configured custom model with a context window.');
  let key;
  if (profile.auth !== 'none') {
    try { key = options.keyEnv ? env[options.keyEnv] : await resolveCredential(keyRef(profile.id)); }
    catch { throw Error('Could not resolve the custom provider credential.'); }
    if (!key?.trim()) throw Error('Custom provider API key is missing; configure its key or pass --key-env with the name of a populated environment variable.');
    if (/[\s\x00-\x1f]/.test(key) || key.length > 4096) throw Error('Custom provider API key is malformed.');
  }
  return { route: { backend: 'custom', provider: profile.id, endpoint: profile.baseURL, api: profile.api,
    contextWindow: model.contextWindow, profile: { ...profile, models: [model] } }, key };
}

/** Keep the benchmark route stable so native reasoning replays to the same adapter. */
export function liveAdapter(route, options, ctx, key) {
  if (route.backend === 'deepseek') return deepseekAdapter({ model: options.model, contextWindow: route.contextWindow, apiKey: key, thinking: options.thinking });
  if (route.backend !== 'custom') throw Error('Unknown live evaluation route');
  const profile = { ...route.profile, id: EVAL_PROVIDER };
  return new CustomAdapter({ profile: provider => provider === EVAL_PROVIDER ? profile : undefined,
    resolveKey: async () => key,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref),
  });
}
