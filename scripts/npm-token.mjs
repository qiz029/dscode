// Non-interactive npm publishing on this machine: the granular npm token lives
// in the macOS Keychain (or NPM_PUBLISH_TOKEN for one-off runs) and reaches npm
// through a temporary user config, so ~/.npmrc and the shell history never
// hold it. `node scripts/npm-token.mjs store` saves a token; `check` verifies it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const KEYCHAIN_SERVICE = 'dscode-npm-publish';
export const NPM_USER = 'toddzheng024';
export const REGISTRY_HOST = 'registry.npmjs.org';

/** Keychain lookup arguments; `-w` prints only the secret. */
export function keychainReadArgs(service = KEYCHAIN_SERVICE, account = NPM_USER) {
  return ['find-generic-password', '-s', service, '-a', account, '-w'];
}

/** Resolve the publish token: explicit environment first, then the Keychain. Empty string when neither is set. */
export function resolvePublishToken({ env = process.env, run = spawnSync } = {}) {
  const explicit = (env.NPM_PUBLISH_TOKEN ?? '').trim();
  if (explicit) return explicit;
  if (process.platform !== 'darwin' && run === spawnSync) return '';
  const result = run('security', keychainReadArgs(), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? (result.stdout ?? '').trim() : '';
}

/** Write a private temporary npm user config carrying only the registry token; returns the path and a cleanup. */
export function tokenUserConfig(token, { directory = tmpdir() } = {}) {
  if (!token) throw new Error('A publish token is required');
  const folder = mkdtempSync(join(directory, 'dscode-npmrc-'));
  const path = join(folder, 'npmrc');
  writeFileSync(path, `//${REGISTRY_HOST}/:_authToken=${token}\n`, { mode: 0o600 });
  return { path, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

/** Run one npm command with the token config; returns spawnSync's result. */
export function npmWithToken(token, args, { run = spawnSync, stdio = 'inherit' } = {}) {
  const config = tokenUserConfig(token);
  try { return run('npm', [...args, '--userconfig', config.path], { encoding: 'utf8', stdio }); }
  finally { config.cleanup(); }
}

/** Store a token in the Keychain through `security -i`'s command stream, so the secret never appears on a command line. */
export function storePublishToken(token, { run = spawnSync } = {}) {
  if (!/^npm_[A-Za-z0-9]{16,}$/.test(token)) throw new Error('That does not look like an npm granular token (expected npm_ followed by letters and digits)');
  const command = `add-generic-password -U -s ${JSON.stringify(KEYCHAIN_SERVICE)} -a ${JSON.stringify(NPM_USER)} -l "npm publish token for dscode (granular, bypass 2FA)" -w ${JSON.stringify(token)}\n`;
  return run('security', ['-i'], { input: command, encoding: 'utf8', stdio: ['pipe', 'ignore', 'inherit'] });
}

async function readToken(stream) {
  if (stream.isTTY) throw new Error('Pipe the token in: pbpaste | npm run publish:token store   (or: printf %s "$TOKEN" | npm run publish:token store)');
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text.trim();
}

async function main(command) {
  if (command === 'store') {
    const token = await readToken(process.stdin);
    if (!token) throw new Error('No token received on stdin. Copy the granular token, then run: pbpaste | npm run publish:token store');
    const result = storePublishToken(token);
    if (result.status !== 0) throw new Error('Keychain write failed');
    const stored = resolvePublishToken({ env: {} });
    if (stored !== token) throw new Error('Keychain read-back did not return the stored token');
    process.stdout.write(`Stored in the login Keychain as service "${KEYCHAIN_SERVICE}" (${token.length} characters).\n`);
    return;
  }
  if (command === 'check') {
    const token = resolvePublishToken();
    if (!token) throw new Error(`No token: set NPM_PUBLISH_TOKEN, or copy the granular token and run "pbpaste | npm run publish:token store".`);
    const who = npmWithToken(token, ['whoami'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const user = (who.stdout ?? '').trim();
    if (who.status !== 0 || user !== NPM_USER) throw new Error(`Token does not authenticate as ${NPM_USER} (got "${user || 'nothing'}")`);
    process.stdout.write(`npm publish token OK: ${user}\n`);
    return;
  }
  if (command === 'remove') {
    const result = spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', NPM_USER], { stdio: ['ignore', 'ignore', 'inherit'] });
    process.stdout.write(result.status === 0 ? 'Removed.\n' : 'Nothing stored.\n');
    return;
  }
  throw new Error('Usage: node scripts/npm-token.mjs store|check|remove');
}

if (process.argv[1] && process.argv[1].endsWith('npm-token.mjs')) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
