import { join } from 'node:path';
import { Scalar, stringify } from 'yaml';

export const customPlugins = Object.freeze([
  'openrouter', 'grok', 'jev', 'auto-review', 'session-metrics', 'session-cards', 'session-bridge', 'memory', 'time-marks', 'tui-tools', 'email-tools', 'triggers', 'computer-use',
]);

/**
 * Computer Use configuration. It lives here rather than in the host overlay because the
 * upstream row is disabled and DSCODE mounts the bundle through its own wrapper, which
 * restores the settings API the pinned 0.3.2 package still calls.
 */
const COMPUTER_USE_CONFIG = Object.freeze({
  observationTtlMs: 30000,
  allowAllApps: false,
  interaction: {
    focusPolicy: 'preserve',
    keyboardPolicy: 'activate',
    pointerInputPolicy: 'targeted',
    cursorVisualization: 'visible',
  },
});

const expression = value => {
  const scalar = new Scalar(value);
  scalar.tag = 'tag:yaml.org,2002:js';
  return scalar;
};

// Both install surfaces share entry IDs, policy defaults and ordering. Only
// module/path resolution differs between a source checkout and an npm bundle.
export function composePlugins({ root, bundle, hooks }) {
  if (!!root === !!bundle) throw Error('Choose one composition surface: root or bundle');
  const plugin = name => bundle ? `${bundle}/${name}` : join(root, 'plugins', name, 'index.mjs');
  const inject = bundle ? { inject: ['dscodePaths'] } : {};
  const entries = customPlugins.map(name => ({
    id: `dscode-${name}`, name: plugin(name),
    ...(name === 'auto-review' ? { config: { timeoutMs: 30000, maxOutputTokens: 4096, maxReviewsPerTurn: 20 } } : {}),
    ...(name === 'computer-use' ? { config: COMPUTER_USE_CONFIG } : {}),
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
  // DSH 0.1.7's registry declares presets as rows and no longer scans a preset root:
  // the DSCODE declaration is appended to this patch by its own renderer, and only the
  // deployment default belongs to the registry row.
  return stringify([
    { id: 'credentials', disabled: true },
    { id: 'computer-use', disabled: true },
    { insert: [credentials, ...entries] },
    { id: 'agent-preset-registry', config: { default: 'dscode' } },
  ]);
}
