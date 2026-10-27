import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaycheckService,planSchema,snapshotFromBudget} from './paycheck.mjs';
const bid='11111111-1111-4111-8111-111111111111',food='22222222-2222-4222-8222-222222222222',income='33333333-3333-4333-8333-333333333333';
function fixture(){
 const rows=new Map(),store={get:async k=>rows.get(k)??null,put:async(k,v,only)=>{if(only&&rows.has(k))return false;rows.set(k,structuredClone(v));return true;},delete:async k=>rows.delete(k)};
 const settings={allocation_policy:{schema_version:1,rta_category_id:'rta',weekly_topups:[{category_id:food,weeks:2}],monthly_targets:[],card_floors:[],card_category_ids:[],excluded_category_ids:[],excluded_group_ids:[],monthly_bill_group_ids:[],annual_bill_group_ids:[]}};
 let revision='a'.repeat(40),version=1,time=Date.parse('2026-10-24T12:00:00Z');
 const snap={budget_id:bid,month:'2026-10-01',as_of:'2026-10-24',captured_at:'2026-10-24T12:00:00Z',server_knowledge:1,ready_to_assign:500000,categories:[{id:food,name:'Food',budgeted:0,balance:20000,goal_target:100000,goal_cadence:2}],accounts:[{id:'bank',name:'Bank',on_budget:true,balance:500000,cleared_balance:500000}],transactions:[{id:income,date:'2026-10-23',amount:500000,category_id:'rta',account_id:'bank',cleared:'cleared'}],obligations:[],issues:[]};
 const history={records:[]};
 const service=createPaycheckService({secret:'synthetic',budgetId:bid,loader:{load:async()=>({settings,revision,history})},store,snapshotReader:async()=>structuredClone({...snap,server_knowledge:version}),stateReader:async()=>version,now:()=>time});
 const input=()=>planSchema.parse({payday:'2026-10-23',next_payday:'2026-11-06',income_transaction_ids:[income]});
 let calls=0;
 const execute=async args=>{calls++;for(const a of args.assignments){const c=snap.categories.find(c=>c.id===a.category_id),next=Math.round(a.budgeted*1000),delta=next-c.budgeted;c.budgeted=next;c.balance+=delta;snap.ready_to_assign-=delta;}version++;return {structuredContent:{results:args.assignments.map(()=>({status:'updated'}))},content:[]};};
 return {service,store,rows,snap,settings,history,input,execute,calls:()=>calls,setVersion:n=>version=n,setRevision:s=>revision=s,advance:n=>time+=n};
}
test('plan reads actual income, previews without changes, approves once and saves verified completion',async()=>{
 const f=fixture(),p=(await f.service.plan(f.input(),'user')).structuredContent;
 assert.equal(p.assigned_milliunits,180000);assert.equal(f.calls(),0);
 const denied=await f.service.execute({plan_id:p.plan_id},'user',f.execute);assert.equal(denied.isError,true);
 const preview=await f.service.execute({plan_id:p.plan_id,cash_and_bills_reviewed:true},'user',f.execute);assert.equal(preview.structuredContent.status,'preview_only');assert.equal(f.calls(),0);
 const args={plan_id:p.plan_id,preview_token:preview.structuredContent.preview_token,both_partners_agree:true};
 const done=await f.service.execute(args,'user',f.execute);assert.equal(done.structuredContent.status,'verified_complete');assert.equal(f.calls(),1);
 const replay=await f.service.execute(args,'user',f.execute);assert.equal(replay.structuredContent.status,'verified_complete');assert.equal(f.calls(),1);
 const read=(await f.service.inspect({plan_id:p.plan_id},'user')).structuredContent;assert.equal(read.result.status,'verified_complete');
 const next=(await f.service.plan(f.input(),'user')).structuredContent;assert.ok(next.questions.some(q=>q.code==='completed_cycle'));assert.ok(!next.plan_id);
});
test('forecast, non-RTA, transfers and duplicate income cannot be used',async()=>{
 for(const change of [t=>t.amount=-1,t=>t.category_id='expense',t=>t.date='2026-11-01',t=>t.transfer_account_id='other']){
  const f=fixture();change(f.snap.transactions[0]);await assert.rejects(f.service.plan(f.input(),'user'),/actual received/);
 }
 const f=fixture(),i=f.input();i.income_transaction_ids.push(income);await assert.rejects(f.service.plan(i,'user'),/Duplicate/);
});
test('another household member cannot execute a user-bound plan; stale state/settings/expiry fail',async()=>{
 const f=fixture(),p=(await f.service.plan(f.input(),'user')).structuredContent;
 await assert.rejects(f.service.execute({plan_id:p.plan_id},'other',f.execute),/unavailable/);
 for(const mutate of [()=>f.setVersion(2),()=>f.setRevision('b'.repeat(40)),()=>f.advance(31*60000)]){
  mutate();const r=await f.service.execute({plan_id:p.plan_id,cash_and_bills_reviewed:true},'user',f.execute);assert.equal(r.isError,true);
 }
 assert.equal(f.calls(),0);
});
test('partial assignment result retains write lock and never records completion',async()=>{
 const f=fixture(),p=(await f.service.plan(f.input(),'user')).structuredContent;
 const preview=(await f.service.execute({plan_id:p.plan_id,cash_and_bills_reviewed:true},'user',f.execute)).structuredContent;
 const r=await f.service.execute({plan_id:p.plan_id,preview_token:preview.preview_token,both_partners_agree:true},'user',async()=>({content:[],structuredContent:{results:[{status:'error'}]}}));
 assert.equal(r.isError,true);assert.ok(await f.store.get('budgets/'+bid+'/write-lock.json'));assert.equal((await f.service.inspect({payday:'2026-10-23'},'user')).structuredContent.cycle,null);
});
test('post-write verification drift retains recovery lock; no new-plan replay',async()=>{
 const f=fixture(),p=(await f.service.plan(f.input(),'user')).structuredContent;
 const preview=(await f.service.execute({plan_id:p.plan_id,cash_and_bills_reviewed:true},'user',f.execute)).structuredContent;
 const r=await f.service.execute({plan_id:p.plan_id,preview_token:preview.preview_token,both_partners_agree:true},'user',async args=>{const r=await f.execute(args);f.snap.categories[0].balance++;return r;});
 assert.equal(r.isError,true);assert.ok(await f.store.get('budgets/'+bid+'/write-lock.json'));
 const again=(await f.service.plan(f.input(),'user')).structuredContent;assert.ok(again.questions.some(q=>q.code==='write_recovery'));assert.ok(!again.plan_id);
});
test('completed imported cycle forces catch-up and reports gaps without storing executable draft',async()=>{
 const f=fixture();f.history.records.push({date:'2026-10-24',status:'completed',file:'ALLOCATION_2026-10-24.md'});
 const r=(await f.service.plan(f.input(),'user')).structuredContent;assert.equal(r.status,'needs_clarification');assert.ok(!r.plan_id);
});
test('snapshot keeps one server revision, exact month figures, split credit spending and conservative future RTA',()=>{
 const data={server_knowledge:5,budget:{id:bid,name:'Test',category_groups:[{id:'g',name:'General'}],categories:[{id:food,category_group_id:'g',name:'Food',goal_target:100000}],months:[{month:'2026-10-01',to_be_budgeted:500000,categories:[{id:food,category_group_id:'g',budgeted:10000,balance:20000}]},{month:'2026-11-01',to_be_budgeted:300000,categories:[]}],accounts:[{id:'cc',type:'creditCard',on_budget:true}],transactions:[{id:'parent',date:'2026-10-24',account_id:'cc',amount:-10000}],subtransactions:[{transaction_id:'parent',category_id:food,amount:-10000}],scheduled_transactions:[{id:'s',category_id:food,account_id:'cc',date_next:'2026-10-25',frequency:'weekly',amount:-10000}]}};
 const s=snapshotFromBudget(data,{timezone:'America/Chicago',now:new Date('2026-10-24T20:00:00Z'),next_payday:'2026-11-06'});
 assert.equal(s.ready_to_assign,300000);assert.equal(s.server_knowledge,5);assert.equal(s.categories[0].goal_target,100000);assert.ok(s.credit_spending_category_ids.includes(food));assert.equal(s.obligations.length,2);
});

test('authenticated MCP discovers paycheck tools and calculates a synthetic plan end to end',async()=>{
 const {generateKeyPair,SignJWT,exportJWK,createLocalJWKSet}=await import('jose');
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const {createApp}=await import('./server.mjs');
 const f=fixture();f.store.list=async prefix=>[...f.rows.keys()].filter(k=>k.startsWith(prefix));const issuer='https://identity.example/',resource='https://budget.example/mcp',subject='auth0|household';
 const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='test';
 const token=await new SignJWT({sub:subject}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey);
 const app=createApp({accessToken:'fake-no-ynab-writes',budgetId:bid,authMode:'oauth',writeMode:'full',authConfig:{issuer,resource,allowedSubjects:subject,keySet:createLocalJWKSet({keys:[jwk]})},householdLoader:{load:async()=>({settings:f.settings,revision:'a'.repeat(40),history:{records:[]}})},writeStore:f.store,stateReader:async()=>1,snapshotReader:async()=>structuredClone(f.snap)});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const client=new Client({name:'paycheck-evaluation',version:'1'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+app.address().port+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const tools=(await client.listTools()).tools;
  for(const name of ['plan_paycheck','get_paycheck_plan','execute_paycheck_plan','get_latest_allocation_report','list_allocation_reports'])assert.ok(tools.some(t=>t.name===name),name);
  const history=await client.callTool({name:'get_latest_allocation_report',arguments:{}});assert.equal(history.structuredContent.status,'none');
  assert.equal(tools.find(t=>t.name==='get_latest_allocation_report').annotations.readOnlyHint,true);
  const result=await client.callTool({name:'plan_paycheck',arguments:f.input()});assert.equal(result.structuredContent.status,'calculated');
  assert.equal(result.structuredContent.assigned_milliunits,180000);
  const preview=await client.callTool({name:'execute_paycheck_plan',arguments:{plan_id:result.structuredContent.plan_id,cash_and_bills_reviewed:true}});
  assert.equal(preview.structuredContent.status,'preview_only');assert.equal(f.calls(),0);
  const wrong=await client.callTool({name:'plan_paycheck',arguments:{...f.input(),budget_id:'44444444-4444-4444-8444-444444444444'}}).then(()=>null,e=>e);
  assert.ok(wrong);
 }finally{await client.close();app.closeAllConnections();await new Promise(r=>app.close(r));}
});
test('monthly schedules preserve original end-of-month anchor and report unsupported frequencies',()=>{
 const data={server_knowledge:1,budget:{id:bid,months:[{month:'2026-01-01',to_be_budgeted:1000,categories:[]}],scheduled_transactions:[{id:'s',date_next:'2026-01-31',frequency:'monthly',amount:-100,category_id:food}]}};
 const s=snapshotFromBudget(data,{timezone:'UTC',now:new Date('2026-01-24T12:00:00Z'),next_payday:'2026-04-01'});
 assert.deepEqual(s.obligations.map(o=>o.due_date),['2026-01-31','2026-02-28','2026-03-31']);
 data.budget.scheduled_transactions[0].frequency='twiceAMonth';
 assert.ok(snapshotFromBudget(data,{timezone:'UTC',now:new Date('2026-01-24T12:00:00Z'),next_payday:'2026-02-01'}).issues.length);
});

test('generic write gate also detects embedded batch failures without isError',async()=>{
 const f=fixture();
 const {createWriteGate}=await import('./write-gate.mjs');
 const gate=createWriteGate({secret:'fake',budgetId:bid,loader:{load:async()=>({revision:'a'})},store:f.store,stateReader:async()=>1});
 const args={budget_id:bid,assignments:[{category_id:food,month:'2026-10-01',budgeted:1}]};
 const preview=(await gate.run('set_category_budgets',args,'user',async()=>{throw Error('must not execute');})).structuredContent;
 const r=await gate.run('set_category_budgets',{...args,preview_token:preview.preview_token,both_partners_agree:true},'user',async()=>({content:[{type:'text',text:JSON.stringify({results:[{status:'updated'},{status:'error'}]})}]}));
 assert.equal(r.isError,true);assert.ok(await f.store.get('budgets/'+bid+'/write-lock.json'));
});
