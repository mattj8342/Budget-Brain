import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,ids} from './impact-fixture.mjs';
import {createImpactService} from './impact-service.mjs';
function serviceFixture(){
 const f=fixture(),data=new Map();let revision='a',now=Date.parse(f.snapshot.captured_at),calls=0,puts=0;
 const store={get:async key=>structuredClone(data.get(key)??null),put:async(key,v,only)=>{puts++;if(only&&data.has(key))return false;data.set(key,structuredClone(v));return true;},delete:async key=>data.delete(key)};
 const service=createImpactService({secret:'synthetic',budgetId:ids.budget,loader:{load:async()=>({settings:f.settings,revision,history:{records:[{status:'completed',date:'2026-10-23',file:'ALLOCATION_2026-10-23.md'}]}})},store,snapshotReader:async()=>structuredClone(f.snapshot),now:()=>now});
 const execute=async({assignments})=>{calls++;for(const a of assignments){const c=f.snapshot.categories.find(c=>c.id===a.category_id),assigned=Math.round(a.budgeted*1000),delta=assigned-c.budgeted;c.budgeted=assigned;c.balance+=delta;f.snapshot.ready_to_assign-=delta;}f.snapshot.server_knowledge++;return {structuredContent:{results:assignments.map(a=>({...a,status:'updated'}))},content:[]};};
 const prepare=async(subject='alice')=>{const compared=(await service.compare(f.input,subject)).structuredContent;return (await service.prepare({comparison_input:f.input,comparison_fingerprint:compared.comparison_fingerprint,scenario_id:'move'},subject)).structuredContent;};
 return {...f,data,store,service,execute,prepare,calls:()=>calls,puts:()=>puts,setRevision:v=>revision=v,expire:()=>now+=31*60000};
}
test('impact comparison is read-only and stale comparisons do not create drafts',async()=>{
 const f=serviceFixture(),r=(await f.service.compare(f.input,'alice')).structuredContent;
 assert.equal(f.puts(),0);assert.equal(f.calls(),0);
 f.snapshot.server_knowledge++;
 const prepared=(await f.service.prepare({comparison_input:f.input,comparison_fingerprint:r.comparison_fingerprint,scenario_id:'move'},'alice')).structuredContent;
 assert.equal(prepared.status,'stale_comparison');assert.equal(f.puts(),0);
});
test('selected impact funding plan previews first, approves once, verifies, saves a shared result and replays only its receipt',async()=>{
 const f=serviceFixture(),p=await f.prepare();
 assert.equal(p.status,'prepared');assert.equal(f.calls(),0);
 assert.equal((await f.service.execute({plan_id:p.plan_id},'alice',f.execute)).isError,true);
 const preview=(await f.service.execute({plan_id:p.plan_id,impacts_reviewed:true},'alice',f.execute)).structuredContent;
 assert.equal(preview.status,'preview_only');assert.equal(f.calls(),0);
 const input={plan_id:p.plan_id,preview_token:preview.preview_token,both_partners_agree:true};
 const done=(await f.service.execute(input,'alice',f.execute)).structuredContent;
 assert.equal(done.status,'verified_complete');assert.equal(f.calls(),1);
 assert.equal((await f.service.execute(input,'alice',f.execute)).structuredContent.status,'verified_complete');assert.equal(f.calls(),1);
 const latest=(await f.service.inspect({},'bob')).structuredContent;assert.equal(latest.latest_result.plan_id,p.plan_id);assert.equal(latest.active_write,null);
 await assert.rejects(f.service.inspect({plan_id:p.plan_id},'bob'),/unavailable/);
});
test('executing funding never records the hypothetical purchase or changes bank cash',async()=>{
 const f=serviceFixture();f.input.scenarios[0].purchase={category_id:ids.fun,account_id:ids.bank,date:'2026-10-27',amount:100,counts_toward_remaining_need:false};
 const bank=f.snapshot.accounts[0].balance,p=await f.prepare();
 const preview=(await f.service.execute({plan_id:p.plan_id,impacts_reviewed:true},'alice',f.execute)).structuredContent;
 const done=(await f.service.execute({plan_id:p.plan_id,preview_token:preview.preview_token,both_partners_agree:true},'alice',f.execute)).structuredContent;
 assert.equal(done.status,'verified_complete');assert.equal(f.snapshot.categories.find(c=>c.id===ids.fun).balance,1100000);assert.equal(f.snapshot.accounts[0].balance,bank);assert.deepEqual(f.snapshot.transactions,[]);
});
test('plans are user-bound and reject stale budget, household, calendar and expiry before writes',async()=>{
 for(const mutate of [f=>f.snapshot.server_knowledge++,f=>f.setRevision('changed'),f=>f.snapshot.as_of='2026-10-27',f=>f.expire()]){
  const f=serviceFixture(),p=await f.prepare();
  await assert.rejects(f.service.execute({plan_id:p.plan_id,impacts_reviewed:true},'bob',f.execute),/unavailable/);
  mutate(f);assert.equal((await f.service.execute({plan_id:p.plan_id,impacts_reviewed:true},'alice',f.execute)).isError,true);assert.equal(f.calls(),0);
 }
});
test('partial results and verification drift retain evidence and recovery lock; no verified latest report is published',async()=>{
 for(const drift of [false,true]){
  const f=serviceFixture(),p=await f.prepare(),preview=(await f.service.execute({plan_id:p.plan_id,impacts_reviewed:true},'alice',f.execute)).structuredContent;
  const callback=async args=>{const written=await f.execute(args);if(drift)f.snapshot.categories.find(c=>c.id===ids.fun).balance++;else written.structuredContent.results[0].status='error';return written;};
  assert.equal((await f.service.execute({plan_id:p.plan_id,preview_token:preview.preview_token,both_partners_agree:true},'alice',callback)).isError,true);
  const state=(await f.service.inspect({plan_id:p.plan_id},'alice')).structuredContent;
  assert.ok(state.active_write);assert.ok(state.result.upstream_result);assert.equal(state.result.status,'write_returned_needs_verification');
  assert.equal((await f.service.inspect({},'alice')).structuredContent.latest_result,null);
  const compared=(await f.service.compare(f.input,'alice')).structuredContent;assert.equal(compared.options[0].execution_eligible,false);
 }
});
test('unsupported/future-money scenario cannot prepare an executable draft or bypass the budget scope',async()=>{
 const f=serviceFixture();f.input.scenarios[0].moves=[{from_category_id:'ready_to_assign',to_category_id:ids.fun,amount:200}];
 const r=(await f.service.compare(f.input,'alice')).structuredContent;
 const p=(await f.service.prepare({comparison_input:f.input,comparison_fingerprint:r.comparison_fingerprint,scenario_id:'move'},'alice')).structuredContent;
 assert.equal(p.status,'not_executable');assert.equal(f.puts(),0);
 await assert.rejects(f.service.compare({...f.input,budget_id:'other'},'alice'),/Wrong budget/);
});
