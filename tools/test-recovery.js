'use strict';
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pomo-recovery-'));
process.env.POMODORO_HOME=root;
const store=require('../lib/store'); store.loadConfig();store.loadState();
assert.equal(store.getConfig().recordDir,path.join(root,'records'));
const start=store.localISO(new Date(2026,10,21,8));
store.appendEvent({t:start,type:'start',id:'crashed',planned:1500});
store.appendEvent({t:store.localISO(new Date(2026,10,21,8,5)),type:'note',id:'crashed',text:'保留这句'});
assert.deepEqual(store.reconcile(),['crashed']);
assert.equal(store.aggregate().get('crashed').status,'void');
assert.deepEqual(store.reconcile(),[]);
assert.equal(store.readEvents().filter(e=>e.type==='void').length,1);
const session={id:'atomic-crash',start,end:start,status:'done',actual:1500,notes:[],category:'create'};
const f=store.writeSessionToMD(session);
// Simulate disk state lost after Markdown was saved. Stable marker prevents a duplicate.
fs.writeFileSync(path.join(root,'data/state.json'),JSON.stringify({writtenIds:[]}));
store.loadState();store.writeSessionToMD(session);store.writeSessionToMD(session);
assert.equal((fs.readFileSync(f,'utf8').match(/pomodoro:atomic-crash/g)||[]).length,1);
// A real read failure must not overwrite the original file.
const read=fs.readFileSync;let failed=false;
fs.readFileSync=function(file,...args){if(file===f){const e=new Error('read denied');e.code='EACCES';throw e;}return read.call(fs,file,...args)};
try{store.writeSessionToMD({...session,id:'read-denied'})}catch(e){failed=e.code==='EACCES'}finally{fs.readFileSync=read}
assert.ok(failed);assert.ok(!fs.readFileSync(f,'utf8').includes('read-denied'));
console.log('PASS: isolated records, durable recovery, no duplicate after partial write, read-error preservation');
