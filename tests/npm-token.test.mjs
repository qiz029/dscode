import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolvePublishToken, tokenUserConfig, npmWithToken, keychainReadArgs, storePublishToken, KEYCHAIN_SERVICE, NPM_USER } from '../scripts/npm-token.mjs';

test('publish token: environment wins, then the Keychain, else empty', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: ' npm_fromkeychain \n' }; };
  assert.equal(resolvePublishToken({ env: { NPM_PUBLISH_TOKEN: ' npm_env ' }, run }), 'npm_env');
  assert.equal(calls.length, 0, 'no keychain call when the environment supplies the token');
  assert.equal(resolvePublishToken({ env: {}, run }), 'npm_fromkeychain');
  assert.deepEqual(calls[0], ['security', keychainReadArgs()]);
  assert.deepEqual(keychainReadArgs(), ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', NPM_USER, '-w']);
  assert.equal(resolvePublishToken({ env: {}, run: () => ({ status: 44, stdout: '' }) }), '');
});

test('token user config is private, holds only the registry token, and is removed after use', () => {
  const config = tokenUserConfig('npm_secret');
  assert.equal(readFileSync(config.path, 'utf8'), '//registry.npmjs.org/:_authToken=npm_secret\n');
  assert.equal(statSync(config.path).mode & 0o777, 0o600);
  config.cleanup();
  assert(!existsSync(config.path));
  assert.throws(() => tokenUserConfig(''), /required/);
  let seen;
  const result = npmWithToken('npm_secret', ['publish', 'x.tgz', '--access', 'public'], { run: (cmd, args) => { seen = { cmd, args, content: readFileSync(args.at(-1), 'utf8') }; return { status: 0 }; } });
  assert.equal(result.status, 0);
  assert.equal(seen.cmd, 'npm');
  assert.deepEqual(seen.args.slice(0, -2), ['publish', 'x.tgz', '--access', 'public']);
  assert.equal(seen.args.at(-2), '--userconfig');
  assert.match(seen.content, /_authToken=npm_secret/);
  assert(!existsSync(seen.args.at(-1)), 'temporary npmrc is deleted even though npm already ran');
});

test('storing a token never puts the secret on the command line', () => {
  let seen;
  storePublishToken({ run: (cmd, args) => { seen = [cmd, args]; return { status: 0 }; } });
  assert.equal(seen[0], 'security');
  assert(seen[1].includes('add-generic-password') && seen[1].includes('-U'));
  assert(!seen[1].includes('-w'), 'security prompts for the secret instead of receiving it as an argument');
});
