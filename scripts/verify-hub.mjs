// Pre-publication integration: real Hub lifecycle + real DSH plugin installer,
// with only our unpublished npm tarball served by a loopback registry fixture.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { canonical } from './release.mjs';
import { installResolvedProfile, rollbackProfile, listProfileRevisions } from '@dsh-plugin-hub/cli';
const root = join(import.meta.dirname, '..');
const out = join(root,'artifacts/npm');
const read = path=>JSON.parse(readFileSync(path,'utf8'));
const release=read(join(out,'hub-release.json'));
const pkg=read(join(out,'bundle/package.json'));
const pack=read(join(out,'bundle-pack.json'))[0];
const home=mkdtempSync(join(tmpdir(),'dscode-hub-verify-'));
const launcherRoot=join(home,'launcher');
const launcherPack=read(join(out,'launcher-pack.json'))[0];
await new Promise((resolve,reject)=>{
  const child=spawn('npm',['install','--prefix',launcherRoot,'--ignore-scripts','--no-audit','--no-fund',join(out,launcherPack.filename)],{stdio:'inherit'});
  child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Launcher npm install failed')));
});
const pnpm=join(launcherRoot,'node_modules/@toddzheng024/dscode/tools');
const upgradeDir=join(home,'upgrade-fixture');cpSync(join(out,'bundle'),upgradeDir,{recursive:true});
const upgradePackage={...pkg,version:pkg.version.split('.').map((part,index)=>index===2?Number(part)+1:part).join('.')+'-test'};
writeFileSync(join(upgradeDir,'package.json'),JSON.stringify(upgradePackage));
const packedUpgrade=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',home],{cwd:upgradeDir,encoding:'utf8'});
if(packedUpgrade.status!==0) throw Error(packedUpgrade.stderr);
const upgradePack=JSON.parse(packedUpgrade.stdout)[0];
let registry;
const server=createServer(async(req,res)=>{
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(pathname==='/'+pkg.name) {
      const version={...pkg,dist:{integrity:pack.integrity,shasum:pack.shasum,tarball:registry+'/bundle.tgz'}};
      const upgradeVersion={...upgradePackage,dist:{integrity:upgradePack.integrity,shasum:upgradePack.shasum,tarball:registry+'/upgrade.tgz'}};
      res.setHeader('content-type','application/json'); res.end(JSON.stringify({name:pkg.name,'dist-tags':{latest:pkg.version},versions:{[pkg.version]:version,[upgradePackage.version]:upgradeVersion}}));
    } else if(pathname==='/bundle.tgz') {res.end(readFileSync(join(out,pack.filename)));}
    else if(pathname==='/upgrade.tgz') {res.end(readFileSync(join(home,upgradePack.filename)));}
    else {
      const upstream=await fetch('https://registry.npmjs.org'+req.url,{headers:{accept:'application/json'}});
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch(error) {res.writeHead(502);res.end('Fixture registry failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
registry='http://127.0.0.1:'+server.address().port;
const npmrc=join(home,'registry.npmrc');
writeFileSync(npmrc,`registry=${registry}\n@toddzheng024:registry=${registry}\nignore-scripts=true\n`);
process.env.DSH_HOME=home;process.env.DSH_AGENTS_HOME=join(home,'agents');
const env={...process.env,DSH_HOME:home,DSH_AGENTS_HOME:join(home,'agents'),PATH:pnpm+':'+process.env.PATH,npm_config_userconfig:npmrc,NPM_CONFIG_USERCONFIG:npmrc,npm_config_registry:registry,NPM_CONFIG_REGISTRY:registry,npm_config_ignore_scripts:'true',DSH_HUB_TELEMETRY:'off'};
const exec=(entry,args,extra={},program=false)=>new Promise((resolve,reject)=>{
 const child=spawn(program ? entry : process.execPath,program ? args : [entry,...args],{cwd:home,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const timeout=setTimeout(()=>child.kill('SIGTERM'),180000);
 child.on('error',reject);child.on('close',code=>{clearTimeout(timeout);code===0?resolve(output):reject(Error(`Child exit ${code}:\n${output}`));});
});
const execute=async command=>{const output=await exec(command.command,command.args,{},true); if(/patch: .*skipping/.test(output)) throw Error(output);};
const options={profile:'dscode',dshHome:home,hubProfileSlug:'dscode',release,resolved:{profileVersion:release.version,bundles:release.bundles},execute,validate:execute};
try {
  // Exercise the native locked installer used by the launcher, not only the
  // legacy external-executor seam below (which has no effective-lock receipt).
  const nativeHome = join(home, 'native');
  mkdirSync(nativeHome);
  const nativeProbe = join(home, 'native-install.mjs');
  const hub = join(launcherRoot, 'node_modules/@toddzheng024/dscode/vendor/hub-cli/dist');
  writeFileSync(nativeProbe, `import assert from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nimport {installResolvedProfile} from ${JSON.stringify(pathToFileURL(join(hub, 'index.js')).href)};\nimport {doctorProfile} from ${JSON.stringify(pathToFileURL(join(hub, 'profile-lifecycle.js')).href)};\nconst release=JSON.parse(readFileSync(${JSON.stringify(join(out, 'hub-release.json'))},'utf8'));\nconst result=await installResolvedProfile({profile:'dscode',dshHome:process.env.DSH_HOME,release,resolved:{profileVersion:release.version,bundles:release.bundles}});\nassert(result.lockfile.effectiveLock);\nconst doctor=await doctorProfile({profile:'dscode',dshHome:process.env.DSH_HOME});\nassert(doctor.healthy,JSON.stringify(doctor));\nconsole.log('NATIVE_HUB_INSTALL_PASSED');\n`);
  const nativeEnv = { DSH_HOME: nativeHome, DSCODE_HOME: nativeHome, DSH_AGENTS_HOME: join(nativeHome, 'agents') };
  assert((await exec(nativeProbe, [], nativeEnv)).includes('NATIVE_HUB_INSTALL_PASSED'));
  assert((await exec(join(launcherRoot, 'node_modules/@toddzheng024/dscode/cli.mjs'), ['--dump-config'], nativeEnv)).includes('dscode-bootstrap'));
  const nativeDoctor = JSON.parse(await exec(join(hub, 'bin.js'), ['profile', 'doctor', '--profile', 'dscode', '--json'], nativeEnv));
  assert.equal(nativeDoctor.healthy, true);
  console.log('PASS native locked Hub install, launcher first start and Hub doctor');
  await installResolvedProfile(options);
  console.log('PASS real Hub install + DSH compose:',home);
  const profile=join(home,'profiles/dscode');
  const installedBundle=join(profile,'node_modules',pkg.name);
  assert.equal(read(join(installedBundle,'package.json')).version,pkg.version);
  for(const name of readdirSync(join(profile,'node_modules/@deepseek-ai'))) {
    if(!name.startsWith('dsh')) continue;
    assert.equal(read(join(profile,'node_modules/@deepseek-ai',name,'package.json')).version,release.dsh,name);
  }
  mkdirSync(join(profile,'probe'));
  for(const file of ['probe-plugin.mjs','dscode-probe.mjs','session-messaging-probe.mjs','session-cards-probe.mjs','memory-probe.mjs']) {
    writeFileSync(join(profile,'probe',file),readFileSync(join(root,'scripts',file),'utf8').replaceAll("'../plugins/",`'../node_modules/${pkg.name}/plugins/`));
  }
  cpSync(join(root,'scripts/hook-fixture.mjs'),join(home,'hook-fixture.mjs'));
  mkdirSync(join(home,'config'),{recursive:true});
  const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
  writeFileSync(join(home,'config/hooks.local.json'),JSON.stringify({hooks:{PreToolUse:[{matcher:'^bash$',hooks:[{type:'command',command:quote(process.execPath)+' '+quote(join(home,'hook-fixture.mjs')),timeout:5}]}]}}));
  const overlay=join(home,'probe.patch.yml');
  writeFileSync(overlay,`- id: dscode-session-cards\n  config:\n    enabled: false\n- id: dscode-memory\n  config:\n    generate: false\n- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- insert:\n    - id: harness-probe\n      name: ${JSON.stringify(join(profile,'probe/probe-plugin.mjs'))}\n`);
  const installedRuntime=join(profile,'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const result=await exec(installedRuntime,['--profile','dscode','--patch',overlay],{DSH_TUI_PROBE_REPORT:join(home,'probe.json')});
  assert(result.includes('HARNESS_PROBE_PASSED'),result);
  assert.match(read(join(home,'probe.json')).dscode.childWorktree, /spawn foreground and fork background cwd/);
  console.log('PASS installed bundle agent loop, shell, subagent worktrees, auto review, compaction and telemetry');
  // The child worktree probe creates its own clean Git repository. The card
  // probes below use the install home for their separate project identity.
  const project=spawnSync('git',['init','--quiet',home],{encoding:'utf8'});
  if(project.status!==0) throw Error(project.stderr);
  const basePatch = '- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n';
  for (const [name, settings, marker] of [
    ['session-messaging', '- id: dscode-session-cards\n  config:\n    enabled: false\n- id: dscode-memory\n  config:\n    generate: false\n', 'SESSION_MESSAGING_PROBE_PASSED'],
    ['session-cards', '- id: dscode-memory\n  config:\n    generate: false\n- id: dscode-session-cards\n  config:\n    minMessages: 1\n    debounceMs: 0\n    cooldownMs: 0\n', 'SESSION_CARDS_PROBE_PASSED'],
    ['memory', '- id: dscode-session-cards\n  config:\n    enabled: false\n', 'MEMORY_PROBE_PASSED'],
  ]) {
    const patch = join(home, name + '.patch.yml');
    writeFileSync(patch, basePatch + settings + `- insert:\n    - id: ${name}-probe\n      name: ${JSON.stringify(join(profile, 'probe', name + '-probe.mjs'))}\n`);
    const output = await exec(installedRuntime, ['--profile','dscode','--patch',patch], {
      DSCODE_MEMORY_HOME: join(home, 'memories'), DSCODE_MESSAGING_PATCH: patch,
      DSCODE_MESSAGING_RUNTIME: installedRuntime, DSCODE_MESSAGING_PROFILE: 'dscode',
    });
    assert(output.includes(marker), output);
    console.log('PASS installed bundle ' + name);
  }
  const marker=join(home,'session-preservation-test.txt');writeFileSync(marker,'retained');
  const upgradeRelease={...release,version:upgradePackage.version,bundles:release.bundles.map(b=>({...b,selector:upgradePackage.version,version:upgradePackage.version,installSpec:b.packageName+'@'+upgradePackage.version,integrity:upgradePack.integrity}))};
  delete upgradeRelease.contentHash;upgradeRelease.contentHash='sha256:'+createHash('sha256').update(canonical(upgradeRelease)).digest('hex');
  const upgradeOptions={...options,release:upgradeRelease,resolved:{profileVersion:upgradeRelease.version,bundles:upgradeRelease.bundles}};
  await assert.rejects(installResolvedProfile({...upgradeOptions,validate:async()=>{throw Error('fixture composition rejection');}}),/fixture composition rejection/);
  assert.equal(read(join(profile,'node_modules',pkg.name,'package.json')).version,pkg.version);
  await installResolvedProfile(upgradeOptions);
  assert.equal(read(join(profile,'node_modules',pkg.name,'package.json')).version,upgradePackage.version);
  assert((await listProfileRevisions('dscode',home)).length>0);
  await rollbackProfile({profile:'dscode',dshHome:home});
  assert.equal(readFileSync(marker,'utf8'),'retained');
  assert.equal(read(join(profile,'node_modules',pkg.name,'package.json')).version,pkg.version);
  const composed=await exec(installedRuntime,['--profile','dscode','--dump-config']);
  assert(composed.includes('dscode-bootstrap'));
  console.log(`PASS failed upgrade preserves old profile; ${pkg.version} -> ${upgradePackage.version} -> rollback preserves state and restores a runnable profile`);
  mkdirSync(join(root,'artifacts/local'),{recursive:true});
  writeFileSync(join(root,'artifacts/local/hub-verification.json'),JSON.stringify({home,package:pkg.name,version:pkg.version,integrity:pack.integrity,launcherIntegrity:launcherPack.integrity,install:true,nativeInstall:true,launcherFirstStart:true,hubDoctor:true,agentProbe:read(join(home,'probe.json')),rollback:true,fixture:'Loopback npm registry for unpublished bundle; native locked installation and launcher first start, plus external-executor probes for failed upgrade, successful upgrade and rollback. Public Hub discovery and npm publication not exercised.'},null,2));
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
