import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteGate } from './write-gate.mjs';
import { CloudUndoStore } from './cloud-store.mjs';
import { createHouseholdLoader } from './household.mjs';
export function memoryStore(){const data=new Map();return {data,async get(k){return data.has(k)?structuredClone(data.get(k)):null;},async put(k,v,createOnly=false){if(createOnly&&data.has(k))return false;data.set(k,structuredClone(v));return true;},async delete(k){data.delete(k);}};}
function fixture(){const store=memoryStore();let version=1,revision='a',calls=0,time=Date.now();const opts={secret:'fake',budgetId:'budget',loader:{load:async()=>({revision})},store,stateReader:async()=>version,now:()=>time};return {store,opts,gate:createWriteGate(opts),args:{budget_id:'budget',transactions:[{amount:-1}]},async execute(){calls++;return {content:[{type:'text',text:'done'}]};},get calls(){return calls;},changeState(){version++;},changeRules(){revision='b';},expire(){time+=31*60000;}};}
async function proposal(f){return (await f.gate.run('create_transactions',f.args,'alice',()=>f.execute())).structuredContent;}
test('write requires exact signed preview and joint approval; receipt prevents replay after restart',async()=>{
 const f=fixture(),p=await proposal(f);assert.equal(f.calls,0);assert.equal(p.status,'preview_only');
 const args={...f.args,preview_token:p.preview_token,both_partners_agree:true};
 assert.ok((await f.gate.run('create_transactions',{...args,both_partners_agree:false},'alice',()=>f.execute())).isError);
 assert.ok((await f.gate.run('create_transactions',args,'bob',()=>f.execute())).isError);
 assert.ok((await f.gate.run('create_transactions',{...args,transactions:[{amount:-999}]},'alice',()=>f.execute())).isError);
 assert.ok((await f.gate.run('create_transactions',{...args,preview_token:args.preview_token+'x'},'alice',()=>f.execute())).isError);
 const done=await f.gate.run('create_transactions',args,'alice',()=>f.execute());assert.ok(!done.isError);assert.equal(f.calls,1);
 assert.deepEqual(await createWriteGate(f.opts).run('create_transactions',args,'alice',()=>f.execute()),done);assert.equal(f.calls,1);
 assert.equal(await f.store.get('budgets/budget/write-lock.json'),null);
});
test('changed YNAB state, rules, expiry and budget block before writes',async()=>{
 for(const change of ['changeState','changeRules','expire']){const f=fixture(),p=await proposal(f);f[change]();assert.ok((await f.gate.run('create_transactions',{...f.args,preview_token:p.preview_token,both_partners_agree:true},'alice',()=>f.execute())).isError);assert.equal(f.calls,0);}
 const f=fixture();assert.ok((await f.gate.run('create_transactions',{...f.args,budget_id:'other'},'alice',()=>f.execute())).isError);
});
test('partial or uncertain execution remains durably locked and never replays',async()=>{
 for(const throwing of [true,false]){const f=fixture(),p=await proposal(f);const args={...f.args,preview_token:p.preview_token,both_partners_agree:true};let calls=0;
 const action=async()=>{calls++;if(throwing)throw new Error('network lost');return {isError:true,content:[{type:'text',text:'partial failure'}]};};
 assert.ok((await f.gate.run('create_transactions',args,'alice',action)).isError);
 assert.ok(await f.store.get('budgets/budget/write-lock.json'));
 assert.ok((await createWriteGate(f.opts).run('create_transactions',args,'alice',action)).isError);assert.equal(calls,1);
 }
});
test('simultaneous confirmations execute at most once',async()=>{
 const f=fixture(),p=await proposal(f),args={...f.args,preview_token:p.preview_token,both_partners_agree:true};
 await Promise.all([f.gate.run('create_transactions',args,'alice',()=>f.execute()),createWriteGate(f.opts).run('create_transactions',args,'alice',()=>f.execute())]);assert.equal(f.calls,1);
});
test('undo history survives a fresh store instance',async()=>{
 const cloud=memoryStore(),first=new CloudUndoStore(cloud);
 const entry={id:'entry',status:'active',undo_action:{entity_id:'tx'}};
 await first.appendEntries('budget',[entry]);
 const second=new CloudUndoStore(cloud);assert.deepEqual(await second.listEntries('budget',{limit:10}),[entry]);
 await second.markEntriesUndone('budget',['entry']);assert.equal((await first.listEntries('budget',{limit:10})).length,0);
});
test('private household reads pin all files to one commit and reject another budget',async()=>{
 const paths=[];const revision='a'.repeat(40);let configured='budget';
 const fetchImpl=async url=>{paths.push(url);const obj=url.endsWith('commits/main')?{sha:revision}:{encoding:'base64',size:100,content:Buffer.from(url.includes('settings.json')?JSON.stringify({schema_version:1,budget:{id:configured},approval:{both_partners_agree:true,exact_changes_required:true}}):url.includes('index.json')?'{}':'Household rules').toString('base64')};return {ok:true,json:async()=>obj};};
 const loader=createHouseholdLoader({repository:'owner/private',token:'fake',budgetId:'budget',fetchImpl});
 const data=await loader.load();assert.equal(data.revision,revision);assert.equal(data.rules,'Household rules');
 assert.ok(paths.filter(p=>p.includes('/contents/')).every(p=>p.endsWith('ref='+revision)));
 configured='other';await assert.rejects(loader.load(),/do not match/);
});
