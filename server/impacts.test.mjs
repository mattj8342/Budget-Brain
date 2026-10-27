import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateImpacts} from './impacts.mjs';
import {ids,fixture} from './impact-fixture.mjs';

test('same baseline is immutable; reallocation conserves money and quantifies constrained next-payday/deadline effects',()=>{
 const f=fixture(),before=structuredClone(f.snapshot),result=f.run(),option=result.options[0];
 assert.deepEqual(f.snapshot,before);assert.equal(option.execution_eligible,true);
 assert.equal(option.rows.reduce((n,r)=>n+r.change_milliunits,0),0);
 assert.equal(option.goal_effects[0].additional_future_need_milliunits,100000);
 assert.equal(option.goal_effects[0].additional_even_spread_per_payday_milliunits,50000);
 assert.equal(option.goal_effects[0].baseline_shortfall_at_deadline_milliunits,100000);
 assert.equal(option.goal_effects[0].shortfall_at_deadline_milliunits,200000);
 assert.equal(option.next_payday_goal_contribution_delta_milliunits,0);
});
test('protected bills and remaining essentials cannot be discretionary funding sources',()=>{
 for(const source of [ids.rent,ids.food]){
  const f=fixture();f.input.scenarios[0].moves=[{from_category_id:source,to_category_id:ids.fun,amount:200}];
  const option=f.run().options[0];assert.equal(option.execution_eligible,false);assert.ok(option.blockers.some(b=>b.code==='protected_source_or_overspend'));assert.equal(option.assignments.length,0);
 }
});
test('unknown remaining needs and incomplete schedules stop RTA being described as spare',()=>{
 const f=fixture();f.input.remaining_needs=[];f.input.scenarios[0].moves=[{from_category_id:'ready_to_assign',to_category_id:ids.fun,amount:100}];
 assert.ok(f.run().options[0].blockers.some(b=>b.code==='rta_obligations_unresolved'));
 f.input.remaining_needs=[{category_id:ids.food,amount:100}];f.snapshot.issues=['Unknown frequency'];
 assert.equal(f.run().options[0].execution_eligible,false);
});
test('future pay never funds executable current assignments',()=>{
 const f=fixture();f.snapshot.ready_to_assign=0;f.input.scenarios[0].moves=[{from_category_id:'ready_to_assign',to_category_id:ids.fun,amount:100}];
 const option=f.run().options[0];assert.ok(option.blockers.some(b=>b.code==='insufficient_received_rta'));assert.equal(option.execution_eligible,false);
});
test('hypothetical cash purchase differs from funding execution and pending-account cash is counted once',()=>{
 const f=fixture();f.input.scenarios[0].purchase={category_id:ids.fun,account_id:ids.bank,date:'2026-10-27',amount:100,counts_toward_remaining_need:false};
 const o=f.run().options[0];assert.equal(o.rows.find(r=>r.category_id===ids.fun).funding_available_after_milliunits,1100000);assert.equal(o.purchase.category_available_after_spend_milliunits,1000000);
 assert.equal(o.account_impact.cash_outflow_now_milliunits,100000);assert.equal(o.account_impact.new_debt_milliunits,0);
 assert.equal(o.cash.find(a=>a.account_id===ids.bank).minimum_projected_milliunits,2900000);
});
test('credit purchase and positive card balance produce separate debt/reserve effects without bank payment',()=>{
 const f=fixture();f.input.scenarios[0].purchase={category_id:ids.fun,account_id:ids.credit,date:'2026-10-27',amount:50,counts_toward_remaining_need:false};
 let o=f.run().options[0];assert.equal(o.account_impact.new_debt_milliunits,50000);assert.equal(o.account_impact.automatic_card_reserve_increase_milliunits,50000);assert.equal(o.account_impact.cash_outflow_now_milliunits,0);
 f.snapshot.accounts.find(a=>a.id===ids.credit).balance=100000;
 o=f.run().options[0];assert.equal(o.account_impact.new_debt_milliunits,0);assert.equal(o.account_impact.automatic_card_reserve_increase_milliunits,0);
});
test('excluded work/card sources, caps and credit overspending correction remain blocked',()=>{
 for(const source of [ids.work,ids.card]){const f=fixture();f.input.scenarios[0].moves=[{from_category_id:source,to_category_id:ids.fun,amount:1}];assert.equal(f.run().options[0].execution_eligible,false);}
 const f=fixture();f.settings.allocation_policy.optional_goal_caps=[{category_id:ids.fun,cap_milliunits:1050000}];
 assert.ok(f.run().options[0].blockers.some(b=>b.code==='configured_goal_cap'));
 f.settings.allocation_policy.optional_goal_caps=[];f.snapshot.categories.find(c=>c.id===ids.fun).balance=-10000;f.snapshot.credit_spending_category_ids=[ids.fun];
 assert.ok(f.run().options[0].blockers.some(b=>b.code==='automatic_card_correction_unsupported'));
});
test('goal funding is jointly constrained and unconfirmed goal order or commitments allocate nothing',()=>{
 const f=fixture();f.input.goals.push({category_id:ids.fun,due_date:'2026-11-21',required_balance:1200,include_payday_on_deadline:false});
 let r=f.run();assert.equal(r.baseline.forecast.paychecks.flatMap(p=>p.goal_contributions).length,0);
 f.input.goal_order_confirmed=true;r=f.run();
 assert.ok(r.baseline.forecast.paychecks.reduce((n,p)=>n+p.goal_contributions.reduce((v,g)=>v+g.amount_milliunits,0),0)<=400000);
 f.input.paychecks.forEach(p=>p.commitments_confirmed=false);assert.equal(f.run().baseline.forecast.paychecks.flatMap(p=>p.goal_contributions).length,0);
});
test('deadline-day payroll is excluded unless timing is explicitly confirmed; month boundaries preserve carryover',()=>{
 const f=fixture();f.input.goals[0].due_date='2026-11-06';f.input.paychecks=f.input.paychecks.slice(0,1);
 let g=f.run().baseline.forecast.goals[0];assert.equal(g.shortfall_at_deadline_milliunits,500000);
 f.input.goals[0].include_payday_on_deadline=true;g=f.run().baseline.forecast.goals[0];assert.equal(g.shortfall_at_deadline_milliunits,300000);
 assert.equal(f.run().options[0].rows.find(r=>r.category_id===ids.travel).available_before_milliunits,500000);
});
test('remaining-needs coverage distinguishes an extra purchase from already planned spending',()=>{
 const f=fixture();f.input.scenarios=[{id:'food',label:'Groceries',moves:[],purchase:{category_id:ids.food,account_id:ids.bank,date:'2026-10-27',amount:150,counts_toward_remaining_need:false}}];
 assert.ok(f.run().options[0].blockers.some(b=>b.code==='purchase_reduces_protected_coverage'));
 f.input.scenarios[0].purchase.counts_toward_remaining_need=true;assert.equal(f.run().options[0].blockers.length,0);assert.equal(f.run().options[0].execution_eligible,false);
});
test('invalid dates, missing category IDs and duplicate goal definitions fail rather than inventing data',()=>{
 for(const mutate of [f=>f.input.next_payday='2026-02-30',f=>f.input.scenarios[0].moves[0].from_category_id='missing',f=>f.input.goals.push({...f.input.goals[0]}),f=>f.input.horizon_end='2028-01-01']){
  const f=fixture();mutate(f);assert.throws(()=>f.run());
 }
});
test('integer conservation across 500 deterministic reallocations and independent alternatives',()=>{
 let seed=11;
 for(let i=0;i<500;i++){
  seed=(1664525*seed+1013904223)>>>0;const amount=(seed%499000+1)/1000;
  const f=fixture();f.input.scenarios=[{id:'a',label:'A',moves:[{from_category_id:ids.fun,to_category_id:ids.travel,amount}]},{id:'b',label:'B',moves:[{from_category_id:ids.travel,to_category_id:ids.fun,amount}]}];
  const result=f.run();
  for(const o of result.options){assert.equal(o.rows.reduce((n,r)=>n+r.change_milliunits,0),0);assert.ok(o.rows.every(r=>Number.isSafeInteger(r.assigned_after_milliunits)));assert.equal(o.ready_to_assign_after_funding_milliunits,100000);}
 }
});

test('preassigned future-month goal money is flagged for reconciliation instead of double-funded',()=>{
 const f=fixture();f.snapshot.future_assigned_categories=[{month:'2026-11-01',category_id:ids.travel,assigned_milliunits:100000}];
 const r=f.run();assert.equal(r.baseline.forecast.preassigned_future_goal_funding_unresolved,true);assert.equal(r.options[0].execution_eligible,false);
});
test('registered pending charges are not silently counted again as new cash events or purchases',()=>{
 const f=fixture();f.snapshot.transactions=[{id:'pending',account_id:ids.bank,date:'2026-10-26',amount:-100000,cleared:'uncleared'}];
 f.input.cash_events=[{account_id:ids.bank,date:'2026-10-26',amount:-100}];assert.throws(()=>f.run(),/already be included/);
 f.input.cash_events=[];
 f.input.scenarios[0].purchase={category_id:ids.fun,account_id:ids.bank,date:'2026-10-26',amount:100,counts_toward_remaining_need:false};
 assert.ok(f.run().options[0].blockers.some(b=>b.code==='purchase_may_already_be_in_snapshot'));
 f.input.scenarios[0].purchase.distinct_from_recorded_confirmed=true;
 assert.equal(f.run().options[0].execution_eligible,true);
});
