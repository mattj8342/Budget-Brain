import test from 'node:test';
import assert from 'node:assert/strict';
import {createAllocationHistory} from './allocation-history.mjs';
import {createCloudStore} from './cloud-store.mjs';
const bid='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333',root='budgets/'+bid+'/';
function fixture(){
 const rows=new Map(),config={revision:'pinned',settings:{timezone:'America/Chicago'},history:{records:[{status:'completed',date:'2026-10-23',file:'ALLOCATION_2026-10-23.md'}]}};
 const store={list:async prefix=>[...rows.keys()].filter(k=>k.startsWith(prefix)),get:async k=>rows.get(k)??null};
 const loader={load:async()=>config,history:async(date,pinned)=>{assert.equal(pinned,config);return {date,completed_record:'Imported completed report'};}};
 const service=createAllocationHistory({budgetId:bid,loader,store});
 const add=(plan_id,when,status='verified_complete')=>rows.set(root+'paycheck-results/'+plan_id+'.json',{plan_id,completed_at:when,payday:'2026-10-23',status,rows:[]});
 return {rows,config,store,loader,service,add};
}
test('latest falls back to pinned imported history when no new completed report exists',async()=>{
 const f=fixture(),r=await f.service.latest();assert.equal(r.status,'found');assert.equal(r.report.source,'imported_github');assert.equal(r.report.content.date,'2026-10-23');
 assert.equal(r.report.payday,null);assert.equal(r.report.precision,'date');
});
test('latest sorts actual completion time, not random object names or payday',async()=>{
 const f=fixture();f.add(id,'2026-10-25T18:00:00Z');f.add(other,'2026-10-26T18:00:00Z');
 const r=await f.service.latest();assert.equal(r.report.plan_id,other);assert.equal(r.report.source,'cloud_storage');
 const list=await f.service.list(1);assert.equal(list.reports.length,1);assert.equal(list.has_more,true);assert.equal(list.total_completed,3);assert.ok(!('_content' in list.reports[0]));
});
test('imported record newer than cloud result wins; drafts, receipts and cycle pointers never masquerade as reports',async()=>{
 const f=fixture();f.add(id,'2026-10-22T18:00:00Z');f.add(other,'2026-12-01T18:00:00Z','needs_review');
 f.rows.set(root+'paycheck-plans/future.json',{status:'calculated'});f.rows.set(root+'receipts/future.json',{status:'complete'});
 assert.equal((await f.service.latest()).report.source,'imported_github');assert.equal((await f.service.list()).total_completed,2);
});
test('same-date imported/cloud reports return ambiguity instead of fabricating time order',async()=>{
 const f=fixture();f.add(id,'2026-10-23T18:00:00Z');const r=await f.service.latest();assert.equal(r.status,'ambiguous_latest');assert.equal(r.report,null);assert.equal(r.candidates.length,2);
});
test('completion date uses household timezone and returns active write recovery context',async()=>{
 const f=fixture();f.config.history.records=[];f.add(id,'2026-10-24T01:00:00Z');f.rows.set(root+'write-lock.json',{proposal_id:other});f.rows.set(root+'receipts/'+other+'.json',{status:'started'});
 const r=await f.service.latest();assert.equal(r.report.completed_on,'2026-10-23');assert.equal(r.write_receipt.status,'started');assert.ok(r.active_write);assert.ok(r.warnings.length);
});
test('empty history, invalid completed record, missing objects and incomplete listing never produce guessed latest',async()=>{
 const f=fixture();f.config.history.records=[];assert.equal((await f.service.latest()).status,'none');
 f.add(id,'not-a-date');await assert.rejects(f.service.latest(),/Invalid completed/);
 f.rows.clear();f.store.list=async()=>[root+'paycheck-results/'+id+'.json'];await assert.rejects(f.service.latest(),/changed during/);
 f.store.list=async()=>{throw Error('listing forbidden');};await assert.rejects(f.service.latest(),/forbidden/);
 await assert.rejects(f.service.list(101),/Limit/);
});
test('Cloud Storage listing follows empty continuation pages and keeps an exact budget prefix',async()=>{
 const urls=[];
 const store=createCloudStore('test-history-bucket',async (input,init)=>{
  const url=String(input);urls.push(url);
  if(url.includes('metadata.google'))return new Response(JSON.stringify({access_token:'fake',expires_in:300}));
  assert.equal(init.method,undefined);assert.equal(init.headers.Authorization,'Bearer fake');
  const parsed=new URL(url);assert.equal(parsed.searchParams.get('prefix'),root+'paycheck-results/');
  const page=parsed.searchParams.get('pageToken');
  if(!page)return new Response(JSON.stringify({items:[{name:root+'paycheck-results/'+id+'.json'}],nextPageToken:'second'}));
  if(page==='second')return new Response(JSON.stringify({nextPageToken:'third'}));
  return new Response(JSON.stringify({items:[{name:root+'paycheck-results/'+other+'.json'}]}));
 });
 const names=await store.list(root+'paycheck-results/');assert.equal(names.length,2);assert.equal(urls.length,4);
});
test('Cloud Storage rejects out-of-scope objects and loops',async()=>{
 let metadata=true;
 const store=createCloudStore('test-history-bucket',async url=>{
  if(String(url).includes('metadata.google'))return new Response(JSON.stringify({access_token:'fake',expires_in:300}));
  return new Response(JSON.stringify(metadata?{items:[{name:'budgets/other/private.json'}]}:{nextPageToken:'same'}));
 });
 await assert.rejects(store.list(root+'paycheck-results/'),/scope/);metadata=false;await assert.rejects(store.list(root+'paycheck-results/'),/Repeated/);
});

test('all storage operations construct valid HTTP headers, without methods leaking into header values',async()=>{
 const methods=[];
 const store=createCloudStore('test-history-bucket',async(url,init)=>{
  const request=new Request(url,init); // Enforce the same Headers validation as real fetch.
  if(String(url).includes('metadata.google'))return new Response(JSON.stringify({access_token:'fake',expires_in:300}));
  assert.deepEqual([...request.headers.keys()].sort(),init.method==='POST'?['authorization','content-type']:['authorization']);
  methods.push(request.method);
  if(request.method==='DELETE')return new Response(null,{status:204});
  if(new URL(url).searchParams.has('prefix'))return new Response(JSON.stringify({items:[]}));
  return new Response(JSON.stringify({ok:true}));
 });
 await store.list(root+'paycheck-results/');await store.get(root+'x.json');await store.put(root+'x.json',{ok:true});await store.delete(root+'x.json');
 assert.deepEqual(methods,['GET','GET','POST','DELETE']);
});
