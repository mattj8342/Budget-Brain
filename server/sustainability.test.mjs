import test from 'node:test';
import assert from 'node:assert/strict';
import {monthlyRate} from './sustainability.mjs';
import {fixture,ids,id} from './sustainability-fixture.mjs';
import {createSustainabilityService,sustainabilitySchema} from './sustainability-service.mjs';
import {snapshotFromBudget} from './paycheck.mjs';
test('weekly, biweekly, quarterly and annual rates use exact rounded integer math',()=>{
 assert.equal(monthlyRate(100000,'weekly'),433333);assert.equal(monthlyRate(1000000,'biweekly'),2166667);
 assert.equal(monthlyRate(300000,'quarterly'),100000);assert.equal(monthlyRate(1200000,'annual'),100000);
 assert.equal(monthlyRate(6000,'monthly',3),2000);assert.equal(monthlyRate(6,'annual'),1);assert.equal(monthlyRate(1,'weekly'),4);
 assert.throws(()=>monthlyRate(-1,'monthly'));assert.throws(()=>monthlyRate(1,'other'));assert.throws(()=>monthlyRate(1,'monthly',0));
});
test('separate recurring commitments, current funding, goal gaps and measured spending without mutation',()=>{
 const f=fixture(),before=JSON.stringify(f),r=f.run();
 assert.equal(r.ongoing.recurring_commitments_monthly_average_milliunits,1833333);
 assert.equal(r.ongoing.reliable_net_income_monthly_average_milliunits,2166667);
 assert.equal(r.ongoing.reliable_income_margin_milliunits,333334);
 assert.equal(r.actual_spending.monthly_net_outflow_average_milliunits,1500000);
 assert.equal(r.current_funding.ynab_current_target_underfunding_milliunits,50000);
 assert.equal(r.current_funding.one_time_goals[0].remaining_balance_gap_milliunits,50000);
 assert.equal(r.current_funding.combined_pressure_total,null);assert.equal(r.status,'supported_under_reviewed_assumptions');
 assert.equal(JSON.stringify(f),before);
});
test('dated income counts actual paydays rather than the calendar-average deposit amount',()=>{
 const f=fixture(),r=f.run(),nov=r.timing.calendar_income.find(m=>m.month==='2026-11-01');
 assert.equal(nov.forecast_reliable_income_milliunits,2000000);assert.equal(nov.deposit_count,2);
 assert.notEqual(nov.forecast_reliable_income_milliunits,r.ongoing.reliable_net_income_monthly_average_milliunits);
 f.input.income_streams[0].next_date='2026-10-30';assert.equal(f.run().timing.calendar_income[0].deposit_count,1);
});
test('semimonthly payroll and month-end anchors handle February and leap years without drift',()=>{
 const f=fixture();f.snapshot.as_of='2028-01-01';f.snapshot.month='2028-01-01';f.input.horizon_end='2028-03-31';
 Object.assign(f.input.income_streams[0],{cadence:'semimonthly',next_date:'2028-01-15',paydays:[15,31]});
 let dates=f.run().timing.calendar_income.flatMap(m=>m.events.map(e=>e.date));assert.deepEqual(dates,['2028-01-15','2028-01-31','2028-02-15','2028-02-29','2028-03-15','2028-03-31']);
 Object.assign(f.input.income_streams[0],{cadence:'monthly',next_date:'2028-01-31'});dates=f.run().timing.calendar_income.flatMap(m=>m.events.map(e=>e.date));assert.deepEqual(dates,['2028-01-31','2028-02-29','2028-03-31']);
 f.input.income_streams[0].cadence='semimonthly';f.input.income_streams[0].next_date='2028-01-16';assert.throws(()=>f.run(),/reviewed paydays/);
});
test('variable pay and uncertain bonuses do not become reliable recurring income or base cash',()=>{
 const f=fixture();f.input.income_streams[0].certainty='variable';
 f.input.one_time_income=[{id:'bonus',label:'Possible bonus',date:'2026-11-10',amount:5000,certainty:'uncertain',account_id:ids.bank}];
 const r=f.run();assert.equal(r.ongoing.reliable_net_income_monthly_average_milliunits,0);assert.equal(r.status,'recurring_shortfall');
 assert.equal(r.timing.accounts[0].ending_balance_milliunits,5000000);
 assert.equal(r.ongoing.variable_net_income_monthly_average_milliunits,2166667);
});
test('replacement bonuses replace one generated payday and do not add a second regular check',()=>{
 const f=fixture();f.input.income_adjustments=[{stream_id:'pay',date:'2026-11-06',amount:1800,certainty:'reliable',reason:'Replaces regular deposit'}];
 let r=f.run();assert.equal(r.timing.calendar_income.find(m=>m.month==='2026-11-01').forecast_reliable_income_milliunits,2800000);
 assert.equal(r.ongoing.reliable_net_income_monthly_average_milliunits,2166667);
 f.input.income_adjustments[0].date='2026-11-07';assert.throws(()=>f.run(),/actual generated payday/);
});
test('one-time cash is separate from ongoing income and possible duplicates require reconciliation',()=>{
 const f=fixture();f.input.one_time_income=[{id:'bonus',label:'Bonus',date:'2026-11-06',amount:1000,certainty:'reliable',account_id:ids.bank}];
 assert.throws(()=>f.run(),/matches a forecast/);f.input.one_time_income[0].distinct_from_forecast_confirmed=true;
 const r=f.run();assert.equal(r.timing.calendar_income[1].forecast_reliable_income_milliunits,3000000);assert.equal(r.ongoing.reliable_net_income_monthly_average_milliunits,2166667);
});
test('unknown target recurrence cannot become a favorable whole-budget conclusion',()=>{
 const f=fixture();f.snapshot.categories[0].goal_cadence=null;let r=f.run();assert.equal(r.status,'insufficient_evidence');assert.equal(r.ongoing.unresolved_categories[0].category_id,ids.rent);
 f.input.category_reviews=[{category_id:ids.rent,classification:'recurring',amount:1000,cadence:'monthly',every:1,reason:'Confirmed monthly rent'}];r=f.run();assert.equal(r.status,'supported_under_reviewed_assumptions');
});
test('custom target overrides preserve confirmed cadence and do not add scheduled bills again',()=>{
 const f=fixture();f.input.category_reviews=[{category_id:ids.quarter,classification:'recurring',amount:300,cadence:'monthly',every:6,reason:'Confirmed every six months'}];
 f.snapshot.obligations=[{category_id:ids.rent,due_date:'2026-11-01',amount_milliunits:1000000}];
 const r=f.run();assert.equal(r.ongoing.categories.find(c=>c.category_id===ids.quarter).monthly_average_milliunits,50000);
 assert.equal(r.ongoing.categories.filter(c=>c.category_id===ids.rent).length,1);assert.equal(r.timing.accounts[0].events.filter(e=>e.source==='expense').length,0);
});
test('snoozing does not erase ongoing costs and funded balances do not erase recurrence',()=>{
 const f=fixture();f.snapshot.categories[0].goal_snoozed_at='2026-10-01';const r=f.run();
 assert.equal(r.ongoing.categories.find(c=>c.category_id===ids.rent).monthly_average_milliunits,1000000);
 assert.ok(r.warnings.some(w=>w.code==='snoozed_recurring_target'));assert.equal(r.current_funding.categories.find(c=>c.category_id===ids.rent).current_ynab_underfunded_milliunits,0);
});
test('refill/one-time/balance goal distinctions and explicit remaining Available avoid adding carryover twice',()=>{
 const f=fixture();f.input.category_reviews=[{category_id:ids.food,classification:'recurring',amount:100,cadence:'weekly',every:1,reason:'Remaining need reviewed',remaining_available:250}];
 const r=f.run();assert.equal(r.current_funding.reviewed_remaining_need_topups_milliunits,50000);assert.equal(r.current_funding.reviewed_need_category_count,1);
 assert.ok(!r.ongoing.categories.some(c=>c.category_id===ids.goal));assert.equal(r.current_funding.one_time_goals.length,1);
 f.snapshot.categories.find(c=>c.id===ids.food).balance=-50000;assert.equal(f.run().current_funding.reviewed_remaining_need_topups_milliunits,300000);
});
test('historical category activity excludes card/work/internal flows, includes refunds and hidden expenses',()=>{
 const f=fixture();f.snapshot.category_catalog=[...f.snapshot.categories,{id:ids.hidden,name:'Old expense',hidden:true,deleted:true,category_group_id:'household'}];
 f.snapshot.historical_months[0].categories.push({id:ids.hidden,activity:-100000});
 f.snapshot.historical_months[0].categories.find(c=>c.id===ids.food).activity=100000;
 const r=f.run();assert.equal(r.actual_spending.months[0].household_net_outflow_milliunits,1000000);
 assert.equal(r.actual_spending.months[0].excluded_net_outflow_milliunits,200000);
 assert.ok(r.actual_spending.months[0].categories.some(c=>c.hidden_or_deleted));
});
test('missing historical months or category mapping and unreviewed coverage remain insufficient evidence',()=>{
 for(const mutate of [f=>f.snapshot.historical_months.pop(),f=>f.snapshot.historical_months[0].categories.push({id:id(44),activity:-1000}),f=>f.input.spending_window_representative_confirmed=false,f=>f.input.category_coverage_confirmed=false,f=>f.input.income_coverage_confirmed=false,f=>f.input.cash_flow_coverage_confirmed=false]){
  const f=fixture();mutate(f);assert.equal(f.run().status,'insufficient_evidence');
 }
});
test('ordinary spending above reliable income surfaces despite a favorable target budget',()=>{
 const f=fixture();for(const m of f.snapshot.historical_months)m.categories.find(c=>c.id===ids.food).activity=-1800000;
 assert.equal(f.run().status,'actual_spending_shortfall');f.input.spending_window_representative_confirmed=false;assert.equal(f.run().status,'insufficient_evidence');
});
test('existing principal paydown is explicit and does not double count full card payments',()=>{
 const f=fixture();f.input.debt_paydown=[{card_category_id:ids.card,amount:400,cadence:'monthly',every:1,reason:'Existing household principal only'}];
 assert.equal(f.run().ongoing.recurring_commitments_monthly_average_milliunits,2233333);assert.equal(f.run().status,'recurring_shortfall');
 f.input.debt_paydown=[];f.input.debt_coverage_confirmed=false;assert.equal(f.run().status,'insufficient_evidence');
 f.input.debt_paydown=[{card_category_id:ids.rent,amount:10,cadence:'monthly',every:1}];assert.throws(()=>f.run(),/configured card/);
});
test('cash shortage identifies the date/account while incomplete movement coverage stays conditional',()=>{
 const f=fixture();f.snapshot.accounts[0].balance=100000;f.input.cash_events=[{id:'bill',label:'Bill',date:'2026-10-27',account_id:ids.bank,amount:-200,kind:'expense',certainty:'reliable'}];
 let r=f.run();assert.equal(r.status,'timing_shortfall');assert.deepEqual(r.timing.accounts[0].first_shortfall,{date:'2026-10-27',shortfall_milliunits:100000});
 f.input.cash_flow_coverage_confirmed=false;r=f.run();assert.equal(r.timing.coverage_confirmed,false);assert.equal(r.status,'insufficient_evidence');
});
test('same-day cash uses conservative ordering and never converts category funding into bank cash',()=>{
 const f=fixture();f.snapshot.accounts[0].balance=100000;f.input.cash_events=[{id:'pay',label:'Card payment',date:'2026-11-06',account_id:ids.bank,amount:-1100,kind:'debt_payment',certainty:'reliable'}];
 const r=f.run();assert.equal(r.timing.accounts[0].first_shortfall.shortfall_milliunits,1000000);assert.match(r.timing.same_day_order,/Outflows before inflows/);
 assert.equal(r.current_funding.ready_to_assign_milliunits,100000);
});
test('internal cash transfers conserve combined balances and work cash outflow still affects liquidity',()=>{
 const f=fixture();f.input.transfers=[{date:'2026-10-30',from_account_id:ids.bank,to_account_id:ids.savings,amount:400}];const baseline=f.run();
 f.input.cash_events=[{id:'work',label:'Work cash outflow',date:'2026-11-01',account_id:ids.bank,amount:-300,kind:'expense',certainty:'reliable'}];const r=f.run();
 assert.equal(baseline.timing.accounts.reduce((s,a)=>s+a.ending_balance_milliunits,0),10000000);
 assert.equal(r.timing.accounts.reduce((s,a)=>s+a.ending_balance_milliunits,0),9700000);assert.equal(r.ongoing.recurring_commitments_monthly_average_milliunits,1833333);
});
test('registered pending entries and forecast duplication cannot be counted twice',()=>{
 const f=fixture();f.snapshot.transactions=[{account_id:ids.bank,date:'2026-11-06',amount:1000000}];
 assert.equal(f.run().timing.accounts[0].ending_balance_milliunits,8000000);
 f.input.cash_events=[{id:'again',label:'Deposit',date:'2026-11-06',account_id:ids.bank,amount:1000,kind:'other',certainty:'reliable'}];assert.throws(()=>f.run(),/current balances/);
 f.input.cash_events[0].distinct_from_registered_confirmed=true;assert.equal(f.run().timing.accounts[0].ending_balance_milliunits,9000000);
 f.input.transfers=[{date:'2026-11-06',from_account_id:ids.savings,to_account_id:ids.bank,amount:1000}];assert.throws(()=>f.run(),/Transfer may already/);
});
test('input boundaries reject duplicate reviews, invalid dates, wrong accounts and orphaned adjustments',()=>{
 const f=fixture();f.input.category_reviews=[{category_id:ids.rent,classification:'excluded',reason:'x'},{category_id:ids.rent,classification:'excluded',reason:'y'}];assert.throws(()=>f.run(),/Duplicate/);
 assert.throws(()=>sustainabilitySchema.parse({income_streams:[{id:'x',label:'x',amount:1,cadence:'semimonthly',certainty:'reliable'}]}));
 assert.throws(()=>sustainabilitySchema.parse({cash_events:[{id:'x',label:'x',date:'2026-02-31',account_id:ids.bank,amount:1.0001,kind:'other'}]}));
 const g=fixture();g.input.income_streams[0].account_id=ids.card;assert.throws(()=>g.run(),/cash account/);
 g.input.income_streams[0].account_id=ids.bank;g.input.horizon_end='2029-01-01';assert.throws(()=>g.run(),/366 days/);
});
test('future month funding is disclosed without being added to current funds or average income',()=>{
 const f=fixture();f.snapshot.future_assigned_categories=[{month:'2026-11-01',category_id:ids.food,assigned_milliunits:50000}];
 const r=f.run();assert.ok(r.questions.some(q=>q.code==='future_assignments_need_reconciliation'));assert.equal(r.ongoing.reliable_net_income_monthly_average_milliunits,2166667);assert.equal(r.current_funding.ready_to_assign_milliunits,100000);
});
test('read-only service pins budget, loads one coherent snapshot and does not require a writable store',async()=>{
 const f=fixture();let loads=0,reads=0;
 const service=createSustainabilityService({budgetId:ids.budget,loader:{load:async()=>{loads++;return {settings:f.settings,revision:'test'};}},snapshotReader:async()=>{reads++;return structuredClone(f.snapshot);}});
 const r=await service.analyze(f.input,'auth0|test');assert.equal(r.isError,undefined);assert.equal(r.structuredContent.read_only,true);assert.equal(loads,1);assert.equal(reads,1);
 await assert.rejects(service.analyze(f.input,undefined),/Authenticated/);await assert.rejects(service.analyze({...f.input,budget_id:id(88)},'auth0|test'),/Wrong budget/);
 assert.equal(loads,1);assert.equal(reads,1);
});
test('empty service input returns questions without assuming income or complete coverage',async()=>{
 const f=fixture(),service=createSustainabilityService({budgetId:ids.budget,loader:{load:async()=>({settings:f.settings,revision:'test'})},snapshotReader:async()=>f.snapshot});
 const r=(await service.analyze({},'auth0|test')).structuredContent;assert.equal(r.status,'insufficient_evidence');assert.equal(r.horizon_end,'2027-01-24');assert.equal(r.ongoing.coverage_confirmed,false);
});
test('coherent raw snapshot retains historical activity, catalog and exclusions for previous months',()=>{
 const f=fixture(),data={server_knowledge:1,budget:{id:ids.budget,categories:f.snapshot.categories,category_groups:[{id:'household',name:'Household'}],accounts:f.snapshot.accounts,transactions:[],months:[{month:'2026-10-01',to_be_budgeted:100000,categories:f.snapshot.categories},...f.snapshot.historical_months.map(m=>({...m,to_be_budgeted:0}))]}};
 const s=snapshotFromBudget(data,{timezone:'America/Chicago',now:new Date('2026-10-26T16:00:00Z'),next_payday:'2026-12-31'});
 assert.equal(s.historical_months.length,3);assert.equal(s.category_catalog.length,f.snapshot.categories.length);assert.equal(s.historical_months[0].month,'2026-09-01');
});

test('ongoing exclusions do not erase actual historical spending and future income outside the horizon is valid',()=>{
 const f=fixture();f.input.category_reviews=[{category_id:ids.food,classification:'excluded',reason:'Review separately from recurring commitments'}];
 assert.equal(f.run().actual_spending.monthly_net_outflow_average_milliunits,1500000);
 f.input.income_streams[0].next_date='2027-02-01';assert.equal(f.run().timing.accounts[0].ending_balance_milliunits,5000000);
});
test('missing current target suggestions and duplicate transfers are explicit rather than counted as zero or twice',()=>{
 const f=fixture();delete f.snapshot.categories[0].goal_under_funded;const r=f.run();assert.equal(r.current_funding.target_suggestion_coverage_complete,false);assert.ok(r.questions.some(q=>q.code==='current_target_suggestions_missing'));
 const t={date:'2026-10-30',from_account_id:ids.bank,to_account_id:ids.savings,amount:1};f.input.transfers=[t,{...t}];assert.throws(()=>f.run(),/Duplicate forecast transfer/);
});
test('active shared write state prevents a positive conclusion, without mutating storage',async()=>{
 const f=fixture();let reads=0;
 const service=createSustainabilityService({budgetId:ids.budget,loader:{load:async()=>({settings:f.settings,revision:'x'})},snapshotReader:async()=>f.snapshot,store:{get:async()=>{reads++;return {proposal_id:id(99)};},put:async()=>assert.fail('read-only analysis must not save anything')}});
 const r=(await service.analyze(f.input,'auth0|test')).structuredContent;assert.equal(r.status,'needs_reconciliation');assert.equal(reads,1);
});
test('deterministic transfer forecasts conserve total cash across many balances and amounts',()=>{
 for(let n=1;n<=300;n++){
  const f=fixture();f.snapshot.accounts[0].balance=n*12345;f.snapshot.accounts[1].balance=n*4321;
  f.input.transfers=[{date:'2026-11-01',from_account_id:ids.bank,to_account_id:ids.savings,amount:n/10}];
  const r=f.run(),total=r.timing.accounts.reduce((v,a)=>v+a.ending_balance_milliunits,0);assert.equal(total,n*(12345+4321)+4000000);
 }
});

test('negative Ready to Assign, overspending and card floor gaps are visible despite positive averages',()=>{
 for(const mutate of [f=>f.snapshot.ready_to_assign=-1000,f=>f.snapshot.categories.find(c=>c.id===ids.food).balance=-1000,f=>f.snapshot.categories.find(c=>c.id===ids.card).balance=1000]){
  const f=fixture();mutate(f);assert.equal(f.run().status,'current_funding_gap');
 }
});

test('an empty completed-month category list is unavailable evidence rather than zero spending',()=>{
 const f=fixture();f.snapshot.historical_months[0].categories=[];const r=f.run();
 assert.equal(r.actual_spending.history_complete,false);assert.equal(r.actual_spending.months_available,2);assert.equal(r.status,'insufficient_evidence');
});
