import { join } from 'node:path';
import { Scalar, stringify } from 'yaml';

export const customPlugins = Object.freeze([
  'openrouter', 'grok', 'jev', 'auto-review', 'session-metrics', 'session-cards', 'session-bridge', 'memory', 'time-marks', 'tui-tools', 'email-tools', 'triggers',
]);

const expression = value => {
  const scalar = new Scalar(value);
  scalar.tag = 'tag:yaml.org,2002:js';
  return scalar;
};

// Both install surfaces share entry IDs, policy defaults and ordering. Only
// module/path resolution differs between a source checkout and an npm bundle.
export function composePlugins({ root, bundle, hooks, presets }) {
  if (!!root === !!bundle) throw Error('Choose one composition surface: root or bundle');
  const plugin = name => bundle ? `${bundle}/${name}` : join(root, 'plugins', name, 'index.mjs');
  const inject = bundle ? { inject: ['dscodePaths'] } : {};
  const entries = customPlugins.map(name => ({
    id: `dscode-${name}`, name: plugin(name),
    ...(name === 'auto-review' ? { config: { timeoutMs: 30000, maxOutputTokens: 4096, maxReviewsPerTurn: 20 } } : {}),
  }));
  entries.push({
    id: 'dscode-hooks', name: '@deepseek-ai/dsh-hooks-codex', ...inject,
    config: { configPath: bundle ? expression('ctx.dscodePaths.hooks') : hooks, defaultTimeoutMs: 10000, stderrSummaryMaxChars: 500 },
  });
  // The credentials provider cannot be swapped by a patch: `applyEntryPatches` only
  // overrides config keys and skips a row whose `name` differs, so the upstream
  // `@deepseek-ai/dsh-credentials-local` row stayed mounted and DSCODE's own provider
  // never loaded outside the npm bundle (which rewrites that name at build time).
  // Disable the upstream row and mount ours instead; both surfaces now agree, and the
  // plugin still registers the same `credentials` service.
  const credentials = { id: 'dscode-credentials', name: plugin('credentials') };
  return stringify([
    { id: 'credentials', disabled: true },
    { insert: [credentials, ...entries] },
    { id: 'agent-presets', ...inject, config: {
      default: 'dscode', roots: [{ path: bundle ? expression('ctx.dscodePaths.presets') : presets, trust: 'system' }],
    } },
  ]);
}
