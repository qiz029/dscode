// Explicit release phases: never publish the launcher before its Hub release exists.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validatePackageDirectory } from '../node_modules/@dsh-plugin-hub/cli/dist/package-validation.js';
import { HubApiClient } from '../node_modules/@dsh-plugin-hub/cli/dist/api-client.js';
import { getAccessToken } from '../node_modules/@dsh-plugin-hub/cli/dist/auth.js';
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
async function npmMetadata() {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pack.name)}/${pack.version}`);
  if(!response.ok) throw Error('Publish the bundle to npm first.');
  const metadata = await response.json();
  if(metadata.dist?.integrity !== pack.integrity) throw Error('Published npm integrity differs from the tested bundle.');
}
function publish(artifact) {
  const identity=spawnSync('npm',['whoami'],{encoding:'utf8'});
  if(identity.status !== 0 || identity.stdout.trim() !== 'toddzheng024') throw Error('Run npm login as toddzheng024 before publishing.');
  const result=spawnSync('npm',['publish',join(out,artifact.filename),'--access','public','--ignore-scripts'],{stdio:'inherit'});
  if(result.status !== 0) throw Error('npm publication did not complete.');
}
if(phase==='bundle') publish(pack);
else if(phase==='profile') {
  await npmMetadata();
  await client.package(pack.name); // require Hub discovery before saving a release
  await client.saveProfileDraft({...read(join(out,'profile-draft.json')),visibility:'public'});
  console.log(JSON.stringify(await client.publishProfile('dscode',pack.version,true),null,2));
} else {
  await npmMetadata();
  const profile=await client.profile('dscode');
  // Accept only an exact release returned by the public Hub resolver.
  const selected=profile.versions.find(v=>v.version===pack.version);
  if(profile.visibility !== 'public' || !selected?.bundles.some(b=>b.packageName===pack.name && b.version===pack.version && b.integrity===pack.integrity)) throw Error('The matching public Hub release is not available.');
  publish(launcher);
}
