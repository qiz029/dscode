// Read-only proof for the release pipeline: both publishing credentials work, and the
// version they would publish is still free. Publishing itself is never attempted here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePublishToken, npmWithToken, NPM_USER } from './npm-token.mjs';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const token = resolvePublishToken();
if (!token) throw new Error('No npm token: set NPM_PUBLISH_TOKEN (the granular publish token) before running this check.');
const identity = npmWithToken(token, ['whoami'], { stdio: ['ignore', 'pipe', 'pipe'] });
if (identity.status !== 0 || (identity.stdout ?? '').trim() !== NPM_USER) {
  const reason = ((identity.stderr ?? '') + (identity.stdout ?? '')).trim() || `whoami exited ${identity.status}`;
  throw new Error(`The npm token does not authenticate as ${NPM_USER}: ${reason}`);
}
console.log(`npm credential OK: ${NPM_USER}`);
if (!process.env.DSH_HUB_TOKEN) throw new Error('No Hub token: set DSH_HUB_TOKEN (the Hub CI credential) before running this check.');
const { getAccessToken } = await import('../node_modules/@dsh-plugin-hub/cli/dist/auth.js');
const { HubApiClient } = await import('../node_modules/@dsh-plugin-hub/cli/dist/api-client.js');
const profile = await new HubApiClient(undefined, () => getAccessToken()).profile('dscode');
console.log(`Hub credential OK: the dscode profile is ${profile.visibility}, latest ${profile.latestVersion ?? 'unknown'}`);
const free = [];
for (const name of ['@toddzheng024/dscode-bundle', '@toddzheng024/dscode']) {
  const published = npmWithToken(token, ['view', `${name}@${manifest.version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const taken = published.status === 0 && (published.stdout ?? '').trim() !== '';
  console.log(`${name}@${manifest.version}: ${taken ? 'already on npm — bump the version before releasing' : 'free to publish'}`);
  if (!taken) free.push(name);
}
if (free.length === 0) throw new Error(`Every package already carries ${manifest.version}; bump the version before pushing a release tag.`);
