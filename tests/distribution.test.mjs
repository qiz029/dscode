import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandPlan, acquireLock, stateHome, warnCompatibility } from '../packages/launcher/manager.mjs';
const release={slug:'dscode',version:'0.1.0'};
test('launcher routes management separately, pins install version and preserves existing profile',()=>{
 assert.deepEqual(commandPlan([],release,false),{launch:[],install:true});
 assert.deepEqual(commandPlan(['--continue'],release,true),{launch:['--continue'],install:false});
 assert.deepEqual(commandPlan(['update','0.2.0'],release,true).hub,['profile','upgrade','dscode','--version','0.2.0','--profile','dscode']);
 assert.throws(()=>commandPlan(['update','latest'],release,true));
 assert.throws(()=>commandPlan(['rollback','--help'],release,true));
 assert.deepEqual(commandPlan(['rollback'],release,true).hub,['profile','rollback','--profile','dscode']);
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
  assert.match(readFileSync(join(home,'diagnostics/doctor-cli.patch.yml'),'utf8'),/dscode-session-bridge\n  disabled: true/);
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
