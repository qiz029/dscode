import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { composePlugins } from '../scripts/composition.mjs';

const decode = text => parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
test('source and package compositions share plugins and settings after path resolution', () => {
  const source = decode(composePlugins({ root: '/source', hooks: '/state/hooks' }));
  const bundled = decode(composePlugins({ bundle: '@test/bundle' }));
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'inject').map(([key, v]) => [key, normalize(v)]));
    if (typeof value !== 'string') return value;
    return value.replace(/^\/source\/plugins\/(.+)\/index.mjs$/, '$1').replace(/^@test\/bundle\//, '')
      .replace('ctx.dscodePaths.hooks', '/state/hooks');
  };
  assert.deepEqual(normalize(bundled), normalize(source));
  const entries = source.flatMap(e => e.insert ?? [e]);
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
  // The upstream credentials row is disabled and DSCODE's own provider inserted: a patch
  // cannot swap a row module, so targeting it by name silently mounted nothing.
  assert.equal(entries.find(e => e.id === 'credentials').disabled, true);
  assert(entries.some(e => e.id === 'dscode-credentials'));
  assert.deepEqual(entries.find(e => e.id === 'dscode-auto-review').config, { timeoutMs: 30000, maxOutputTokens: 4096, maxReviewsPerTurn: 20 });
  // DSH 0.1.7's registry reads declaration rows, so the composition names only the default.
  assert.deepEqual(source.find(e => e.id === 'agent-preset-registry').config, { default: 'dscode' });
});

test('no MCP server mounts by default, on the host plane or in the preset', () => {
  const host = decode(readFileSync(new URL('../config/cordis.patch.yml', import.meta.url), 'utf8'));
  const preset = decode(readFileSync(new URL('../presets/dscode/agent.cordis.yml', import.meta.url), 'utf8'));
  const mounted = [...host, ...preset].flatMap(row => row.insert ?? [row]).filter(row => row.name === '@deepseek-ai/dsh-mcp-client');
  assert.deepEqual(mounted, []);
});
