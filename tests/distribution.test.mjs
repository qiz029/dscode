import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandPlan, acquireLock, stateHome } from '../packages/launcher/manager.mjs';
const release={slug:'dscode',version:'0.1.0'};
test('launcher routes management separately, pins install version and preserves existing profile',()=>{
 assert.deepEqual(commandPlan([],release,false),{launch:[],install:true});
 assert.deepEqual(commandPlan(['--continue'],release,true),{launch:['--continue'],install:false});
 assert.deepEqual(commandPlan(['update','0.2.0'],release,true).hub,['profile','upgrade','dscode','--version','0.2.0','--profile','dscode']);
 assert.throws(()=>commandPlan(['update','latest'],release,true));
 assert.throws(()=>commandPlan(['rollback','--help'],release,true));
 assert.deepEqual(commandPlan(['rollback'],release,true).hub,['profile','rollback','--profile','dscode']);
 assert.equal(stateHome({DSCODE_HOME:'/tmp/custom'}),'/tmp/custom');
});
test('launcher excludes concurrent runs and recovers a dead process lock',()=>{
 const home=mkdtempSync(join(tmpdir(),'dscode-lock-'));
 try {
  const unlock=acquireLock(home);
  assert.throws(()=>acquireLock(home),/already running/);
  unlock();
  writeFileSync(join(home,'.launcher.lock'),'2147483647');
  acquireLock(home)();
  assert(!existsSync(join(home,'.launcher.lock')));
 } finally {rmSync(home,{recursive:true,force:true});}
});
