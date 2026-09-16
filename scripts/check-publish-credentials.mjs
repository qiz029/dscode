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
// The publish phases are idempotent: an identical version already on npm is a re-run, not a
// conflict. Only a different build under the same version has to stop the release.
const verified = JSON.parse(readFileSync(join(root, 'artifacts/local/hub-verification.json'), 'utf8'));
const expected = new Map([
  ['@toddzheng024/dscode-bundle', verified.integrity],
  ['@toddzheng024/dscode', verified.launcherIntegrity],
]);
let free = 0;
for (const [name, integrity] of expected) {
  const published = npmWithToken(token, ['view', `${name}@${manifest.version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const taken = published.status === 0 && (published.stdout ?? '').trim() !== '';
  if (!taken) { console.log(`${name}@${manifest.version}: free to publish`); free += 1; continue; }
  const served = npmWithToken(token, ['view', `${name}@${manifest.version}`, 'dist.integrity'], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (served.status !== 0 || (served.stdout ?? '').trim() !== integrity) throw new Error(`${name}@${manifest.version} is already on npm with a different build; bump the version before pushing a release tag.`);
  console.log(`${name}@${manifest.version}: already on npm with the tested integrity — the publish phases will skip it`);
}
if (free === 0) console.log(`All packages already carry ${manifest.version} with the tested integrity; this release is a re-run.`);
