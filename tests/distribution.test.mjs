import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brewManaged, commandPlan, acquireLock, stateHome, warnCompatibility, describeError, formatFailure, hubFailureHint } from '../packages/launcher/manager.mjs';
const release={slug:'dscode',version:'0.1.0'};
test('launcher routes management separately, pins install version and preserves existing profile',()=>{
 assert.deepEqual(commandPlan([],release,false),{launch:[],install:true});
 assert.deepEqual(commandPlan(['--continue'],release,true),{launch:['--continue'],install:false});
 assert.deepEqual(commandPlan(['update','0.2.0'],release,true).hub,['profile','upgrade','dscode','--version','0.2.0','--profile','dscode']);
 assert.deepEqual(commandPlan(['update','latest'],release,true).hub,['profile','upgrade','dscode','--version','0.1.0','--profile','dscode'],'"latest" is the default the TUI schedules');
 assert.throws(()=>commandPlan(['update','newest'],release,true));
 assert.throws(()=>commandPlan(['rollback','--help'],release,true));
 assert.deepEqual(commandPlan(['rollback'],release,true).hub,['profile','rollback','--profile','dscode']);
 assert.deepEqual(commandPlan(['trigger','run','nightly'],release,true),{trigger:['run','nightly'],install:false},'the trigger CLI is routed, never launched as a prompt');
 assert.deepEqual(commandPlan(['doctor'],release,true),{doctor:'analyze'});
 assert.deepEqual(commandPlan(['doctor','--local'],release,true),{doctor:'local'});
 assert.throws(()=>commandPlan(['doctor','extra'],release,true),/Usage/);
 assert.equal(stateHome({DSCODE_HOME:'/tmp/custom'}),'/tmp/custom');
});
test('management gate excludes concurrent mutations and tolerates stale legacy locks',async ()=>{
 const home=mkdtempSync(join(tmpdir(),'dscode-lock-'));
 try {
  const unlock=await acquireLock(home);
  await assert.rejects(acquireLock(home,{waitMs:0}),/starting or changing versions/);
  unlock();
  writeFileSync(join(home,'.launcher.lock'),'2147483647');
  (await acquireLock(home))();
  writeFileSync(join(home,'.launcher.lock'),String(process.pid));
  await assert.rejects(acquireLock(home),/older DSCODE launcher/);
 } finally {rmSync(home,{recursive:true,force:true});}
});
test('launcher doctor boots a read-only headless diagnostic without taking the session lock',()=>{
 const home=mkdtempSync(join(tmpdir(),'dscode-launcher-doctor-'));
 const bundle='@test/dscode-bundle';
 const profile=join(home,'profiles/dscode');
 const write=(path,contents)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,contents);};
 try {
  write(join(home,'.hub/installations/dscode/current.json'),'{}');
  write(join(profile,'package.json'),'{}');
  write(join(profile,'node_modules',bundle,'plugins/tui-tools/doctor-cli.mjs'),'export {};');
  write(join(profile,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'console.log(JSON.stringify(process.argv.slice(2)));');
  write(join(home,'.launcher.lock'),String(process.pid));
  const manager=new URL('../packages/launcher/manager.mjs',import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import { run } from ${JSON.stringify(manager)}; await run(['doctor'],{bundle:${JSON.stringify(bundle)}});`],{encoding:'utf8',env:{...process.env,DSCODE_HOME:home},timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/doctor-cli\.patch\.yml/);
  assert.match(readFileSync(join(home,'diagnostics/doctor-cli.patch.yml'),'utf8'),/dscode-session-bridge\n {2}disabled: true/);
 } finally {rmSync(home,{recursive:true,force:true});}
});
test('version mismatch warns once and still launches without confirmation',()=>{
 const home=mkdtempSync(join(tmpdir(),'dscode-compat-'));
 const profile=join(home,'profiles/dscode');
 const recommended={slug:'dscode',version:'0.1.0',runtime:'0.1.5-rc.1',bundle:'@test/bundle'};
 const metadata={name:recommended.bundle,version:recommended.version,dependencies:{'@deepseek-ai/dsh':recommended.runtime,'@deepseek-ai/dsh-agent':recommended.runtime}};
 const write=(path,value)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value));};
 const warnings=[];
 try {
  write(join(home,'.hub/installations/dscode/current.json'),{});
  write(join(profile,'package.json'),{private:true});
  write(join(profile,'node_modules',recommended.bundle,'package.json'),metadata);
  for(const name of Object.keys(metadata.dependencies)) write(join(profile,'node_modules',name,'package.json'),{name,version:recommended.runtime});
  assert.deepEqual(warnCompatibility(profile,recommended,metadata,line=>warnings.push(line)),[]);
  assert.equal(warnings.length,0);
  write(join(profile,'node_modules/@deepseek-ai/dsh/package.json'),{name:'@deepseek-ai/dsh',version:'9.0.0'});
  write(join(profile,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'console.log("HARNESS_STARTED");');
  const manager=new URL('../packages/launcher/manager.mjs',import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import { run } from ${JSON.stringify(manager)}; await run([],${JSON.stringify(recommended)});`],{encoding:'utf8',env:{...process.env,DSCODE_HOME:home},timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/HARNESS_STARTED/);
  assert.match(result.stderr,/installed 9\.0\.0, recommended 0\.1\.5-rc\.1/);
  assert.equal(result.stderr.split('[DSCODE warning]').length-1,1);
  rmSync(join(profile,'node_modules/@deepseek-ai/dsh-agent'),{recursive:true});
  const differences=warnCompatibility(profile,recommended,{...metadata,version:'0.2.0'},line=>warnings.push(line));
  assert(differences.some(line=>line.includes('DSCODE bundle: installed 0.2.0')));
  assert(differences.some(line=>line.includes('dsh-agent: version could not be checked')));
  assert.equal(warnings.length,1);
 } finally {rmSync(home,{recursive:true,force:true});}
});

test('launcher exec runs one headless turn through the installed bundle and returns its exit code',()=>{
 assert.equal(commandPlan(['exec','hi'],{},false).install,true);
 assert.deepEqual(commandPlan(['exec','--effort','high','fix','it'],{},true).exec,['--effort','high','fix','it']);
 const home=mkdtempSync(join(tmpdir(),'dscode-launcher-exec-'));
 const release={slug:'dscode',version:'0.1.0',runtime:'0.1.5-rc.1',bundle:'@test/dscode-bundle'};
 const profile=join(home,'profiles/dscode');
 const write=(path,value)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,typeof value==='string'?value:JSON.stringify(value));};
 try {
  write(join(home,'.hub/installations/dscode/current.json'),{});
  write(join(profile,'package.json'),{private:true});
  write(join(profile,'node_modules',release.bundle,'package.json'),{name:release.bundle,version:release.version,dependencies:{'@deepseek-ai/dsh':release.runtime}});
  write(join(profile,'node_modules',release.bundle,'plugins/exec/index.mjs'),'export {};');
  write(join(profile,'node_modules/@deepseek-ai/dsh/package.json'),{name:'@deepseek-ai/dsh',version:release.runtime});
  write(join(profile,'node_modules/@deepseek-ai/dsh/lib/bin.js'),`const fs=require('fs');const argv=process.argv.slice(2);const options=JSON.parse(fs.readFileSync(process.env.DSCODE_EXEC_OPTIONS,'utf8'));
console.log(JSON.stringify({argv,options,prompt:fs.readFileSync(options.promptFile,'utf8'),overlay:fs.readFileSync(argv[argv.lastIndexOf('--patch')+1],'utf8'),cwd:process.cwd()}));process.exit(3);`);
  const manager=new URL('../packages/launcher/manager.mjs',import.meta.url).href;
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import { run } from ${JSON.stringify(manager)}; await run(['exec','--effort','high','--json','fix','it'],${JSON.stringify(release)});`],{encoding:'utf8',cwd:home,env:{...process.env,DSCODE_HOME:home},timeout:10000});
  assert.equal(result.status,3,result.stderr);
  const seen=JSON.parse(result.stdout);
  assert.deepEqual(seen.argv.slice(0,2),['--profile','dscode']);
  assert.equal(seen.prompt,'fix it');
  assert.equal(seen.options.effort,'high'); assert.equal(seen.options.json,true);
  assert.equal(seen.cwd,realpathSync(home)); assert.equal(seen.options.cwd,realpathSync(home));
  assert.match(seen.overlay,/tui-runner\n {2}disabled: true/);
  assert(seen.overlay.includes(join(profile,'node_modules',release.bundle,'plugins/exec/index.mjs')));
  const help=spawnSync(process.execPath,['--input-type=module','-e',`import { run } from ${JSON.stringify(manager)}; await run(['exec','--help'],${JSON.stringify(release)});`],{encoding:'utf8',env:{...process.env,DSCODE_HOME:home},timeout:10000});
  assert.match(help.stdout,/Usage: dscode exec/);
  const bad=spawnSync(process.execPath,['--input-type=module','-e',`import { run } from ${JSON.stringify(manager)}; await run(['exec','--effort','extreme','x'],${JSON.stringify(release)});`],{encoding:'utf8',env:{...process.env,DSCODE_HOME:home},timeout:10000});
  assert.notEqual(bad.status,0); assert.match(bad.stderr,/--effort expects/);
 } finally {rmSync(home,{recursive:true,force:true});}
});

test('the dscode entry answers --version with the DSCODE version, not the DSH runtime',()=>{
 const root=join(import.meta.dirname,'..');
 const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
 for(const flag of ['--version','-v']){
  const result=spawnSync(process.execPath,[join(root,'bin/dscode.mjs'),flag],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout.trim(),version);
  assert.doesNotMatch(result.stdout,/rc\.1/,`${flag} must not fall through to the DSH runtime version`);
 }
});

test('a failed launcher step keeps its cause chain and names the network ways out',()=>{
 const cause=Object.assign(Error('fetch failed'),{code:'ENOTFOUND'});
 assert.equal(describeError(new Error('Hub step failed',{cause})),'Hub step failed <- fetch failed (ENOTFOUND)');
 assert.equal(describeError(Object.assign(Error('ENOTFOUND: flock failed'),{code:'ENOTFOUND'})),'ENOTFOUND: flock failed');
 assert.equal(describeError({code:'ENOENT'}),'ENOENT','a thrown plain object still reports its code');
 assert.equal(describeError(undefined),'Unknown error');
 const hinted=formatFailure(Object.assign(Error('Hub step failed'),{hubHint:['line one']}));
 assert.equal(hinted.split('Hub step failed').length-1,1,'the failure is reported once, not by both the step and the top level');
 assert.equal(hinted.split('- line one').length-1,1);
 assert(hinted.indexOf('- line one')>hinted.indexOf('Hub step failed'),'the hint follows the message');
 assert.equal(formatFailure(Error('plain')),'plain','a failure without hints stays a single line');
 let deep=Error('cause-6'); for(const name of [5,4,3,2,1,0]) deep=Error('cause-'+name,{cause:deep});
 assert(describeError(deep).includes('cause-4')&&describeError(deep).endsWith('…'),'a deep chain is truncated with a marker');
 assert(!describeError(deep).includes('cause-5'));
 const plain=hubFailureHint('/state',{});
 assert(plain.some(line=>line.includes('/state/.env')),'the internal-mirror hint names the state .env');
 assert(!plain.some(line=>line.includes('HTTP(S)_PROXY is set')));
 const proxied=hubFailureHint('/state',{HTTPS_PROXY:'http://user:secret@corp.example:8080'});
 assert(proxied.some(line=>line.includes('HTTP(S)_PROXY is set, but the Hub API call does not use it')));
 assert(!proxied.join(' ').includes('secret'),'a proxy credential is never echoed back');
});

test('an unmanaged profile directory names the way out instead of refusing bare',()=>{
 const home=mkdtempSync(join(tmpdir(),'dscode-unmanaged-'));
 try {
  mkdirSync(join(home,'profiles/dscode'),{recursive:true});
  const manager=new URL('../packages/launcher/manager.mjs',import.meta.url).href;
  const program=`import { run, describeError } from ${JSON.stringify(manager)}; try { await run([], {slug:'dscode',version:'0.0.0'}); } catch (error) { console.error(describeError(error)); process.exitCode=1; }`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',env:{...process.env,DSCODE_HOME:home},timeout:10000});
  assert.equal(result.status,1,result.stderr);
  assert.match(result.stderr,/is not managed by this launcher/);
  assert(result.stderr.includes("mv '" + join(home, 'profiles/dscode') + "' '" + join(home, 'profiles/dscode.unmanaged') + "'"), 'the move that unblocks every command is named');
 } finally {rmSync(home,{recursive:true,force:true});}
});

test('a profile path with a quote stays one shell argument in the printed command',()=>{
 const home=mkdtempSync(join(tmpdir(),"dscode-quote-'"));
 try {
  mkdirSync(join(home,'profiles/dscode'),{recursive:true});
  const manager=new URL('../packages/launcher/manager.mjs',import.meta.url).href;
  const program='import { run, formatFailure } from '+JSON.stringify(manager)+'; try { await run([], {slug:"dscode",version:"0.0.0"}); } catch (error) { console.error(formatFailure(error)); process.exitCode=1; }';
  const result=spawnSync(process.execPath,['--input-type=module','-e',program],{encoding:'utf8',env:{...process.env,DSCODE_HOME:home},timeout:10000});
  assert.equal(result.status,1,result.stderr);
  const backslash=String.fromCharCode(92);
  assert(result.stderr.includes("'" + backslash + "''"),'a quote in the path is escaped for the shell, not left to close the argument');
 } finally {rmSync(home,{recursive:true,force:true});}
});

test('the formula marker keeps the launcher with Homebrew',()=>{
 const directory=mkdtempSync(join(tmpdir(),'dscode-brew-'));
 try{
  assert.equal(brewManaged(directory),false);
  writeFileSync(join(directory,'.dscode-brew'),'1\n');
  assert.equal(brewManaged(directory),true,'the formula marks its own libexec so the npm pass is skipped');
 } finally {rmSync(directory,{recursive:true,force:true});}
});
