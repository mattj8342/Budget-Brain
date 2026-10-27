import test from 'node:test';
import assert from 'node:assert/strict';
import {calculatePaycheck,milliunits} from './allocation.mjs';
export const cat=(id,balance=0,other={})=>({id,name:id,category_group_id:'general',budgeted:0,balance,goal_target:100000,goal_cadence:2,goal_cadence_frequency:1,...other});
export const policy=()=>({schema_version:1,excluded_group_ids:['work','internal'],excluded_category_ids:['excluded'],card_category_ids:['card'],monthly_bill_group_ids:['monthly'],annual_bill_group_ids:['annual'],weekly_topups:[{category_id:'food',weeks:2}],monthly_targets:[{category_id:'supplies'}],card_floors:[{category_id:'card',floor_milliunits:50000}],optional_goal_caps:[]});
export const snapshot=()=>({budget_id:'test',month:'2026-10-01',as_of:'2026-10-24',captured_at:'2026-10-24T12:00:00Z',server_knowledge:1,ready_to_assign:1000000,categories:[cat('food',25000),cat('supplies',50000,{goal_under_funded:20000}),cat('card',10000)],obligations:[],credit_spending_category_ids:[]});
export const run=(overrides={})=>calculatePaycheck({snapshot:snapshot(),policy:policy(),payday:'2026-10-23',next_payday:'2026-11-06',...overrides});
test('carryover, literal card floor and monthly suggestions use only required additions',()=>{
 const r=run();assert.equal(r.status,'calculated');assert.equal(r.rows.find(x=>x.category_id==='food').change_milliunits,175000);assert.equal(r.rows.find(x=>x.category_id==='card').change_milliunits,40000);
 assert.equal(r.assigned_milliunits,235000);assert.equal(r.remaining_milliunits,765000);assert.equal(r.assignments.find(x=>x.category_id==='food').budgeted,175);
});
test('leave excess Available and preserve signed Assigned values',()=>{
 const s=snapshot();s.categories[0].balance=300000;s.categories[1].budgeted=-5000;
 const r=run({snapshot:s});assert.ok(!r.rows.some(x=>x.category_id==='food'));assert.equal(r.rows.find(x=>x.category_id==='supplies').assigned_after_milliunits,15000);
});
test('overspending followed by weekly and monthly funding counts earlier additions once',()=>{
 const s=snapshot();s.categories[0].balance=-50000;s.categories[1].balance=-30000;s.categories[1].goal_under_funded=40000;
 const r=run({snapshot:s});assert.equal(r.rows.find(x=>x.category_id==='food').change_milliunits,250000);assert.equal(r.rows.find(x=>x.category_id==='supplies').change_milliunits,40000);
});
test('work and excluded card balances never receive automatic coverage',()=>{
 const s=snapshot();s.categories.push(cat('work-expense',-90000,{category_group_id:'work'}),cat('excluded',-50000));
 assert.ok(!run({snapshot:s}).rows.some(r=>['work-expense','excluded'].includes(r.category_id)));
});
test('covering credit spending blocks executable assignments rather than guessing reserve effects',()=>{
 const s=snapshot();s.categories[0].balance=-50000;s.credit_spending_category_ids=['food'];const r=run({snapshot:s});
 assert.equal(r.status,'needs_clarification');assert.deepEqual(r.assignments,[]);assert.ok(r.questions.some(q=>q.code==='automatic_card_effect'));
});
test('monthly then annual bills precede card floors and weekly needs even across month end',()=>{
 const s=snapshot();s.ready_to_assign=250000;s.categories.push(cat('rent',100000,{category_group_id:'monthly'}),cat('annual',0,{category_group_id:'annual'}));
 s.obligations=[{category_id:'rent',amount_milliunits:300000,due_date:'2026-11-01'},{category_id:'annual',amount_milliunits:100000,due_date:'2026-10-25'}];
 const r=run({snapshot:s});assert.equal(r.rows.find(x=>x.category_id==='rent').change_milliunits,200000);assert.equal(r.rows.find(x=>x.category_id==='annual').change_milliunits,50000);assert.ok(!r.rows.some(x=>x.category_id==='food'));
 assert.equal(r.remaining_milliunits,0);assert.equal(r.status,'calculated');assert.ok(r.unmet.length>0);
});
test('unknown and overdue bill payment status requires evidence; confirmed paid bypasses',()=>{
 const s=snapshot();s.categories.push(cat('bill',0,{category_group_id:'monthly',goal_target_date:'2026-10-20'}));
 assert.equal(run({snapshot:s}).status,'needs_clarification');
 assert.equal(run({snapshot:s,bill_resolutions:[{category_id:'bill',status:'paid_or_none_due'}]}).status,'calculated');
 const r=run({snapshot:s,bill_resolutions:[{category_id:'bill',status:'unpaid',amount_milliunits:150000,due_date:'2026-10-20'}]});
 assert.equal(r.rows.find(x=>x.category_id==='bill').change_milliunits,150000);
});
test('equal-date shortage and multiple negative shortage have no silent executable tie-break',()=>{
 const s=snapshot();s.ready_to_assign=10000;s.categories.push(cat('a',0,{category_group_id:'monthly'}),cat('b',0,{category_group_id:'monthly'}));s.obligations=['a','b'].map(category_id=>({category_id,due_date:'2026-10-25',amount_milliunits:20000}));
 assert.ok(run({snapshot:s}).questions.some(q=>q.code==='bill_shortage_tie'));
 s.categories[0].balance=-10000;s.categories[1].balance=-10000;assert.ok(run({snapshot:s}).questions.some(q=>q.code==='overspending_shortage_order'));
});
test('catch-up requires remaining needs and never refreshes a full allowance by default',()=>{
 assert.equal(run({mode:'catch_up'}).status,'needs_clarification');
 const r=run({mode:'catch_up',catch_up_topups:[{category_id:'food',available_goal_milliunits:40000}]});
 assert.equal(r.rows.find(x=>x.category_id==='food').change_milliunits,15000);
});
test('invalid cadence, missing mapping, duplicate inputs, dates and fractional milliunits fail clearly',()=>{
 const s=snapshot();s.categories[0].goal_cadence=1;assert.equal(run({snapshot:s}).status,'needs_clarification');
 assert.throws(()=>run({payday:'2026-02-30'}));
 assert.throws(()=>run({next_payday:'2026-10-24'}));
 assert.throws(()=>run({policy:{...policy(),weekly_topups:[{category_id:'missing',weeks:2}]}}),/mapping/);
 assert.throws(()=>run({bill_resolutions:[{category_id:'food',status:'paid_or_none_due'}]}),/outside/);
 assert.throws(()=>milliunits(.0001));assert.equal(milliunits(10.23),10230);
});
test('optional contributions preserve hierarchy, caps and require explicit eligible choices',()=>{
 const p=policy();p.optional_goal_caps=[{category_id:'travel',cap_milliunits:100000}];const s=snapshot();s.categories.push(cat('travel',80000));
 const r=run({snapshot:s,policy:p,remaining_choices:[{category_id:'travel',amount_milliunits:60000}]});assert.equal(r.rows.find(x=>x.category_id==='travel').change_milliunits,20000);
 assert.throws(()=>run({remaining_choices:[{category_id:'card',amount_milliunits:1000}]}),/work-expense/);
 assert.throws(()=>run({remaining_choices:[{category_id:'food',amount_milliunits:1000}]}),/refill/);
});
test('negative RTA does not fund any category',()=>{
 const s=snapshot();s.ready_to_assign=-1000;const r=run({snapshot:s});assert.equal(r.assigned_milliunits,0);assert.equal(r.status,'needs_clarification');
});
test('conservation and nonnegative contributions across 500 deterministic shortage/carryover scenarios',()=>{
 let seed=10;const random=()=>{seed=(seed*16807)%2147483647;return seed;};
 for(let i=0;i<500;i++){const s=snapshot();s.ready_to_assign=random()%1000000;s.categories[0].balance=random()%400000-50000;
 const r=run({snapshot:s});assert.equal(r.assigned_milliunits+r.remaining_milliunits,s.ready_to_assign);assert.ok(r.remaining_milliunits>=0);assert.ok(r.rows.every(x=>x.change_milliunits>=0&&Number.isSafeInteger(x.assigned_after_milliunits)));}
});
