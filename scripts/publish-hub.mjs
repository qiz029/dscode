// Explicit release phases: never publish the launcher before its Hub release exists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePackageDirectory } from '../node_modules/@dsh-plugin-hub/cli/dist/package-validation.js';
import { HubApiClient } from '../node_modules/@dsh-plugin-hub/cli/dist/api-client.js';
import { getAccessToken } from '../node_modules/@dsh-plugin-hub/cli/dist/auth.js';
import { resolvePublishToken, npmWithToken, NPM_USER } from './npm-token.mjs';
import { withHubRetry } from './hub-retry.mjs';
const root = join(import.meta.dirname,'..');
const out = join(root,'artifacts/npm');
const read = path => JSON.parse(readFileSync(path,'utf8'));
const phase = process.argv[2];
if (!['bundle','profile','launcher'].includes(phase)) throw Error('Usage: npm run publish:hub -- bundle|profile|launcher');
const pack = read(join(out,'bundle-pack.json'))[0];
const launcher = read(join(out,'launcher-pack.json'))[0];
const verified = read(join(root,'artifacts/local/hub-verification.json'));
if (!verified.install || !verified.rollback || verified.integrity !== pack.integrity || verified.launcherIntegrity !== launcher.integrity) throw Error('Run npm run verify:hub against these exact packages before publishing.');
await validatePackageDirectory(join(out,'bundle'));
const client = new HubApiClient(undefined, () => getAccessToken());
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WAIT_ATTEMPTS = Number(process.env.DSCODE_PUBLISH_WAIT_ATTEMPTS ?? 40), WAIT_MS = Number(process.env.DSCODE_PUBLISH_WAIT_MS ?? 15000);
/** The published version's metadata, `null` when npm has not got it; a different tarball under the same version is an error. */
async function npmVersion(artifact) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(artifact.name)}/${artifact.version}`);
  if (response.status === 404) return null;
  if (!response.ok) throw Error(`npm answered ${response.status} for ${artifact.name}@${artifact.version}.`);
  const metadata = await response.json();
  if (metadata.dist?.integrity !== artifact.integrity) throw Error(`Published npm integrity of ${artifact.name}@${artifact.version} differs from the tested package.`);
  return metadata;
}
// npm accepts a publish before it serves the version ("may take a few minutes to become
// available"), so the next phase polls instead of failing on the first 404.
async function npmMetadata() {
  for (let attempt = 1; ; attempt++) {
    if (await npmVersion(pack)) return;
    if (attempt >= WAIT_ATTEMPTS) throw Error(`npm still does not serve ${pack.name}@${pack.version}; publish the bundle to npm first.`);
    console.log(`Waiting for npm to serve ${pack.name}@${pack.version} (${attempt}/${WAIT_ATTEMPTS})…`);
    await sleep(WAIT_MS);
  }
}
async function publish(artifact) {
  // A re-run after a later phase failed must not trip over the version it already published.
  if (await npmVersion(artifact)) { console.log(`${artifact.name}@${artifact.version} is already on npm with the tested integrity; skipping.`); return; }
  const args=['publish',join(out,artifact.filename),'--access','public','--ignore-scripts'];
  // Preferred: the granular token from the Keychain (or NPM_PUBLISH_TOKEN), so no login or one-time code is needed.
  const token=resolvePublishToken();
  if(token) {
    const identity=npmWithToken(token,['whoami'],{stdio:['ignore','pipe','inherit']});
    if(identity.status !== 0 || (identity.stdout ?? '').trim() !== NPM_USER) throw Error(`The stored npm token does not authenticate as ${NPM_USER}; refresh it with "node scripts/npm-token.mjs store".`);
    const result=npmWithToken(token,args);
    if(result.status !== 0) throw Error('npm publication did not complete.');
    return;
  }
  // Fallback: the interactive session in ~/.npmrc (asks for a one-time code under auth-and-writes 2FA).
  const identity=spawnSync('npm',['whoami'],{encoding:'utf8'});
  if(identity.status !== 0 || identity.stdout.trim() !== NPM_USER) throw Error(`Run npm login as ${NPM_USER} before publishing, or store a token with "node scripts/npm-token.mjs store".`);
  const result=spawnSync('npm',args,{stdio:'inherit'});
  if(result.status !== 0) throw Error('npm publication did not complete.');
}
if(phase==='bundle') await publish(pack);
else if(phase==='profile') {
  await npmMetadata();
  // Ask the Hub to pull the package from npm now instead of waiting for its hourly sync.
  // Require Hub discovery of this exact version before saving a release; the sync can trail npm too.
  for (let attempt = 1; ; attempt++) {
    const synced=await withHubRetry(()=>client.syncPackage(pack.name),{label:'Hub package sync'});
    if(synced.status!=='accepted') throw Error(`Hub did not sync ${pack.name}: ${synced.reason ?? synced.status}`);
    console.log(`Hub synced ${synced.slug ?? pack.name}@${synced.latestVersion ?? '?'} (${synced.versionsAdded ?? 0} new versions)`);
    const known=await withHubRetry(()=>client.package(pack.name),{label:'Hub package lookup'});
    if((known.versions ?? []).some(v=>(v.version ?? v)===pack.version)) break;
    if(attempt >= WAIT_ATTEMPTS) throw Error(`Hub still lists ${pack.name} up to ${known.latestVersion}; ${pack.version} is not visible yet.`);
    await sleep(WAIT_MS);
  }
  await withHubRetry(()=>client.saveProfileDraft({...read(join(out,'profile-draft.json')),visibility:'public'}),{label:'Hub profile draft'});
  try {
    console.log(JSON.stringify(await withHubRetry(()=>client.publishProfile('dscode',pack.version,true),{label:'Hub profile release'}),null,2));
  } catch (error) {
    // Hub versions are immutable. A re-run after a later phase failed must be able to skip the
    // profile it already published instead of dying on the 409 and dragging the remaining
    // phases (launcher, release asset) down with it.
    const message = error instanceof Error ? error.message : String(error);
    const published = message.includes('version_is_immutable') ? await withHubRetry(()=>client.profile('dscode'),{label:'Hub profile lookup'}) : undefined;
    if (!published?.versions?.some(entry => (entry.version ?? entry) === pack.version)) throw error;
    console.log(`Hub already holds dscode@${pack.version}; skipping the immutable re-publish.`);
  }
} else {
  await npmMetadata();
  const profile=await withHubRetry(()=>client.profile('dscode'),{label:'Hub profile lookup'});
  // Accept only an exact release returned by the public Hub resolver.
  const selected=profile.versions.find(v=>v.version===pack.version);
  if(profile.visibility !== 'public' || !selected?.bundles.some(b=>b.packageName===pack.name && b.version===pack.version && b.integrity===pack.integrity)) throw Error('The matching public Hub release is not available.');
  await publish(launcher);
}
