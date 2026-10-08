// Explicit, idempotent publication of the exact Desktop tarball qualified above.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { HubApiClient } from '../node_modules/@dsh-plugin-hub/cli/dist/api-client.js';
import { getAccessToken } from '../node_modules/@dsh-plugin-hub/cli/dist/auth.js';
import { resolvePublishToken, npmWithToken, NPM_USER } from './npm-token.mjs';
import { withHubRetry } from './hub-retry.mjs';
import { readDesktopRelease } from './desktop-release-artifact.mjs';
import { waitForDesktopHub } from './desktop-hub-sync.mjs';

const root = resolve(import.meta.dirname, '..'), phase = process.argv[2];
if (!['npm', 'hub', 'verify', 'credentials'].includes(phase)) throw Error('Usage: npm run publish:desktop -- npm|hub|verify|credentials');
const candidate = readDesktopRelease(root);
const client = new HubApiClient(undefined, () => getAccessToken());
async function npmVersion() {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(candidate.name)}/${candidate.version}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (response.status === 404) return null;
  if (!response.ok) throw Error(`npm metadata returned HTTP ${response.status}`);
  const value = await response.json();
  assert.equal(value.name, candidate.name); assert.equal(value.version, candidate.version);
  assert.equal(value.dist?.integrity, candidate.integrity, 'This npm version already belongs to different bytes; bump the version');
  return value;
}
async function waitForNpm() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const value = await npmVersion(); if (value) return value;
    console.log(`Waiting for ${candidate.name}@${candidate.version} on npm (${attempt + 1}/40)`);
    await delay(15000);
  }
  throw Error('The Desktop package is not visible on npm yet. Rerun this phase after it propagates.');
}
function publisher() {
  const token = resolvePublishToken();
  if (!token) throw Error('Set NPM_PUBLISH_TOKEN or store the Desktop publisher token with npm run publish:token store.');
  const identity = npmWithToken(token, ['whoami'], { stdio: ['ignore', 'pipe', 'inherit'] });
  assert.equal(identity.status, 0, 'npm publisher authentication failed');
  assert.equal(identity.stdout.trim(), NPM_USER, 'Unexpected npm publisher');
  return token;
}
async function checkHub(record) {
  record ??= await withHubRetry(() => client.package(candidate.name), { label: 'Desktop Hub lookup' });
  const release = record.versions.find(item => item.version === candidate.version);
  assert(release && !release.yanked, 'The exact Desktop version is not available in the Hub');
  assert.equal(release.source.kind, 'npm'); assert.equal(release.source.packageName, candidate.name);
  assert.equal(release.source.version, candidate.version); assert.equal(release.source.integrity, candidate.integrity);
  assert.equal(release.compatibility.dsh, candidate.runtime);
  assert.deepEqual(release.compatibility.surfaces, ['desktop']);
  return record;
}

if (phase === 'credentials') {
  publisher(); const existing = await npmVersion();
  console.log(`Desktop publisher authenticated; ${existing ? 'this version already has the verified bytes' : 'this version is available'}.`);
  console.log(`The npm token must also grant write access to ${candidate.name}; authentication alone cannot prove that package permission.`);
} else if (phase === 'npm') {
  if (await npmVersion()) console.log('Desktop version already published with the verified integrity; skipping.');
  else {
    const result = npmWithToken(publisher(), ['publish', candidate.path, '--access', 'public', '--tag', 'preview', '--ignore-scripts']);
    assert.equal(result.status, 0, `Desktop publication failed. The token needs write permission for ${candidate.name}.`);
  }
} else if (phase === 'hub') {
  await waitForNpm();
  const record = await waitForDesktopHub({ packageName: candidate.name, version: candidate.version,
    sync: () => withHubRetry(() => client.syncPackage(candidate.name), { label: 'Desktop Hub sync' }),
    lookup: () => withHubRetry(() => client.package(candidate.name), { label: 'Desktop Hub lookup' }),
  });
  await checkHub(record); console.log(`Hub lists ${candidate.name}@${candidate.version}.`);
} else {
  const metadata = await waitForNpm();
  const url = new URL(metadata.dist.tarball);
  assert.equal(url.origin, 'https://registry.npmjs.org', 'Unexpected public tarball origin');
  const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  assert(response.ok, `Public Desktop download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.sha256, 'Public download differs from the qualified Desktop candidate');
  const record = await checkHub();
  execFileSync(process.execPath, [resolve(root, 'scripts/prepare-desktop-runtime.mjs')], { cwd: root, stdio: 'inherit', timeout: 360000 });
  execFileSync(process.execPath, [resolve(root, 'scripts/verify-desktop-registry.mjs')], { cwd: root, stdio: 'inherit', timeout: 360000 });
  console.log(`Public Desktop download verified: ${candidate.name}@${candidate.version}, SHA-256 ${candidate.sha256}`);
  console.log(`Hub listing: https://dshpluginhub.ai/plugins/${record.slug}`);
}
