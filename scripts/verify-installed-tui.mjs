// Run against an installed profile outside the checkout: syntax checks and
// --dump-config do not resolve the terminal's transitive runtime imports.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [profile, bundle] = process.argv.slice(2);
assert(profile && bundle, 'Usage: node scripts/verify-installed-tui.mjs <profile directory> <bundle name>');
const require = createRequire(resolve(profile, 'package.json'));
for (const entry of ['startup', 'tui', 'browser']) {
  const specifier = `${bundle}/${entry}`;
  const loaded = await import(pathToFileURL(require.resolve(specifier)).href);
  assert.equal(typeof loaded.apply, 'function', `${specifier} must export a plugin entry point`);
}
console.log('INSTALLED_TUI_IMPORTS_PASSED');
