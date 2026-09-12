import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';
import { composePlugins } from '../scripts/composition.mjs';

const decode = text => parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
test('source and package compositions share plugins and settings after path resolution', () => {
  const source = decode(composePlugins({ root: '/source', hooks: '/state/hooks', presets: '/state/presets' }));
  const bundled = decode(composePlugins({ bundle: '@test/bundle' }));
  const normalize = value => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'inject').map(([key, v]) => [key, normalize(v)]));
    if (typeof value !== 'string') return value;
    return value.replace(/^\/source\/plugins\/(.+)\/index.mjs$/, '$1').replace(/^@test\/bundle\//, '')
      .replace('ctx.dscodePaths.hooks', '/state/hooks').replace('ctx.dscodePaths.presets', '/state/presets');
  };
  assert.deepEqual(normalize(bundled), normalize(source));
  const entries = source.flatMap(e => e.insert ?? [e]);
  assert.equal(new Set(entries.map(e => e.id)).size, entries.length);
  assert(entries.some(e => e.id === 'credentials'));
  assert.deepEqual(entries.find(e => e.id === 'dscode-auto-review').config, { timeoutMs: 30000, maxOutputTokens: 768, maxReviewsPerTurn: 20 });
});
