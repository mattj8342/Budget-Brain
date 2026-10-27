import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTarget,remainingTargetFunding,targetRecurrence,registerTargetDetails} from './target-semantics.mjs';
import {calculatePaycheck} from './allocation.mjs';
import {calculateImpacts} from './impacts.mjs';
import {fixture,ids} from './impact-fixture.mjs';
const category=(id,balance=0,extra={})=>({id,name:id,budgeted:0,balance,category_group_id:'essentials',goal_type:'NEED',goal_cadence:1,goal_cadence_frequency:1,goal_target:100000,goal_needs_whole_amount:false,goal_under_funded:100000,...extra});
const setup=()=>{
 const policy={schema_version:2,excluded_group_ids:['work'],excluded_category_ids:[],card_category_ids:[],monthly_bill_group_ids:[],annual_bill_group_ids:[],weekly_topups:[],monthly_targets:[],card_floors:[],optional_goal_caps:[],target_driven_essentials:{group_ids:['essentials'],priority_category_ids:['food','pet','therapy'],weekly_refill_periods:2,buffer_category_id:'buffer'}};
 const snapshot={budget_id:'test',month:'2026-10-01',as_of:'2026-10-10',captured_at:'2026-10-10T12:00:00Z',server_knowledge:1,ready_to_assign:1000000,categories:[category('food',25000,{goal_cadence:2}),category('pet',25000,{goal_target:125000,goal_under_funded:100000}),category('therapy',90000,{goal_cadence:2,goal_target:15000,goal_needs_whole_amount:true,goal_under_funded:20000}),category('buffer',40000,{category_group_id:'quality',goal_cadence:2,goal_target:50000})],obligations:[]};
 return {snapshot,policy,weekly_contributions:[{category_id:'therapy',already_contributed_milliunits:10000}],payday:'2026-10-09',next_payday:'2026-10-23'};
};
test('refill, set aside, balance and monthly contribution are distinct native target modes',()=>{
 assert.equal(normalizeTarget(category('a')).behavior,'refill');
 assert.equal(normalizeTarget(category('a',0,{goal_needs_whole_amount:true})).behavior,'set_aside');
 assert.equal(normalizeTarget(category('a',0,{goal_type:'TBD'})).behavior,'have_balance');
 assert.equal(normalizeTarget(category('a',0,{goal_type:'MF'})).behavior,'set_aside');
 assert.equal(normalizeTarget(category('a',0,{goal_needs_whole_amount:null})).behavior,'unknown');
});
test('custom frequency distinguishes quarterly clothing from monthly targets',()=>{
 assert.deepEqual([targetRecurrence(category('a',0,{goal_cadence_frequency:3})).cadence,targetRecurrence(category('a',0,{goal_cadence_frequency:3})).every],['monthly',3]);
 assert.equal(targetRecurrence(category('a',0,{goal_cadence:13,goal_cadence_frequency:2})).every,2);
 assert.equal(targetRecurrence(category('a',0,{goal_cadence:4})).every,3);
 assert.equal(targetRecurrence(category('a',0,{goal_cadence_frequency:0})),null);
 assert.equal(targetRecurrence(category('a',0,{goal_type:'DEBT'})),null);
});
test('spent one-time goal funds are not interpreted as an unspent balance requirement',()=>{
 const c=category('trip',100000,{goal_target:3000000,goal_cadence:0,goal_overall_funded:2900000,goal_overall_left:100000});
 assert.equal(remainingTargetFunding(c),100000);
 assert.equal(remainingTargetFunding({...c,goal_type:'TBD'}),2900000);
 assert.equal(remainingTargetFunding({...c,goal_overall_left:null,goal_overall_funded:3000000}),0);
 assert.equal(remainingTargetFunding({...c,goal_overall_left:null,goal_overall_funded:null}),null);
});
test('new payday doubles weekly refills only and counts carryover',()=>{
 const r=calculatePaycheck(setup());
 assert.equal(r.status,'calculated');
 assert.equal(r.rows.find(c=>c.category_id==='food').change_milliunits,175000);
 assert.equal(r.rows.find(c=>c.category_id==='pet').change_milliunits,100000);
 assert.equal(r.rows.find(c=>c.category_id==='therapy').change_milliunits,20000);
 assert.equal(r.rows.find(c=>c.category_id==='buffer').change_milliunits,60000);
 assert.equal(r.assigned_milliunits+r.remaining_milliunits,1000000);
});
test('new weekly refill Essentials are discovered without a per-category formula',()=>{
 const f=setup();f.snapshot.categories.push(category('new-essential',5000,{goal_cadence:2,goal_target:45000}));
 const r=calculatePaycheck(f);assert.equal(r.rows.find(c=>c.category_id==='new-essential').change_milliunits,85000);
 assert.ok(r.stages.findIndex(s=>s.category_id==='buffer')>r.stages.findIndex(s=>s.category_id==='new-essential'));
});
test('monthly set-aside uses remaining funding even with a large accumulated balance',()=>{
 const f=setup();f.snapshot.categories[1]={...f.snapshot.categories[1],balance:500000,goal_needs_whole_amount:true,goal_under_funded:125000};
 assert.equal(calculatePaycheck(f).rows.find(c=>c.category_id==='pet').change_milliunits,125000);
});
test('buffer priority is after all essentials and before optional goals',()=>{
 const f=setup();f.snapshot.ready_to_assign=320000;f.snapshot.categories.push(category('trip',0,{category_group_id:'goals',goal_type:'TBD',goal_target:1000000}));
 const r=calculatePaycheck({...f,remaining_choices:[{category_id:'trip',amount_milliunits:100000}]});
 assert.equal(r.rows.find(c=>c.category_id==='buffer').change_milliunits,25000);
 assert.ok(!r.rows.some(c=>c.category_id==='trip'));
 assert.ok(r.unmet.some(x=>x.category_id==='buffer'));
});
test('excess buffer is left available and never withdrawn automatically',()=>{
 const f=setup();f.snapshot.categories[3].balance=150000;
 assert.ok(!calculatePaycheck(f).rows.some(c=>c.category_id==='buffer'));
});
test('catch-up does not reset weekly allowances; reviewed remaining needs are required',()=>{
 const f=setup();assert.equal(calculatePaycheck({...f,mode:'catch_up'}).assignments.length,0);
 const r=calculatePaycheck({...f,mode:'catch_up',catch_up_topups:[{category_id:'food',available_goal_milliunits:50000},{category_id:'buffer',available_goal_milliunits:40000}]});
 assert.equal(r.rows.find(c=>c.category_id==='food').change_milliunits,25000);
 assert.ok(!r.rows.some(c=>c.category_id==='buffer'));
});
test('cross-month target coverage is reviewed rather than invented from current month underfunding',()=>{
 const f=setup();f.snapshot.as_of='2026-10-26';f.payday='2026-10-23';f.next_payday='2026-11-06';
 const unresolved=calculatePaycheck(f);assert.ok(unresolved.questions.some(q=>q.code==='cross_month_target_coverage'));assert.deepEqual(unresolved.assignments,[]);
 const r=calculatePaycheck({...f,catch_up_topups:[{category_id:'pet',available_goal_milliunits:150000},{category_id:'therapy',available_goal_milliunits:100000}]});
 assert.equal(r.status,'calculated');assert.equal(r.rows.find(c=>c.category_id==='pet').change_milliunits,125000);
});
test('overspending coverage is subtracted from current target funding exactly once',()=>{
 const f=setup();f.snapshot.categories[1].balance=-30000;f.snapshot.categories[1].goal_under_funded=125000;
 assert.equal(calculatePaycheck(f).rows.find(c=>c.category_id==='pet').change_milliunits,125000);
});
test('missing mode, snoozed essential, wrong buffer mode and negative coverage block',()=>{
 for(const change of [{goal_needs_whole_amount:null},{goal_snoozed_at:'2026-10-01'}]){
 const f=setup();Object.assign(f.snapshot.categories[1],change);assert.deepEqual(calculatePaycheck(f).assignments,[]);}
 const f=setup();f.snapshot.categories[3].goal_needs_whole_amount=true;assert.ok(calculatePaycheck(f).questions.some(q=>q.code==='buffer_target_mismatch'));
 assert.throws(()=>calculatePaycheck({...setup(),catch_up_topups:[{category_id:'food',available_goal_milliunits:-1}]}),/Negative/);
});
test('native one-time and balance caps avoid duplicate household dollar caps',()=>{
 const f=setup();f.snapshot.categories.push(category('trip',20000,{category_group_id:'goals',goal_cadence:0,goal_target:3000000,goal_overall_left:50000}));
 const r=calculatePaycheck({...f,remaining_choices:[{category_id:'trip',amount_milliunits:100000}]});
 assert.equal(r.rows.find(c=>c.category_id==='trip').change_milliunits,50000);
});
test('excluded groups cannot become target-driven Essentials',()=>{
 const f=setup();f.policy.excluded_group_ids=['essentials'];assert.throws(()=>calculatePaycheck(f),/[Ee]xcluded/);
});
test('Impacts continues protecting dynamically discovered Essentials and buffer',()=>{
 const {snapshot,settings,input}=fixture();settings.allocation_policy.target_driven_essentials={group_ids:[snapshot.categories.find(c=>c.id===ids.food).category_group_id],priority_category_ids:[],weekly_refill_periods:2,buffer_category_id:ids.fun};
 settings.allocation_policy.weekly_topups=[];settings.allocation_policy.monthly_targets=[];input.remaining_needs=[];
 const r=calculateImpacts({snapshot,settings,input});assert.ok(r.baseline.questions.some(q=>q.category_id===ids.food&&q.code==='remaining_obligation_unknown'));assert.ok(r.baseline.questions.some(q=>q.category_id===ids.fun));
});
test('Impacts one-time funding progress is consumed by purchase rather than refilled',()=>{
 const {snapshot,settings,input}=fixture();const c=snapshot.categories.find(c=>c.id===ids.travel);
 Object.assign(c,{goal_type:'NEED',goal_cadence:0,goal_target:1000000,goal_overall_left:100000,goal_overall_funded:900000,goal_needs_whole_amount:false});
 input.goals[0].required_balance=1000;input.scenarios=[{id:'purchase',label:'Planned travel purchase',moves:[],purchase:{category_id:ids.travel,account_id:ids.bank,amount:100,date:'2026-10-30',counts_toward_remaining_need:false}}];
 const r=calculateImpacts({snapshot,settings,input});
 assert.equal(r.baseline.forecast.goals[0].basis,'target_progress');
 assert.equal(r.baseline.forecast.goals[0].current_scenario_gap_milliunits,100000);
 assert.equal(r.options[0].goal_effects[0].additional_future_need_milliunits,0);
 input.goals[0].basis='available_balance';
 const b=calculateImpacts({snapshot,settings,input});assert.equal(b.options[0].goal_effects[0].additional_future_need_milliunits,100000);
});
test('Impacts refuses unknown one-time progress or mismatched native goal amount',()=>{
 const {snapshot,settings,input}=fixture();Object.assign(snapshot.categories.find(c=>c.id===ids.travel),{goal_type:'NEED',goal_cadence:0,goal_target:1000000});
 assert.throws(()=>calculateImpacts({snapshot,settings,input}),/progress unavailable/);
 input.goals[0].required_balance=2000;assert.throws(()=>calculateImpacts({snapshot,settings,input}),/match live/);
});
test('full target reader has read-only metadata, coherent scope, full recurrence and no writes',async()=>{
 let handler,meta;const f=setup();f.snapshot.categories[1].goal_cadence_frequency=3;
 registerTargetDetails({registerTool:(name,m,h)=>{assert.equal(name,'get_target_details');meta=m;handler=h;}},{subject:'member',budgetId:'test',loader:{load:async()=>({settings:{budget:{id:'test'}},revision:'rules-revision'})},snapshotReader:async()=>f.snapshot});
 assert.equal(meta.annotations.readOnlyHint,true);assert.equal(meta.annotations.destructiveHint,false);
 const r=await handler({});assert.equal(r.structuredContent.categories.find(c=>c.category_id==='pet').target.every,3);
 assert.equal(r.structuredContent.household_revision,'rules-revision');
});
test('target reader rejects another budget and unauthenticated caller',async()=>{
 let handler;registerTargetDetails({registerTool:(_n,_m,h)=>handler=h},{subject:null,budgetId:'test',loader:{load:()=>{throw Error('must not read');}}});
 assert.equal((await handler({})).isError,true);
 registerTargetDetails({registerTool:(_n,_m,h)=>handler=h},{subject:'member',budgetId:'test',loader:{load:async()=>({settings:{budget:{id:'other'}}})}});
 assert.match((await handler({})).content[0].text,/mismatch/);
});

import {fixture as sustainabilityFixture,ids as sustainabilityIds} from './sustainability-fixture.mjs';
test('Sustainability uses full quarterly frequency and reports refill capacity separately from current funding',()=>{
 const f=sustainabilityFixture(),c=f.snapshot.categories.find(c=>c.id===sustainabilityIds.quarter);
 Object.assign(c,{goal_cadence:1,goal_cadence_frequency:3,goal_needs_whole_amount:false});
 const r=f.run();
 const q=r.ongoing.categories.find(c=>c.category_id===sustainabilityIds.quarter);
 assert.equal(q.monthly_average_milliunits,100000);assert.equal(q.repeat_every,3);assert.equal(q.target_behavior,'refill');assert.equal(q.refill_average_is_spending_capacity,true);
 assert.equal(r.current_funding.categories.find(c=>c.category_id===sustainabilityIds.quarter).current_ynab_underfunded_milliunits,0);
});
test('Sustainability one-time spending progress is not a second unspent balance goal',()=>{
 const f=sustainabilityFixture(),c=f.snapshot.categories.find(c=>c.id===sustainabilityIds.goal);
 Object.assign(c,{goal_type:'NEED',goal_cadence:0,goal_target:3000000,goal_overall_funded:2900000,goal_overall_left:100000,goal_needs_whole_amount:false});
 const row=f.run().current_funding.one_time_goals.find(c=>c.category_id===sustainabilityIds.goal);
 assert.equal(row.remaining_funding_gap_milliunits,100000);assert.equal(row.required_balance_milliunits,null);assert.equal(row.remaining_balance_gap_milliunits,null);
});

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {generateKeyPair,SignJWT,exportJWK,createLocalJWKSet} from 'jose';
import {createApp} from './server.mjs';
test('authenticated HTTP target details are discovered and scoped without real credentials or state writes',async()=>{
 const budgetId='11111111-1111-4111-8111-111111111111',issuer='https://identity.example/',resource='https://budget.example/mcp',subject='member';
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='targets-test';
 const token=await new SignJWT({iss:issuer,aud:resource,sub:subject,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(privateKey);
 const f=setup();f.snapshot.budget_id=budgetId;
 const app=createApp({accessToken:'fake-never-used',budgetId,authMode:'oauth',authConfig:{issuer,resource,allowedSubjects:subject,keySet:createLocalJWKSet({keys:[jwk]})},householdLoader:{load:async()=>({settings:{budget:{id:budgetId}},revision:'synthetic'})},snapshotReader:async()=>f.snapshot,diagnosticLogger:()=>{}});
 await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+app.address().port,client=new Client({name:'targets-test',version:'1'});
 try{
  assert.equal((await fetch(base+'/mcp')).status,401);
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const tools=await client.listTools();assert.equal(tools.tools.find(t=>t.name==='get_target_details').annotations.readOnlyHint,true);
  const result=await client.callTool({name:'get_target_details',arguments:{}});assert.equal(result.structuredContent.budget_id,budgetId);assert.equal(result.structuredContent.categories.length,4);
  await assert.rejects(client.callTool({name:'get_target_details',arguments:{budget_id:'22222222-2222-4222-8222-222222222222'}}),/only permits/);
 }finally{await client.close();app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}
});

test('weekly set-aside requires reviewed cycle contributions rather than whole-month net Assigned',()=>{
 const f=setup();f.weekly_contributions=[];f.snapshot.categories[2].budgeted=100000;
 assert.ok(calculatePaycheck(f).questions.some(q=>q.code==='cycle_contribution_review'));
 f.weekly_contributions=[{category_id:'therapy',already_contributed_milliunits:30000}];
 assert.ok(!calculatePaycheck(f).rows.some(c=>c.category_id==='therapy'));
});
test('card reserves require gap discussion, cap at debt, and skip fully covered cards',()=>{
 const f=setup();f.policy.card_reserve_mode='debt_capped_reviewed';f.policy.card_category_ids=['card'];
 f.policy.card_floors=[{category_id:'card',account_id:'credit',floor_milliunits:50000}];
 f.snapshot.accounts=[{id:'credit',type:'creditCard',on_budget:true,balance:-20000}];
 f.snapshot.categories.push(category('card',0,{category_group_id:'cards'}));
 let r=calculatePaycheck(f);assert.equal(r.assignments.length,0);assert.ok(r.questions.some(q=>q.code==='card_gap_discussion'));
 r=calculatePaycheck({...f,card_gap_reviews:['card']});assert.equal(r.rows.find(c=>c.category_id==='card').change_milliunits,20000);
 f.snapshot.categories.at(-1).balance=20000;r=calculatePaycheck(f);assert.ok(!r.rows.some(c=>c.category_id==='card'));assert.ok(!r.questions.some(q=>q.code==='card_gap_discussion'));
 f.snapshot.categories.at(-1).balance=0;f.snapshot.accounts[0].balance=0;assert.ok(!calculatePaycheck(f).rows.some(c=>c.category_id==='card'));
});
test('large card gap is disclosed without silently closing it or adding a second reserve',()=>{
 const f=setup();f.policy.card_reserve_mode='debt_capped_reviewed';f.policy.card_category_ids=['card'];f.policy.card_floors=[{category_id:'card',account_id:'credit',floor_milliunits:50000}];f.snapshot.accounts=[{id:'credit',type:'creditCard',on_budget:true,balance:-2000000}];f.snapshot.categories.push(category('card',10000,{category_group_id:'cards'}));
 const r=calculatePaycheck({...f,card_gap_reviews:['card']});assert.equal(r.rows.find(c=>c.category_id==='card').change_milliunits,40000);assert.equal(r.card_reserves[0].gap_milliunits,1990000);
});
test('missing card debt mapping blocks and higher reviewed floors still cap at actual debt',()=>{
 const f=setup();f.policy.card_reserve_mode='debt_capped_reviewed';f.policy.card_category_ids=['card'];f.policy.card_floors=[{category_id:'card',account_id:'credit',floor_milliunits:50000}];f.snapshot.categories.push(category('card',0,{category_group_id:'cards'}));
 assert.ok(calculatePaycheck(f).questions.some(q=>q.code==='card_debt_unknown'));
 f.snapshot.accounts=[{id:'credit',type:'creditCard',on_budget:true,balance:-60000}];
 const r=calculatePaycheck({...f,card_gap_reviews:['card'],floor_overrides:[{category_id:'card',floor_milliunits:100000}]});assert.equal(r.rows.find(c=>c.category_id==='card').change_milliunits,60000);
});
test('weekly target outside Essentials uses the same payday window when selected after buffer',()=>{
 const f=setup();f.snapshot.categories.push(category('travel-weekly',10000,{category_group_id:'goals',goal_cadence:2,goal_target:30000}));
 let r=calculatePaycheck({...f,remaining_choices:[{category_id:'travel-weekly',amount_milliunits:100000}]});
 assert.equal(r.rows.find(c=>c.category_id==='travel-weekly').change_milliunits,50000);
 assert.ok(r.stages.findIndex(s=>s.category_id==='travel-weekly')>r.stages.findIndex(s=>s.category_id==='buffer'));
 f.snapshot.categories.at(-1).goal_needs_whole_amount=true;
 r=calculatePaycheck({...f,weekly_contributions:[...f.weekly_contributions,{category_id:'travel-weekly',already_contributed_milliunits:10000}],remaining_choices:[{category_id:'travel-weekly',amount_milliunits:100000}]});assert.equal(r.rows.find(c=>c.category_id==='travel-weekly').change_milliunits,50000);
});

test('missing weekly target amounts cannot silently produce zero required funding',()=>{for(const index of [0,2]){const f=setup();f.snapshot.categories[index].goal_target=null;const r=calculatePaycheck(f);assert.ok(r.questions.some(q=>q.code==='target_amount_unknown'));assert.deepEqual(r.assignments,[]);}});
