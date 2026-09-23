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

test('every row DSCODE patches by id exists in the bundles it composes', () => {
  // A Loader patch addresses a row by id, and an id that no longer exists patches nothing
  // at all — silently. That is how an upstream rename (`workflow-worker-thread` became
  // `workflow-ptc` in DSH 0.1.7) can put a row DSCODE deliberately disables back in
  // service. Every target is checked against the compositions this profile actually
  // carries, so the next rename fails here instead of in a running session.
  const declared = (rows, out = new Set()) => {
    for (const row of rows ?? []) {
      if (row === null || typeof row !== 'object') continue;
      if (row.insert) declared(row.insert, out);
      if (Array.isArray(row.config)) declared(row.config, out);
      if (Array.isArray(row.config?.plugins)) declared(row.config.plugins, out);
      if (row.id !== undefined && row.name !== undefined) out.add(row.id);
    }
    return out;
  };
  const bundle = name => decode(readFileSync(new URL(`../node_modules/${name}/cordis.patch.yml`, import.meta.url), 'utf8'));
  const upstream = declared([...bundle('@deepseek-ai/dsh-base'), ...bundle('@anionex/dsh-computer-use')]);
  const own = declared(decode(readFileSync(new URL('../packages/tui/cordis.patch.yml', import.meta.url), 'utf8')));
  for (const file of ['../packages/tui/cordis.patch.yml', '../config/cordis.patch.yml', '../config/auto-review.patch.yml']) {
    const rows = decode(readFileSync(new URL(file, import.meta.url), 'utf8'));
    const targets = rows.filter(row => row !== null && typeof row === 'object' && !row.insert && row.id !== undefined).map(row => row.id);
    for (const id of targets) {
      assert(upstream.has(id) || own.has(id), `${file} patches "${id}", which no bundle this profile composes declares`);
    }
  }
});

test('no MCP server mounts by default, on the host plane or in the preset', () => {
  const host = decode(readFileSync(new URL('../config/cordis.patch.yml', import.meta.url), 'utf8'));
  const preset = decode(readFileSync(new URL('../presets/dscode/agent.cordis.yml', import.meta.url), 'utf8'));
  const mounted = [...host, ...preset].flatMap(row => row.insert ?? [row]).filter(row => row.name === '@deepseek-ai/dsh-mcp-client');
  assert.deepEqual(mounted, []);
});
