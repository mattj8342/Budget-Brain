import {normalizeTarget,remainingTargetFunding,isWeeklyRefill,targetDrivenCategories,cardReserve} from './target-semantics.mjs';
// Pure allocation math: integer YNAB milliunits, no I/O.
export const CALCULATOR_VERSION='1.1.0';
export function integer(n,label='amount'){if(!Number.isSafeInteger(n))throw Error('Invalid integer '+label);return n;}
export function date(v){if(!/^\d{4}-\d{2}-\d{2}$/.test(v??'')||new Date(v+'T00:00:00Z').toISOString().slice(0,10)!==v)throw Error('Use a valid YYYY-MM-DD date');return v;}
export function addDays(v,n){return new Date(Date.parse(date(v)+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);}
export function milliunits(n){const m=Math.round(n*1000);if(!Number.isFinite(n)||Math.abs(m-n*1000)>1e-6)throw Error('At most three decimal places');return integer(m);}
export function calculatePaycheck({snapshot,policy,payday,next_payday,mode='new_payday',bill_resolutions=[],catch_up_topups=[],remaining_choices=[],floor_overrides=[],weekly_contributions=[],card_gap_reviews=[]}){
 date(payday);date(next_payday);date(snapshot.as_of);
 if(!policy||![1,2].includes(policy.schema_version))throw Error('Household allocation_policy version 1 is required');
 if(payday>snapshot.as_of||next_payday<=snapshot.as_of||next_payday<=payday||next_payday>addDays(payday,62))throw Error('Payday horizon must include today and end within 62 days');
 if(!['new_payday','catch_up'].includes(mode))throw Error('Invalid allocation mode');
 const month=snapshot.as_of.slice(0,7)+'-01';
 if(snapshot.month!==month)throw Error('Only current-month assignments supported; reserve future obligations in this month');
 for(const field of ['excluded_group_ids','excluded_category_ids','card_category_ids','monthly_bill_group_ids','annual_bill_group_ids','weekly_topups','monthly_targets','card_floors'])if(!Array.isArray(policy[field]))throw Error('Incomplete household allocation policy: '+field);
 for(const field of ['weekly_topups','monthly_targets','card_floors'])if(new Set(policy[field].map(x=>x.category_id)).size!==policy[field].length)throw Error('Duplicate policy mapping in '+field);
 const cats=new Map(snapshot.categories.filter(c=>!c.deleted&&!c.hidden&&!c.internal).map(c=>[c.id,{...c,added:0,projected:integer(c.balance),reasons:[]}]));
 if(cats.size!==snapshot.categories.filter(c=>!c.deleted&&!c.hidden&&!c.internal).length)throw Error('Duplicate categories');
 const questions=[],warnings=[],stages=[],unmet=[],excluded=new Set(policy.excluded_category_ids??[]),cards=new Set(policy.card_category_ids??[]);
 const excludedGroups=new Set(policy.excluded_group_ids??[]);
 const blocked=c=>excluded.has(c.id)||excludedGroups.has(c.category_group_id);
 const get=id=>{const c=cats.get(id);if(!c||blocked(c))throw Error('Missing, hidden or excluded mapping: '+id);integer(c.budgeted);return c;};
 const rta=integer(snapshot.ready_to_assign,'RTA');let remaining=Math.max(0,rta);
 if(rta<0)questions.push({code:'negative_rta',message:'Resolve negative Ready to Assign before new assignments.'});
 function fund(c,need,reason,priority){
  need=Math.max(0,integer(need));const amount=Math.min(need,remaining);
  c.added=integer(c.added+amount);c.projected=integer(c.projected+amount);remaining-=amount;
  c.reasons.push(reason);stages.push({priority,category_id:c.id,need_milliunits:need,assigned_milliunits:amount,reason});
  if(amount<need)unmet.push({category_id:c.id,priority,shortfall_milliunits:need-amount,reason});
  return amount;
 }
 const negatives=[...cats.values()].filter(c=>!blocked(c)&&!cards.has(c.id)&&c.projected<0);
 if(negatives.reduce((a,c)=>integer(a-c.projected),0)>remaining&&negatives.length>1)questions.push({code:'overspending_shortage_order',message:'Choose ordering for multiple negatives under shortage.'});
 for(const c of negatives.sort((a,b)=>a.id.localeCompare(b.id))){
  const added=fund(c,-c.projected,'Cover current-month eligible overspending',1);
  if(added>0&&snapshot.credit_spending_category_ids?.includes(c.id))questions.push({code:'automatic_card_effect',category_id:c.id,message:'Coverage may automatically increase card reserves. Resolve overspending separately, refresh YNAB and recalculate remaining-cycle funding. This combined plan cannot execute.'});
 }
 const resolutions=new Map();
 for(const b of bill_resolutions){get(b.category_id);if(resolutions.has(b.category_id))throw Error('Duplicate bill resolution');resolutions.set(b.category_id,b);}
 const bills=new Map(),allBillGroups=new Set([...(policy.monthly_bill_group_ids??[]),...(policy.annual_bill_group_ids??[])]);
 for(const o of snapshot.obligations??[]){
  date(o.due_date);if(o.due_date>=next_payday)continue;
  const c=cats.get(o.category_id);if(!c||blocked(c)||!allBillGroups.has(c.category_group_id))continue;
  const old=bills.get(c.id)??{category_id:c.id,amount_milliunits:0,due_date:o.due_date,source:'scheduled'};
  if(integer(o.amount_milliunits)<0)throw Error('Negative obligation');
  old.amount_milliunits=integer(old.amount_milliunits+o.amount_milliunits);old.due_date=old.due_date<o.due_date?old.due_date:o.due_date;bills.set(c.id,old);
 }
 for(const c of cats.values()){
  if(blocked(c)||!allBillGroups.has(c.category_group_id))continue;
  const b=resolutions.get(c.id);
  if(b){
   if(b.status==='paid_or_none_due'){bills.delete(c.id);continue;}
   if(b.status!=='unpaid')throw Error('Invalid bill status');
   date(b.due_date);if(integer(b.amount_milliunits)<0)throw Error('Negative bill');
   bills.set(c.id,{...b,source:'user_confirmed'});continue;
  }
  if(bills.has(c.id)){
   if(bills.get(c.id).due_date<snapshot.as_of)questions.push({code:'overdue_scheduled_bill',category_id:c.id,message:'Confirm whether this overdue scheduled obligation is still unpaid.'});
   continue;
  }
  if(c.goal_snoozed_at)continue;
  const due=c.goal_target_date;
  if(!due||due<snapshot.as_of||due<next_payday)questions.push({code:'bill_payment_status',category_id:c.id,name:c.name,message:'Confirm unpaid amount/date or that all obligations before next payday are already paid/none due. Targets alone do not prove payment.'});
 }
 for(const id of resolutions.keys())if(!allBillGroups.has(get(id).category_group_id))throw Error('Resolution outside configured bill groups');
 for(const [priority,groupIds] of [[2,policy.monthly_bill_group_ids??[]],[3,policy.annual_bill_group_ids??[]]]){
  const list=[...bills.values()].filter(b=>groupIds.includes(get(b.category_id).category_group_id)&&b.due_date<next_payday).sort((a,b)=>a.due_date.localeCompare(b.due_date)||a.category_id.localeCompare(b.category_id));
  const total=list.reduce((n,b)=>integer(n+Math.max(0,b.amount_milliunits-get(b.category_id).projected)),0);
  if(total>remaining&&list.some((b,i)=>i&&b.due_date===list[i-1].due_date))questions.push({code:'bill_shortage_tie',priority,message:'Equal-date bills exceed funds; confirm amounts or priority exception.'});
  for(const b of list)fund(get(b.category_id),Math.max(0,b.amount_milliunits-get(b.category_id).projected),'Unpaid bill due '+b.due_date+' ('+b.source+')',priority);
 }
 const floors=new Map();
 for(const f of floor_overrides){if(floors.has(f.category_id))throw Error('Duplicate floor');floors.set(f.category_id,integer(f.floor_milliunits));}
 const cardReserveRows=[];const gapReviews=new Set(card_gap_reviews);if(gapReviews.size!==card_gap_reviews.length)throw Error('Duplicate card gap review');
 for(const id of gapReviews)if(!(policy.card_floors??[]).some(f=>f.category_id===id))throw Error('Unknown card gap review');
 for(const f of policy.card_floors??[]){
  const c=get(f.category_id),floor=floors.get(c.id)??integer(f.floor_milliunits);
  if(floor<f.floor_milliunits)throw Error('Cannot lower saved floor');
  let reserve;try{reserve=cardReserve(c,f,snapshot,policy,floor);}catch(e){questions.push({code:'card_debt_unknown',category_id:c.id,message:e.message});continue;}
  cardReserveRows.push({category_id:c.id,...reserve});
  if(reserve.gap_milliunits>0&&!gapReviews.has(c.id))questions.push({code:'card_gap_discussion',category_id:c.id,debt_milliunits:reserve.debt_milliunits,available_milliunits:c.projected,gap_milliunits:reserve.gap_milliunits,proposed_reserve_milliunits:reserve.desired_milliunits,message:'Discuss the card gap and priority with the household. Review the default reserve versus any supported larger contribution before final allocation approval.'});
  fund(c,reserve.need_milliunits,'Reviewed card reserve, capped at debt where configured; not a bank payment',4);
 }
 for(const id of floors.keys())if(!(policy.card_floors??[]).some(f=>f.category_id===id))throw Error('Unknown card floor');
 const catchup=new Map();
 for(const t of catch_up_topups){if(catchup.has(t.category_id))throw Error('Duplicate catch-up amount');if(integer(t.available_goal_milliunits)<0)throw Error('Negative coverage goal');catchup.set(t.category_id,t.available_goal_milliunits);}
 const contributions=new Map();for(const row of weekly_contributions){if(contributions.has(row.category_id)||integer(row.already_contributed_milliunits)<0)throw Error('Invalid or duplicate cycle contribution');get(row.category_id);contributions.set(row.category_id,row.already_contributed_milliunits);}
 const targetDriven=policy.target_driven_essentials;
 const governed=targetDriven?targetDrivenCategories([...cats.values()],policy):[];
 if(targetDriven){
  if(!Array.isArray(targetDriven.group_ids)||!Array.isArray(targetDriven.priority_category_ids)||(!Number.isInteger(targetDriven.weekly_refill_periods)||targetDriven.weekly_refill_periods<1||targetDriven.weekly_refill_periods>9))throw Error('Invalid target-driven essentials policy');
  const crossMonth=next_payday.slice(0,7)!==snapshot.as_of.slice(0,7);
  const apply=(c,priority,isBuffer=false)=>{
   const n=normalizeTarget(c);
   if(n.period_unit==='week'&&n.amount_milliunits===null){questions.push({code:'target_amount_unknown',category_id:c.id,message:'Weekly coverage requires a live target amount.'});return;}
   if(n.snoozed){questions.push({code:'snoozed_required_target',category_id:c.id,message:'Review a snoozed required target before assigning.'});return;}
   if(isWeeklyRefill(c)){
    if(mode==='catch_up'&&!catchup.has(c.id)){questions.push({code:'catch_up_need',category_id:c.id,message:'Review remaining-cycle Available need; do not restart a two-week allowance.'});return;}
    const desired=catchup.has(c.id)?catchup.get(c.id):integer(targetDriven.weekly_refill_periods*n.amount_milliunits);
    fund(c,Math.max(0,desired-c.projected),isBuffer?'Required payday buffer, live weekly refill target':'Configured payday weekly refill coverage, counting existing Available',priority);
   }else if(n.kind==='spending'&&n.behavior==='set_aside'&&n.period_unit==='week'&&n.every===1&&!isBuffer){
    if(!contributions.has(c.id)){questions.push({code:'cycle_contribution_review',category_id:c.id,message:'Review contributions already made for this payday cycle, including an explicit zero when none. A monthly net assignment is not evidence of cycle contributions.'});return;}
    const need=Math.max(0,integer(targetDriven.weekly_refill_periods*n.amount_milliunits)-contributions.get(c.id)-c.added);
    fund(c,need,'Configured payday weekly set-aside contributions, counting reviewed cycle funding',priority);
   }else{
    if(isBuffer){questions.push({code:'buffer_target_mismatch',category_id:c.id,message:'Required payday buffer must have an active weekly refill target.'});return;}
    const needed=n.current_underfunded_milliunits;
    if(needed===null||n.behavior==='unknown'||n.kind==='unsupported'||n.kind==='none'){questions.push({code:'target_semantics_unknown',category_id:c.id,message:'Review target type/behavior and live remaining funding.'});return;}
    if(crossMonth&&!catchup.has(c.id)){questions.push({code:'cross_month_target_coverage',category_id:c.id,message:'Review remaining Available needed through next payday across the month boundary; the current monthly suggestion alone cannot establish next-period coverage.'});return;}
    const nativeNeed=Math.max(0,needed-c.added),coverage=catchup.has(c.id)?Math.max(0,catchup.get(c.id)-c.projected):0;
    fund(c,Math.max(nativeNeed,coverage),'Live target funding remaining, with reviewed cross-month coverage where needed',priority);
   }
  };
  for(const [i,c]of governed.entries()){if(blocked(c)||cards.has(c.id))throw Error('Excluded category in essentials group');apply(c,5+i);}
  const buffer=get(targetDriven.buffer_category_id);
  if(governed.some(c=>c.id===buffer.id))throw Error('Buffer must not be funded twice as an essential');
  apply(buffer,5+governed.length,true);
  const allowed=new Set([...governed.map(c=>c.id),buffer.id,...[...cats.values()].filter(c=>isWeeklyRefill(c)&&!blocked(c)&&!cards.has(c.id)).map(c=>c.id)]);for(const id of catchup.keys())if(!allowed.has(id))throw Error('Unknown target-driven coverage category');
 }else{
 for(const [i,w] of (policy.weekly_topups??[]).entries()){
  const c=get(w.category_id);let goal;
  if(mode==='catch_up'){
   if(!catchup.has(c.id)){questions.push({code:'catch_up_need',category_id:c.id,message:'Confirm remaining-cycle Available need; do not reset a spent allowance.'});continue;}
   goal=catchup.get(c.id);if(goal<0)throw Error('Negative catch-up goal');
  }else{
   if(c.goal_cadence!==2||(c.goal_cadence_frequency??1)!==1||c.goal_snoozed_at||!Number.isSafeInteger(c.goal_target)||c.goal_target<0){questions.push({code:'weekly_target',category_id:c.id,message:'A current active weekly target is required.'});continue;}
   if(!Number.isInteger(w.weeks)||w.weeks<1||w.weeks>9)throw Error('Invalid configured weeks');
   goal=integer(w.weeks*c.goal_target);
  }
  fund(c,Math.max(0,goal-c.projected),mode==='new_payday'?'Weekly top-up counting carryover':'Confirmed remaining-cycle need',5+i);
 }
 for(const id of catchup.keys())if(!(policy.weekly_topups??[]).some(w=>w.category_id===id))throw Error('Unknown catch-up category');
 for(const m of policy.monthly_targets??[]){
  const c=get(m.category_id);if(c.goal_snoozed_at)continue;
  if(!Number.isSafeInteger(c.goal_under_funded)){questions.push({code:'monthly_target',category_id:c.id,message:'Missing live monthly funding suggestion.'});continue;}
  fund(c,Math.max(0,c.goal_under_funded-c.added),'Live monthly remaining funding, adjusted for earlier additions',12);
 }

 }
 const choices=new Set();
 for(const o of remaining_choices){
  const c=get(o.category_id);if(choices.has(c.id))throw Error('Duplicate optional contribution');choices.add(c.id);
  if(cards.has(c.id))throw Error('Extra card payoff requires reconciled work-expense attribution; calculator v1 cannot execute it');
  if((policy.weekly_topups??[]).some(w=>w.category_id===c.id)||governed.some(g=>g.id===c.id)||targetDriven?.buffer_category_id===c.id)throw Error('Use cycle top-up, not another weekly refill');
  let need=integer(o.amount_milliunits);const target=normalizeTarget(c);
  if(targetDriven&&target.recurring===true){
   if(target.amount_milliunits===null){questions.push({code:'target_amount_unknown',category_id:c.id,message:'Review the live target amount before funding.'});continue;}
   let gap;
   if(target.period_unit==='week'&&target.every===1){
    if(target.behavior==='refill'){
     if(mode==='catch_up'&&!catchup.has(c.id)){questions.push({code:'catch_up_need',category_id:c.id,message:'Review remaining-cycle Available need before another weekly refill.'});continue;}
     gap=Math.max(0,(catchup.get(c.id)??integer(targetDriven.weekly_refill_periods*target.amount_milliunits))-c.projected);
    }else if(target.behavior==='set_aside'){
     if(!contributions.has(c.id)){questions.push({code:'cycle_contribution_review',category_id:c.id,message:'Review already-made cycle contributions before weekly set-aside funding.'});continue;}
     gap=Math.max(0,integer(targetDriven.weekly_refill_periods*target.amount_milliunits)-contributions.get(c.id)-c.added);
    }else{questions.push({code:'target_semantics_unknown',category_id:c.id,message:'Review weekly target behavior.'});continue;}
   }else gap=target.current_underfunded_milliunits===null?null:Math.max(0,target.current_underfunded_milliunits-c.added);
   if(gap===null){questions.push({code:'target_semantics_unknown',category_id:c.id,message:'Review native remaining funding before a contribution.'});continue;}need=Math.min(need,gap);
  }if(target.kind==='balance'||(target.kind==='spending'&&target.recurring===false)){const gap=remainingTargetFunding(c);if(gap===null){questions.push({code:'one_time_progress_unknown',category_id:c.id,message:'Review target-period funding progress; spending is not a new balance goal.'});continue;}need=Math.min(need,Math.max(0,gap-c.added));}if(need<0)throw Error('Contributions cannot withdraw money');
  const cap=(policy.optional_goal_caps??[]).find(x=>x.category_id===c.id)?.cap_milliunits;
  if(cap!==undefined)need=Math.min(need,Math.max(0,integer(cap)-c.projected));
  fund(c,need,'User-selected one-time contribution after required hierarchy',100);
 }
 if(remaining>0&&!remaining_choices.length)warnings.push('Discuss remaining targets, deadlines and eligible non-work debt; no automatic goal ranking or leftover buffer.');
 warnings.push('Excluded work balances and prior-month rollover are not funded again. A new-month zero is not evidence of reimbursement.','Category Available is not bank liquidity; review paying-account cash and uncleared deposits.');
 const rows=[...cats.values()].filter(c=>c.added>0).map(c=>({category_id:c.id,name:c.name,group:c.category_group_name,month,assigned_before_milliunits:c.budgeted,change_milliunits:c.added,assigned_after_milliunits:integer(c.budgeted+c.added),available_before_milliunits:c.balance,projected_available_milliunits:c.projected,reasons:c.reasons}));
 const assigned=rows.reduce((n,r)=>integer(n+r.change_milliunits),0);
 if(assigned+remaining!==Math.max(0,rta))throw Error('Allocation conservation failed');
 return {calculator_version:CALCULATOR_VERSION,status:questions.length?'needs_clarification':'calculated',budget_id:snapshot.budget_id,month,payday,next_payday,horizon_end:addDays(next_payday,-1),mode,captured_at:snapshot.captured_at,server_knowledge:snapshot.server_knowledge,ready_to_assign_before_milliunits:rta,assigned_milliunits:assigned,remaining_milliunits:remaining,rows,stages,unmet,questions,warnings,card_reserves:cardReserveRows,remaining_targets:[...cats.values()].filter(c=>!blocked(c)&&!cards.has(c.id)&&c.goal_type&&!governed.some(g=>g.id===c.id)&&targetDriven?.buffer_category_id!==c.id&&!allBillGroups.has(c.category_group_id)).map(c=>({category_id:c.id,name:c.name,group:c.category_group_name,remaining_monthly_milliunits:Number.isSafeInteger(c.goal_under_funded)?Math.max(0,c.goal_under_funded-c.added):null,remaining_goal_funding_milliunits:remainingTargetFunding(c)===null?null:Math.max(0,remainingTargetFunding(c)-c.added),target_date:c.goal_target_date??null,target:normalizeTarget(c)})),target_details:[...cats.values()].filter(c=>!blocked(c)&&!cards.has(c.id)).map(c=>({category_id:c.id,target:normalizeTarget(c)})),assignments:questions.length?[]:rows.map(r=>({category_id:r.category_id,month,budgeted:r.assigned_after_milliunits/1000}))};
}
