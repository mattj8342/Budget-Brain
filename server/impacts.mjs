// Pure scenario math. Inputs are independent of GitHub, Cloud Storage or Firestore.
import { integer, milliunits, date, addDays } from './allocation.mjs';
import {normalizeTarget,remainingTargetFunding,targetDrivenCategories,cardReserve} from './target-semantics.mjs';
const RTA='ready_to_assign';
const sum=values=>values.reduce((n,v)=>integer(n+v),0);
const positive=n=>Math.max(0,n);
function unique(rows,key,label){if(new Set(rows.map(row=>row[key])).size!==rows.length)throw Error('Duplicate '+label);}
export function impactHorizon(input,asOf){
 const end=input.horizon_end??input.goals.reduce((last,g)=>g.due_date>last?g.due_date:last,addDays(input.next_payday,28));
 date(end);if(end<input.next_payday||end>addDays(asOf,366))throw Error('Impact horizon must include next payday and be at most 366 days');return end;
}
function forecast({balances,input,purchase,asOf,horizon}){
 const goals=input.goals.map(g=>({...g,required:milliunits(g.required_balance),contributions:[],outcome:null}));
 const cashRoom=input.paychecks.map((p,index)=>({date:p.date,index,income_milliunits:milliunits(p.amount),committed_milliunits:milliunits(p.committed_amount),goal_contributions:[],unused_milliunits:positive(milliunits(p.amount)-milliunits(p.committed_amount))}));
 const events=[...cashRoom.map(p=>({date:p.date,rank:2,kind:'paycheck',p})),...goals.map(g=>({date:g.due_date,rank:g.include_payday_on_deadline?3:1,kind:'deadline',g}))];
 if(purchase)events.push({date:purchase.date,rank:0,kind:'purchase'});
 const priorityConfirmed=goals.length<=1||input.goal_order_confirmed;
 const b=new Map(balances);
 for(const event of events.sort((a,b)=>a.date.localeCompare(b.date)||a.rank-b.rank)){
  if(event.kind==='purchase'){const amount=milliunits(purchase.amount);b.set(purchase.category_id,integer((b.get(purchase.category_id)??0)-amount));for(const g of goals)if(g.category_id===purchase.category_id&&g.basis==='target_progress'&&!g.outcome)g.required=integer(g.required-amount);continue;}
  if(event.kind==='deadline'){
   const g=event.g;g.outcome={available_milliunits:b.get(g.category_id)??0,shortfall_milliunits:positive(g.required-(b.get(g.category_id)??0))};continue;
  }
  const p=event.p;
  // Never silently count all future pay as free money or invent an order among goals.
  if(!priorityConfirmed||!input.paychecks[p.index].commitments_confirmed)continue;
  for(const g of goals){
   if(g.outcome||p.date>g.due_date||(!g.include_payday_on_deadline&&p.date===g.due_date))continue;
   const amount=Math.min(p.unused_milliunits,positive(g.required-(b.get(g.category_id)??0)));
   if(!amount)continue;
   b.set(g.category_id,integer((b.get(g.category_id)??0)+amount));p.unused_milliunits-=amount;
   g.contributions.push({date:p.date,amount_milliunits:amount});p.goal_contributions.push({category_id:g.category_id,amount_milliunits:amount});
  }
 }
 return {conditional:true,goal_order_confirmed:priorityConfirmed,paychecks:cashRoom,goals:goals.map(g=>{
  const dates=[...new Set(input.paychecks.filter(p=>p.date<g.due_date||(g.include_payday_on_deadline&&p.date===g.due_date)).map(p=>p.date))];
  const initial=(balances.get(g.category_id)??0)-(purchase?.category_id===g.category_id&&purchase.date<=g.due_date?milliunits(purchase.amount):0);
  const need=positive(g.required-initial);
  return {category_id:g.category_id,due_date:g.due_date,basis:g.basis??'available_balance',target:g.target??null,required_balance_milliunits:g.required,current_scenario_gap_milliunits:need,eligible_paydays:dates,even_spread_requirement_milliunits:dates.length?Math.ceil(need/dates.length):null,contributions:g.contributions,available_at_deadline_milliunits:g.outcome?.available_milliunits??b.get(g.category_id),shortfall_at_deadline_milliunits:g.outcome?.shortfall_milliunits??positive(g.required-(b.get(g.category_id)??0))};
 })};
}
function cashProjection({snapshot,input,purchase,horizon}){
 const cash=snapshot.accounts.filter(a=>a.on_budget&&['checking','savings','cash'].includes(a.type));
 return cash.map(account=>{
  const events=input.cash_events.filter(e=>e.account_id===account.id).map(e=>({date:e.date,amount_milliunits:milliunits(e.amount),source:'reviewed_cash_event'}));
  for(const p of input.paychecks.filter(p=>p.account_id===account.id))events.push({date:p.date,amount_milliunits:milliunits(p.amount),source:'forecast_paycheck'});
  if(purchase?.account_id===account.id)events.push({date:purchase.date,amount_milliunits:-milliunits(purchase.amount),source:'hypothetical_purchase'});
  let balance=integer(account.balance),minimum=balance;const rows=[];
  for(const event of events.sort((a,b)=>a.date.localeCompare(b.date)||a.amount_milliunits-b.amount_milliunits)){
   balance=integer(balance+event.amount_milliunits);minimum=Math.min(minimum,balance);rows.push({...event,balance_milliunits:balance});
  }
  return {account_id:account.id,name:account.name,starting_balance_milliunits:account.balance,minimum_projected_milliunits:minimum,ending_balance_milliunits:balance,conditional:true,coverage_confirmed:input.cash_events_complete,events:rows};
 });
}
export function calculateImpacts({snapshot,settings,input}){
 date(snapshot.as_of);date(input.next_payday);
 if(input.next_payday<=snapshot.as_of||input.next_payday>addDays(snapshot.as_of,62))throw Error('Next payday must be after today and within 62 days');
 const horizon=impactHorizon(input,snapshot.as_of),policy=settings.allocation_policy;
 if(![1,2].includes(policy?.schema_version))throw Error('Allocation policy version 1 required');
 const cats=new Map(snapshot.categories.filter(c=>!c.deleted&&!c.hidden&&!c.internal).map(c=>[c.id,c]));
 if(cats.size!==snapshot.categories.filter(c=>!c.deleted&&!c.hidden&&!c.internal).length)throw Error('Duplicate categories');
 const balances=new Map([...cats].map(([id,c])=>[id,integer(c.balance)]));
 const get=id=>{const c=cats.get(id);if(!c)throw Error('Unknown or hidden category '+id);integer(c.budgeted);return c;};
 const excluded=c=>policy.excluded_category_ids.includes(c.id)||policy.excluded_group_ids.includes(c.category_group_id)||policy.card_category_ids.includes(c.id);
 const minimum=new Map(),unknown=new Set(),questions=[];
 const requireAmount=(id,amount)=>minimum.set(id,Math.max(minimum.get(id)??0,integer(amount)));
 unique(input.remaining_needs,'category_id','remaining need');unique(input.bill_resolutions,'category_id','bill resolution');unique(input.goals,'category_id','goal');unique(input.scenarios,'id','scenario');
 for(const row of input.remaining_needs){get(row.category_id);requireAmount(row.category_id,milliunits(row.amount));}
 for(const c of cats.values())if(!excluded(c)&&c.balance<0)requireAmount(c.id,0);
 const knownNeeds=new Set(input.remaining_needs.map(row=>row.category_id));
 for(const row of [...policy.weekly_topups,...policy.monthly_targets,...targetDrivenCategories([...cats.values()],policy).map(c=>({category_id:c.id})),...(policy.target_driven_essentials?[{category_id:policy.target_driven_essentials.buffer_category_id}]:[])])if(!knownNeeds.has(row.category_id))unknown.add(row.category_id);
 for(const floor of policy.card_floors)if(cats.has(floor.category_id)){try{requireAmount(floor.category_id,cardReserve(get(floor.category_id),floor,snapshot,policy).desired_milliunits);}catch{unknown.add(floor.category_id);}}
 const protectEnd=addDays(snapshot.as_of,settings.constraints?.protect_next_14_days_bills===false?0:14);
 const resolutions=new Map(input.bill_resolutions.map(b=>[b.category_id,b]));
 const scheduled=new Map();
 for(const o of snapshot.obligations??[]){
  if(!cats.has(o.category_id)||o.due_date>protectEnd)continue;
  const existing=scheduled.get(o.category_id)??{amount:0,overdue:false};
  existing.amount=integer(existing.amount+integer(o.amount_milliunits));existing.overdue ||= o.due_date<snapshot.as_of;scheduled.set(o.category_id,existing);
 }
 const billGroups=new Set([...policy.monthly_bill_group_ids,...policy.annual_bill_group_ids]);
 for(const c of cats.values()){
  if(excluded(c))continue;
  const resolution=resolutions.get(c.id),scheduledBill=scheduled.get(c.id);
  if(resolution){if(resolution.status==='unpaid'){date(resolution.due_date);if(resolution.due_date<=protectEnd)requireAmount(c.id,milliunits(resolution.amount));}continue;}
  if(scheduledBill&&!scheduledBill.overdue){requireAmount(c.id,scheduledBill.amount);continue;}
  if(scheduledBill?.overdue||(billGroups.has(c.category_group_id)&&!c.goal_snoozed_at&&(!c.goal_target_date||c.goal_target_date<=protectEnd)))unknown.add(c.id);
 }
 for(const id of resolutions.keys())get(id);
 for(const id of unknown)questions.push({code:'remaining_obligation_unknown',category_id:id,name:cats.get(id)?.name,message:'Confirm remaining-cycle need or unpaid bill status before using this category or treating RTA as spare.'});
 for(const issue of snapshot.issues??[])questions.push({code:'snapshot_schedule_issue',message:issue});
 input={...input,goals:input.goals.map(goal=>{
  const c=get(goal.category_id),target=normalizeTarget(c);
  const progress=target.kind==='spending'&&target.recurring===false;
  const basis=goal.basis==='auto'||!goal.basis?(progress?'target_progress':'available_balance'):goal.basis;
  if(!['target_progress','available_balance'].includes(basis))throw Error('Invalid goal basis');
  if(basis!=='target_progress')return {...goal,basis,target};
  if(!progress)throw Error('Target-progress basis requires a non-recurring spending target');
  if(milliunits(goal.required_balance)!==target.amount_milliunits)throw Error('Target-progress goal amount must match live target; use available_balance for an explicit unspent balance goal');
  const gap=remainingTargetFunding(c);if(gap===null)throw Error('Target-period funding progress unavailable; cannot assume an unspent balance goal');
  return {...goal,basis,target,required_balance:integer(c.balance+gap)/1000};
 })};
 for(const goal of input.goals){get(goal.category_id);date(goal.due_date);if(goal.due_date<snapshot.as_of||goal.due_date>horizon)throw Error('Goal deadline outside horizon');milliunits(goal.required_balance);}
 if(input.goals.length>1&&!input.goal_order_confirmed)questions.push({code:'goal_priority_required',message:'Confirm the supplied goal order; future contributions are not allocated among unranked goals.'});
 for(const p of input.paychecks){date(p.date);if(p.date<input.next_payday||p.date>horizon)throw Error('Forecast paycheck outside payday horizon');if(p.committed_amount>p.amount)questions.push({code:'forecast_paycheck_shortfall',date:p.date,message:'Expected paycheck is smaller than its existing commitments.'});if(!p.commitments_confirmed)questions.push({code:'forecast_commitments_unconfirmed',date:p.date,message:'Confirm income already reserved for bills, essentials and other commitments; unconfirmed room is not allocated to goals.'});}
 for(const e of input.cash_events){date(e.date);if(e.date<snapshot.as_of||e.date>horizon)throw Error('Cash event outside horizon');if(!snapshot.accounts.some(a=>a.id===e.account_id&&a.on_budget&&['checking','savings','cash'].includes(a.type)))throw Error('Cash event requires an on-budget cash account');}
 for(const event of input.cash_events)if(!event.distinct_from_recorded_confirmed&&snapshot.transactions?.some(t=>!t.deleted&&t.account_id===event.account_id&&t.date===event.date&&t.amount===milliunits(event.amount)))throw Error('Cash event may already be included in the snapshot; confirm it is a distinct future event');
 for(const p of input.paychecks)if(p.account_id&&!snapshot.accounts.some(a=>a.id===p.account_id&&a.on_budget&&['checking','savings','cash'].includes(a.type)))throw Error('Forecast deposit account must be an on-budget cash account');
 const futureRelevant=(snapshot.future_assigned_categories??[]).filter(row=>input.goals.some(g=>g.category_id===row.category_id));
 if(futureRelevant.length)questions.push({code:'future_month_goal_funding',message:'Goal projections are provisional: reconcile assignments already made in future months before interpreting replenishment requirements.',assignments:futureRelevant});
 const baselineForecast=forecast({balances,input,asOf:snapshot.as_of,horizon});
 baselineForecast.preassigned_future_goal_funding_unresolved=futureRelevant.length>0;
 const baseline={ready_to_assign_milliunits:integer(snapshot.ready_to_assign),protected_needs:[...minimum].map(([id,n])=>({category_id:id,name:get(id).name,required_milliunits:n,available_milliunits:balances.get(id),shortfall_milliunits:positive(n-balances.get(id))})),questions,forecast:baselineForecast,cash:cashProjection({snapshot,input,horizon})};
 const options=input.scenarios.map(s=>{
  const after=new Map(balances),delta=new Map(),blockers=[],warnings=[];
  let rta=integer(snapshot.ready_to_assign);
  const change=(id,n)=>{if(id===RTA){rta=integer(rta+n);return;}get(id);after.set(id,integer(after.get(id)+n));delta.set(id,integer((delta.get(id)??0)+n));};
  for(const move of s.moves){
   const amount=milliunits(move.amount);if(amount<=0||move.from_category_id===move.to_category_id)throw Error('Each move needs a positive amount and distinct endpoints');
   if(move.from_category_id!==RTA&&excluded(get(move.from_category_id)))blockers.push({code:'excluded_source',category_id:move.from_category_id});
   if(move.to_category_id!==RTA&&excluded(get(move.to_category_id)))blockers.push({code:'excluded_destination',category_id:move.to_category_id});
   change(move.from_category_id,-amount);change(move.to_category_id,amount);
  }
  if(rta<0)blockers.push({code:'insufficient_received_rta'});
  const usesRta=s.moves.some(m=>m.from_category_id===RTA);
  if(usesRta&&(unknown.size||(snapshot.issues??[]).length))blockers.push({code:'rta_obligations_unresolved'});
  if(usesRta&&baseline.protected_needs.some(row=>row.shortfall_milliunits>0&&(after.get(row.category_id)??0)<row.required_milliunits))blockers.push({code:'priority_needs_unfunded'});
  if((snapshot.issues??[]).length&&s.moves.length)blockers.push({code:'schedule_coverage_incomplete'});
  const rows=[...delta].filter(([,n])=>n!==0).map(([id,n])=>{
   const c=get(id),balance=after.get(id),floor=minimum.get(id)??0;
   const native=normalizeTarget(c),gap=(native.kind==='balance'||(native.kind==='spending'&&native.recurring===false))?remainingTargetFunding(c):null;
   if(n>0&&gap!==null&&n>gap)blockers.push({code:'native_goal_funding_exceeded',category_id:id});
   if(n>0&&native.kind==='spending'&&native.recurring===false&&gap===null)blockers.push({code:'target_progress_unknown',category_id:id});
   const cap=policy.optional_goal_caps?.find(row=>row.category_id===id)?.cap_milliunits;
   if(n>0&&cap!==undefined&&balance>cap)blockers.push({code:'configured_goal_cap',category_id:id});
   if(n<0&&unknown.has(id))blockers.push({code:'source_need_unknown',category_id:id});
   if(n<0&&(balance<0||balance<Math.min(balances.get(id),floor)))blockers.push({code:'protected_source_or_overspend',category_id:id});
   if(n>0&&c.balance<0&&snapshot.credit_spending_category_ids?.includes(id))blockers.push({code:'automatic_card_correction_unsupported',category_id:id});
   if(n<0&&c.goal_target_date>=snapshot.as_of&&!input.goals.some(g=>g.category_id===id)&&!minimum.has(id))blockers.push({code:'dated_goal_definition_required',category_id:id});
   return {category_id:id,name:c.name,month:snapshot.month,assigned_before_milliunits:c.budgeted,change_milliunits:n,assigned_after_milliunits:integer(c.budgeted+n),available_before_milliunits:c.balance,funding_available_after_milliunits:balance};
  });
  if(sum(rows.map(row=>row.change_milliunits))!==snapshot.ready_to_assign-rta)throw Error('Funding conservation failed');
  let purchase=null,accountImpact=null;
  if(s.purchase){
   purchase=s.purchase;get(purchase.category_id);date(purchase.date);
   if(purchase.date<snapshot.as_of||purchase.date>horizon)throw Error('Purchase date outside horizon');
   if(!purchase.distinct_from_recorded_confirmed&&snapshot.transactions?.some(t=>!t.deleted&&t.account_id===purchase.account_id&&t.date===purchase.date&&t.amount===-milliunits(purchase.amount)))blockers.push({code:'purchase_may_already_be_in_snapshot'});
   const amount=milliunits(purchase.amount);if(amount<=0)throw Error('Purchase amount must be positive');
   const account=snapshot.accounts.find(a=>a.id===purchase.account_id&&a.on_budget);
   if(!account||!['checking','savings','cash','creditCard','lineOfCredit'].includes(account.type))throw Error('Purchase requires a supported on-budget account');
   const funded=(after.get(purchase.category_id)??0)>=amount;
   if(!funded)blockers.push({code:'purchase_not_fully_funded_now',category_id:purchase.category_id});
   if(excluded(get(purchase.category_id)))blockers.push({code:'excluded_purchase_category',category_id:purchase.category_id});
   const required=minimum.get(purchase.category_id)??0;
   const needAfter=purchase.counts_toward_remaining_need?positive(required-amount):required;
   if(unknown.has(purchase.category_id))blockers.push({code:'purchase_remaining_need_unknown',category_id:purchase.category_id});
   else if((after.get(purchase.category_id)??0)-amount<needAfter)blockers.push({code:'purchase_reduces_protected_coverage',category_id:purchase.category_id});
   const credit=['creditCard','lineOfCredit'].includes(account.type);
   accountImpact={account_id:account.id,type:account.type,balance_before_milliunits:account.balance,hypothetical_balance_after_milliunits:integer(account.balance-amount),new_debt_milliunits:credit?positive(-(account.balance-amount))-positive(-account.balance):0,cash_outflow_now_milliunits:credit?0:amount,automatic_card_reserve_increase_milliunits:credit&&funded?positive(-(account.balance-amount))-positive(-account.balance):null,projection_only:true};
   if(credit)warnings.push('Funded credit purchase projects an automatic payment-reserve increase, not a bank payment or reconciled work-debt payoff.');
   if(!credit&&account.balance<amount)blockers.push({code:'paying_account_cash_shortfall'});
  }
  if((snapshot.future_assigned_categories??[]).some(row=>delta.has(row.category_id)))blockers.push({code:'future_month_funding_requires_reconciliation'});
  if(futureRelevant.length)blockers.push({code:'future_goal_funding_requires_reconciliation'});
  const projection=forecast({balances:after,input,purchase,asOf:snapshot.as_of,horizon});
  const goalEffects=projection.goals.map(g=>{
   const before=baselineForecast.goals.find(old=>old.category_id===g.category_id);
   return {...g,baseline_gap_milliunits:before.current_scenario_gap_milliunits,additional_future_need_milliunits:g.current_scenario_gap_milliunits-before.current_scenario_gap_milliunits,baseline_shortfall_at_deadline_milliunits:before.shortfall_at_deadline_milliunits,additional_even_spread_per_payday_milliunits:g.even_spread_requirement_milliunits===null||before.even_spread_requirement_milliunits===null?null:g.even_spread_requirement_milliunits-before.even_spread_requirement_milliunits};
  });
  const cash=cashProjection({snapshot,input,purchase,horizon});
  if(purchase&&cash.some(a=>a.account_id===purchase.account_id&&a.minimum_projected_milliunits<0))blockers.push({code:'conditional_paying_account_shortfall'});
  if(purchase&&!input.cash_events_complete)warnings.push('Account cash projection includes only listed reviewed events and forecast deposits; it is not a complete bank-liquidity guarantee.');
  const nextDate=input.paychecks.map(p=>p.date).sort()[0]??null;
  const contributions=(f,d)=>sum(f.paychecks.filter(p=>p.date===d).flatMap(p=>p.goal_contributions.map(g=>g.amount_milliunits)));
  return {id:s.id,label:s.label,status:blockers.length?'needs_review':'funding_supported_now',execution_eligible:blockers.length===0&&rows.length>0,execution_scope:'current-month category funding only; hypothetical spending and future income are never written',blockers,warnings,rows,ready_to_assign_after_funding_milliunits:rta,purchase:purchase?{...purchase,amount_milliunits:milliunits(purchase.amount),category_available_after_spend_milliunits:integer(after.get(purchase.category_id)-milliunits(purchase.amount)),projection_only:true}:null,account_impact:accountImpact,forecast:projection,goal_effects:goalEffects,next_forecast_payday:nextDate,next_payday_goal_contribution_delta_milliunits:nextDate?contributions(projection,nextDate)-contributions(baselineForecast,nextDate):null,cash,assignments:blockers.length?[]:rows.map(row=>({category_id:row.category_id,month:snapshot.month,budgeted:row.assigned_after_milliunits/1000}))};
 });
 return {calculator_version:'impacts-1.1.0',budget_id:snapshot.budget_id,as_of:snapshot.as_of,month:snapshot.month,horizon_end:horizon,next_payday:input.next_payday,captured_at:snapshot.captured_at,server_knowledge:snapshot.server_knowledge,baseline,options,assumptions:['Same snapshot and household rules for baseline and every option.','Goal basis is explicit: auto uses funding progress for a non-recurring spending target and Available balance otherwise. Target-progress purchases consume goal funds without creating an automatic replacement balance goal.','Future paychecks and goal contributions are conditional. Commitments must include bills, essentials, debt minimums and other prior claims.','Cash-flow events are a separately reviewed forecast; current account balances already include registered pending transactions. Do not list those again.','No automatic goal ranking, category withdrawal, bank payment or transaction creation.']};
}
