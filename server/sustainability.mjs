import {normalizeTarget,remainingTargetFunding,targetRecurrence,cardReserve} from './target-semantics.mjs';
// Pure, read-only sustainability analysis. Currency is integer YNAB milliunits.
import {integer,milliunits,date,addDays} from './allocation.mjs';
export const SUSTAINABILITY_VERSION='sustainability-1.1.0';
const sum=rows=>rows.reduce((n,v)=>integer(n+v),0),pos=n=>Math.max(0,n);
const copy=v=>structuredClone(v);
const unique=(rows,key,label)=>{if(new Set(rows.map(r=>r[key])).size!==rows.length)throw Error('Duplicate '+label);};
const periods={weekly:[52n,12n],biweekly:[26n,12n],semimonthly:[2n,1n],monthly:[1n,1n],quarterly:[1n,3n],annual:[1n,12n]};
export function monthlyRate(amount,cadence,every=1){integer(amount);if(amount<0||!periods[cadence]||!Number.isInteger(every)||every<1||every>120)throw Error('Invalid recurrence');const [n,d0]=periods[cadence],d=d0*BigInt(every);return integer(Number((BigInt(amount)*n+d/2n)/d));}
function monthShift(day,n,anchor=Number(day.slice(8))){const [y,m]=day.split('-').map(Number),d=new Date(Date.UTC(y,m-1+n,1)),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),Math.min(anchor,last))).toISOString().slice(0,10);}
const monthStart=d=>d.slice(0,7)+'-01';
function datesFor(stream,asOf,end){
 if(!stream.next_date)return [];
 date(stream.next_date);if(stream.next_date<=asOf)throw Error('Next income date must be after today');if(stream.next_date>end)return [];
 if(stream.cadence==='semimonthly'){
  if(stream.every!==1||!stream.paydays||stream.paydays.length!==2||stream.paydays[0]>=stream.paydays[1])throw Error('Semimonthly income requires two distinct ordered paydays and every=1');
  const dates=[];for(let month=monthStart(stream.next_date);month<=end;month=monthShift(month,1,1)){
   for(const d of new Set(stream.paydays.map(day=>monthShift(month,0,day))))if(d>=stream.next_date&&d<=end)dates.push(d);
  }if(dates[0]!==stream.next_date)throw Error('Next semimonthly date does not match the reviewed paydays');return dates;
 }
 const answer=[],anchor=Number(stream.next_date.slice(8));let d=stream.next_date;
 for(let i=0;d<=end&&i<370;i++){
  answer.push(d);
  if(stream.cadence==='weekly'||stream.cadence==='biweekly')d=addDays(d,(stream.cadence==='weekly'?7:14)*stream.every);
  else d=monthShift(d,({monthly:1,quarterly:3,annual:12}[stream.cadence])*stream.every,anchor);
 }
 return answer;
}
export function analyzeSustainability({snapshot,settings,input}){
 date(snapshot.as_of);date(input.horizon_end);
 if(input.horizon_end<=snapshot.as_of||input.horizon_end>addDays(snapshot.as_of,366))throw Error('Forecast horizon must be after today and within 366 days');
 const policy=settings.allocation_policy;if(![1,2].includes(policy?.schema_version))throw Error('Allocation policy version 1 required');
 const cards=new Set(policy.card_category_ids),excludedIds=new Set(policy.excluded_category_ids),excludedGroups=new Set(policy.excluded_group_ids);
 const all=new Map([...(snapshot.category_catalog??[]),...snapshot.categories].map(c=>[c.id,c]));
 const internal=c=>c.internal===true||c.category_group_name==='Internal Master Category';
 const excluded=c=>excludedIds.has(c.id)||excludedGroups.has(c.category_group_id);
 const active=snapshot.categories.filter(c=>!c.deleted&&!c.hidden&&!internal(c)&&!cards.has(c.id));
 const get=id=>{const c=all.get(id);if(!c||internal(c))throw Error('Unknown or internal category');return c;};
 const cashAccounts=snapshot.accounts.filter(a=>a.on_budget&&['checking','savings','cash'].includes(a.type));
 const account=id=>{const a=cashAccounts.find(a=>a.id===id);if(!a)throw Error('An open on-budget cash account is required');integer(a.balance);return a;};
 const questions=[],warnings=[];
 unique(input.income_streams,'id','income stream');unique(input.one_time_income,'id','one-time income');unique(input.category_reviews,'category_id','category review');unique(input.cash_events,'id','cash event');
 const reviews=new Map(input.category_reviews.map(r=>[r.category_id,r]));
 for(const row of input.category_reviews){const c=get(row.category_id);if(cards.has(c.id)||excluded(c))throw Error('Work and card-payment categories cannot be overridden into household cost totals');if(!active.some(a=>a.id===c.id))throw Error('Category reviews must address a visible current category');}
 const costs=[],currentRows=[],unresolved=[],oneTime=[];
 for(const c of active){
  integer(c.balance);integer(c.budgeted);
  if(excluded(c))continue;
  const target=normalizeTarget(c),r=reviews.get(c.id);let recurrence=null,classification='unresolved';
  if(r?.classification==='excluded')classification='reviewed_exclusion';
  else if(r?.classification==='one_time')classification='one_time';
  else if(r?.classification==='recurring'){recurrence={amount:milliunits(r.amount),cadence:r.cadence,every:r.every,source:'reviewed_override'};classification='recurring';}
  else if(Number.isSafeInteger(c.goal_target)&&c.goal_target>=0){
   recurrence=targetRecurrence(c);
   if(recurrence)classification='recurring';
   else if(['TB','TBD'].includes(c.goal_type)||(c.goal_type==='NEED'&&c.goal_cadence===0))classification='one_time';
  }
  if(recurrence){
   const monthly=monthlyRate(recurrence.amount,recurrence.cadence,recurrence.every);
   costs.push({category_id:c.id,name:c.name,classification,amount_per_occurrence_milliunits:recurrence.amount,cadence:recurrence.cadence,every:recurrence.every,monthly_average_milliunits:monthly,source:recurrence.source,target_behavior:target.behavior,repeat_every:target.every,repeat_unit:target.period_unit,refill_average_is_spending_capacity:target.behavior==='refill',snoozed:!!c.goal_snoozed_at});
   if(c.goal_snoozed_at)warnings.push({code:'snoozed_recurring_target',category_id:c.id,message:'Snoozing current funding does not by itself end a recurring commitment.'});
  }else if(classification==='unresolved'){
   unresolved.push({category_id:c.id,name:c.name,reason:'Confirm recurring amount/cadence, one-time purpose, or an explicit exclusion.'});
  }
  const targetShortfall=Number.isSafeInteger(c.goal_under_funded)?pos(c.goal_under_funded):null;
  const desired=r?.remaining_available;
  const row={category_id:c.id,name:c.name,classification,target,available_milliunits:c.balance,assigned_milliunits:c.budgeted,current_ynab_underfunded_milliunits:targetShortfall,overspending_milliunits:pos(-c.balance),reviewed_remaining_available_milliunits:desired===undefined?null:milliunits(desired),reviewed_topup_milliunits:desired===undefined?null:pos(milliunits(desired)-c.balance)};
  if(classification!=='reviewed_exclusion')currentRows.push(row);
  if(classification==='one_time'){
   const required=r?.required_balance===undefined?(['TB','TBD'].includes(c.goal_type)?c.goal_target:null):milliunits(r.required_balance);
   oneTime.push({category_id:c.id,name:c.name,due_date:r?.due_date??c.goal_target_date??null,target_kind:target.kind,target_behavior:target.behavior,required_balance_milliunits:required,remaining_funding_gap_milliunits:r?.required_balance!==undefined?pos(milliunits(r.required_balance)-c.balance):remainingTargetFunding(c),remaining_balance_gap_milliunits:Number.isSafeInteger(required)?pos(required-c.balance):null,current_ynab_underfunded_milliunits:targetShortfall});
  }
 }
 unique(input.debt_paydown,'card_category_id','debt paydown');
 for(const d of input.debt_paydown){if(!cards.has(d.card_category_id))throw Error('Debt paydown must use a configured card payment category');const amount=milliunits(d.amount);costs.push({category_id:d.card_category_id,name:all.get(d.card_category_id)?.name??'Card',classification:'existing_household_debt_paydown',amount_per_occurrence_milliunits:amount,cadence:d.cadence,every:d.every,monthly_average_milliunits:monthlyRate(amount,d.cadence,d.every),source:'reviewed_additional_principal'});}
 if(cards.size&&!input.debt_coverage_confirmed)questions.push({code:'debt_paydown_not_reviewed',message:'Review existing household debt principal contributions separately from new spending, interest targets and work debt.'});
 if(unresolved.length)questions.push({code:'category_costs_unresolved',categories:unresolved});
 if(!input.category_coverage_confirmed)questions.push({code:'category_coverage_unconfirmed',message:'Confirm the reviewed recurring commitments and omissions before a whole-budget conclusion.'});
 if(!input.income_coverage_confirmed||!input.income_streams.length)questions.push({code:'income_basis_unconfirmed',message:'Review reliable net recurring income. Transaction inflows alone do not identify salary.'});
 const income=input.income_streams.map(s=>({...s,amount_milliunits:milliunits(s.amount),monthly_average_milliunits:monthlyRate(milliunits(s.amount),s.cadence,s.every)}));
 const reliable=sum(income.filter(s=>s.certainty==='reliable').map(s=>s.monthly_average_milliunits));
 const variable=sum(income.filter(s=>s.certainty==='variable').map(s=>s.monthly_average_milliunits));
 const uncertain=sum(income.filter(s=>s.certainty==='uncertain').map(s=>s.monthly_average_milliunits));
 const monthlyCost=sum(costs.map(c=>c.monthly_average_milliunits)),margin=integer(reliable-monthlyCost);
 const adjustments=new Map();for(const a of input.income_adjustments){const key=a.stream_id+'/'+a.date;if(adjustments.has(key))throw Error('Duplicate income adjustment');adjustments.set(key,a);}
 const consumed=new Set(),events=[],incomeDates=[];
 function registered(a,d,n){return (snapshot.transactions??[]).some(t=>!t.deleted&&t.account_id===a&&t.date===d&&t.amount===n);}
 for(const s of income){
  if(!s.next_date){questions.push({code:'income_dates_missing',stream_id:s.id});continue;}
  if(s.account_id)account(s.account_id);else questions.push({code:'income_account_missing',stream_id:s.id});
  for(const day of datesFor(s,snapshot.as_of,input.horizon_end)){
   const key=s.id+'/'+day,change=adjustments.get(key);if(change)consumed.add(key);
   const amount=change?milliunits(change.amount):s.amount_milliunits,certainty=change?.certainty??s.certainty;
   const included=s.account_id?registered(s.account_id,day,amount):false;
   const row={id:'income:'+key,stream_id:s.id,label:s.label,date:day,account_id:s.account_id??null,amount_milliunits:amount,certainty,already_registered:included,replaces_regular_amount:!!change};
   incomeDates.push(row);if(s.account_id&&certainty==='reliable'&&!included)events.push({...row,source:'reviewed_income'});
  }
 }
 for(const key of adjustments.keys())if(!consumed.has(key))throw Error('Income adjustment must replace an actual generated payday, not add a second deposit');
 for(const p of input.one_time_income){
  date(p.date);if(p.date<=snapshot.as_of||p.date>input.horizon_end)throw Error('One-time income outside future horizon');
  if(p.account_id)account(p.account_id);else questions.push({code:'income_account_missing',stream_id:p.id});
  const amount=milliunits(p.amount),included=p.account_id?registered(p.account_id,p.date,amount):false;
  if(incomeDates.some(e=>e.account_id===p.account_id&&e.date===p.date&&e.amount_milliunits===amount)&&!p.distinct_from_forecast_confirmed)throw Error('One-time income matches a forecast deposit; use an adjustment for a replacement or confirm a distinct deposit');
  const row={id:'one_time:'+p.id,label:p.label,date:p.date,account_id:p.account_id??null,amount_milliunits:amount,certainty:p.certainty,already_registered:included,one_time:true};incomeDates.push(row);
  if(p.account_id&&p.certainty==='reliable'&&!included)events.push({...row,source:'reviewed_one_time_income'});
 }
 for(const e of input.cash_events){
  account(e.account_id);date(e.date);if(e.date<snapshot.as_of||e.date>input.horizon_end)throw Error('Cash event outside forecast horizon');
  const amount=milliunits(e.amount);if(!amount)throw Error('Cash event cannot be zero');
  if(registered(e.account_id,e.date,amount)&&!e.distinct_from_registered_confirmed)throw Error('Cash event may already be included in current balances; reconcile before adding it');
  if(incomeDates.some(p=>p.account_id===e.account_id&&p.date===e.date&&p.amount_milliunits===amount)&&!e.distinct_from_registered_confirmed)throw Error('Cash event duplicates a forecast income event');
  if(amount<0||e.certainty==='reliable')events.push({id:'event:'+e.id,date:e.date,account_id:e.account_id,amount_milliunits:amount,source:e.kind,label:e.label});
 }
 const transferKeys=new Set();
 for(const t of input.transfers){
  const key=[t.date,t.from_account_id,t.to_account_id,t.amount].join('/');if(transferKeys.has(key)&&!t.distinct_from_registered_confirmed)throw Error('Duplicate forecast transfer');transferKeys.add(key);
  account(t.from_account_id);account(t.to_account_id);date(t.date);if(t.from_account_id===t.to_account_id||t.date<snapshot.as_of||t.date>input.horizon_end)throw Error('Invalid forecast cash transfer');
  const amount=milliunits(t.amount);
  if(!t.distinct_from_registered_confirmed&&(registered(t.from_account_id,t.date,-amount)||registered(t.to_account_id,t.date,amount)))throw Error('Transfer may already be reflected in current cash');
  events.push({date:t.date,account_id:t.from_account_id,amount_milliunits:-amount,source:'reviewed_transfer'},{date:t.date,account_id:t.to_account_id,amount_milliunits:amount,source:'reviewed_transfer'});
 }
 const missingIncomeAccounts=incomeDates.some(p=>!p.account_id&&p.certainty==='reliable')||income.some(s=>s.certainty==='reliable'&&!s.next_date);
 const timingComplete=cashAccounts.length>0&&input.cash_flow_coverage_confirmed&&!missingIncomeAccounts&&!(snapshot.issues??[]).length;
 if(!input.cash_flow_coverage_confirmed)questions.push({code:'cash_flow_coverage_unconfirmed',message:'Review all future bank movements, including card payments and work outflows. Target funding is not a bank outflow.'});
 const cash=cashAccounts.map(a=>{
  let balance=integer(a.balance),minimum=balance;let first=balance<0?{date:snapshot.as_of,shortfall_milliunits:-balance}:null;
  const rows=[];
  for(const e of events.filter(e=>e.account_id===a.id).sort((x,y)=>x.date.localeCompare(y.date)||x.amount_milliunits-y.amount_milliunits)){
   balance=integer(balance+e.amount_milliunits);minimum=Math.min(minimum,balance);if(!first&&balance<0)first={date:e.date,shortfall_milliunits:-balance};
   rows.push({...e,closing_balance_milliunits:balance});
  }
  return {account_id:a.id,name:a.name,opening_balance_milliunits:a.balance,ending_balance_milliunits:balance,minimum_balance_milliunits:minimum,first_shortfall:first,events:rows};
 });
 const months=[];let historyComplete=true;
 
 for(let i=input.history_months;i>=1;i--){
  const month=monthShift(snapshot.month,-i,1),entry=snapshot.historical_months?.find(m=>m.month===month);
  if(!entry||!Array.isArray(entry.categories)||(entry.categories.length===0&&active.length>0)){historyComplete=false;months.push({month,status:'unavailable'});continue;}
  let household=0,work=0,unknown=0;const rows=[];
  for(const row of entry.categories??[]){
   integer(row.activity);const c=all.get(row.id);
   if(!c){unknown=integer(unknown-row.activity);historyComplete=false;continue;}
   if(internal(c)||cards.has(c.id))continue;
   const net=-row.activity;
   if(excluded(c)){work=integer(work+net);continue;}
   household=integer(household+net);if(net)rows.push({category_id:c.id,name:c.name,net_outflow_milliunits:net,hidden_or_deleted:!!c.hidden||!!c.deleted});
  }
  months.push({month,status:'available',household_net_outflow_milliunits:household,excluded_net_outflow_milliunits:work,unclassified_net_outflow_milliunits:unknown,categories:rows});
 }
 const availableMonths=months.filter(m=>m.status==='available'),avg=availableMonths.length?integer(Math.round(sum(availableMonths.map(m=>m.household_net_outflow_milliunits))/availableMonths.length)):null;
 if(availableMonths.length<3)warnings.push({code:'short_history_window',message:'Fewer than three completed months may not reflect ordinary spending or seasonal costs.'});
 if(currentRows.some(c=>get(c.category_id).goal_type&&c.current_ynab_underfunded_milliunits===null))questions.push({code:'current_target_suggestions_missing'});
 if(!historyComplete)questions.push({code:'historical_coverage_incomplete'});
 const actualComplete=historyComplete&&avg!==null&&input.spending_window_representative_confirmed;
 if(!input.spending_window_representative_confirmed)questions.push({code:'spending_window_not_reviewed',message:'Review whether these completed months represent ordinary spending before an overall conclusion.'});
 const futureFunding=(snapshot.future_assigned_categories??[]).filter(r=>currentRows.some(c=>c.category_id===r.category_id));
 if(futureFunding.length)questions.push({code:'future_assignments_need_reconciliation',message:'Current funding gaps do not reconcile money already assigned in later months.',assignments:futureFunding});
 for(const issue of snapshot.issues??[])questions.push({code:'snapshot_schedule_issue',message:issue});
 const recurringComplete=input.income_coverage_confirmed&&income.length>0&&input.category_coverage_confirmed&&(!cards.size||input.debt_coverage_confirmed)&&!unresolved.length;
 const anyCashShortfall=cash.some(a=>a.first_shortfall);
 const reserveRows=(policy.card_floors??[]).filter(f=>all.has(f.category_id)).map(f=>{try{return {category_id:f.category_id,...cardReserve(all.get(f.category_id),f,snapshot,policy)};}catch(e){questions.push({code:'card_reserve_unknown',category_id:f.category_id,message:e.message});return {category_id:f.category_id,unknown:true};}});
 const currentGap=snapshot.ready_to_assign<0||currentRows.some(c=>c.overspending_milliunits>0)||reserveRows.some(r=>r.unknown||r.need_milliunits>0);
 const status=recurringComplete&&margin<0?'recurring_shortfall':input.income_coverage_confirmed&&actualComplete&&avg>reliable?'actual_spending_shortfall':timingComplete&&anyCashShortfall?'timing_shortfall':recurringComplete&&timingComplete&&actualComplete?(currentGap?'current_funding_gap':'supported_under_reviewed_assumptions'):'insufficient_evidence';
 const calendar=[];for(let m=monthStart(snapshot.as_of);m<=input.horizon_end;m=monthShift(m,1,1)){
  const deposits=incomeDates.filter(p=>monthStart(p.date)===m);
  calendar.push({month:m,forecast_reliable_income_milliunits:sum(deposits.filter(p=>p.certainty==='reliable').map(p=>p.amount_milliunits)),forecast_variable_income_milliunits:sum(deposits.filter(p=>p.certainty==='variable').map(p=>p.amount_milliunits)),deposit_count:deposits.length,events:deposits});
 }
 return {calculator_version:SUSTAINABILITY_VERSION,budget_id:snapshot.budget_id,as_of:snapshot.as_of,captured_at:snapshot.captured_at,server_knowledge:snapshot.server_knowledge,horizon_end:input.horizon_end,status,read_only:true,questions,warnings,
 ongoing:{coverage_confirmed:recurringComplete,reliable_net_income_monthly_average_milliunits:reliable,variable_net_income_monthly_average_milliunits:variable,uncertain_net_income_monthly_average_milliunits:uncertain,recurring_commitments_monthly_average_milliunits:monthlyCost,reliable_income_margin_milliunits:margin,margin_with_variable_income_milliunits:integer(reliable+variable-monthlyCost),income,categories:costs,unresolved_categories:unresolved},
 actual_spending:{history_complete:historyComplete,representative_window_confirmed:input.spending_window_representative_confirmed,months_available:availableMonths.length,months_requested:input.history_months,monthly_net_outflow_average_milliunits:avg,reliable_income_less_measured_spending_milliunits:avg===null?null:integer(reliable-avg),months,method:'Completed-month category activity, net of refunds. Card payment categories, internal categories and configured work exclusions are excluded. Hidden/deleted expense categories remain included where present. No parent/split transaction double-counting.'},
 current_funding:{card_reserves:reserveRows,target_suggestion_coverage_complete:!currentRows.some(c=>get(c.category_id).goal_type&&c.current_ynab_underfunded_milliunits===null),ready_to_assign_milliunits:snapshot.ready_to_assign,ynab_current_target_underfunding_milliunits:sum(currentRows.map(c=>c.current_ynab_underfunded_milliunits??0)),overspending_milliunits:sum(currentRows.map(c=>c.overspending_milliunits)),reviewed_remaining_need_topups_milliunits:sum(currentRows.map(c=>c.reviewed_topup_milliunits??0)),reviewed_need_category_count:currentRows.filter(c=>c.reviewed_topup_milliunits!==null).length,categories:currentRows,one_time_goals:oneTime,card_reserve_floors:(policy.card_floors??[]).map(f=>({category_id:f.category_id,floor_milliunits:f.floor_milliunits,available_milliunits:all.get(f.category_id)?.balance??null,shortfall_milliunits:all.has(f.category_id)?pos(f.floor_milliunits-all.get(f.category_id).balance):null})),future_assignments_unreconciled:futureFunding,combined_pressure_total:null},
 timing:{coverage_confirmed:timingComplete,conditional:true,same_day_order:'Outflows before inflows; verify actual deposit/payment ordering before relying on a same-day shortage.',calendar_income:calendar,accounts:cash,scheduled_obligation_candidates:copy((snapshot.obligations??[]).filter(o=>o.due_date<=input.horizon_end).slice(0,300)),scheduled_candidates_truncated:(snapshot.obligations??[]).length>300},
 limits:['Refill target averages represent planned spending capacity, not a promise to add the full amount anew each period. Current funding uses live YNAB suggestions; one-time spending uses funded-period progress rather than rebuilding spent balances.','Recurring averages use 52 weekly or 26 biweekly occurrences per year, rounded per item to milliunits. Dated forecasts count actual generated paydays.','Recurring targets are funding commitments, not necessarily cash expenses. Actual spending and current underfunding are separate views, not additional recurring costs.','Current target underfunding, overspending, dated goal gaps and reviewed remaining needs may overlap. No combined catch-up total is inferred.','Only reviewed cash events and reliable dated income enter bank forecasts. Include debt payments, transfers and work cash outflows when confirming coverage.','A positive result is conditional on the reviewed scope. It does not guarantee a target amount matches spending, account-level liquidity, or ongoing income.','No plan is saved, and no YNAB or household settings are changed.']};
}
