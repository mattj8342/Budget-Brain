import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { calculatePaycheck, integer, date, addDays, milliunits } from './allocation.mjs';
import { createWriteGate } from './write-gate.mjs';
const out=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
const err=message=>({isError:true,content:[{type:'text',text:message}]});
const money=z.number().finite().nonnegative().max(1e10);
const uuid=z.string().uuid();
export const planSchema=z.object({
 budget_id:z.string().optional(),payday:z.string(),next_payday:z.string(),
 mode:z.enum(['new_payday','catch_up']).default('new_payday'),
 income_transaction_ids:z.array(uuid).min(1).max(20),
 bill_resolutions:z.array(z.object({category_id:uuid,status:z.enum(['paid_or_none_due','unpaid']),due_date:z.string().optional(),amount:money.optional()})).max(200).default([]),
 catch_up_topups:z.array(z.object({category_id:uuid,available_goal:money})).max(100).default([]),
 weekly_contributions:z.array(z.object({category_id:uuid,already_contributed:money})).max(200).default([]),
 card_gap_reviews:z.array(uuid).max(50).default([]),
 remaining_choices:z.array(z.object({category_id:uuid,amount:money})).max(100).default([]),
 floor_overrides:z.array(z.object({category_id:uuid,floor:money})).max(50).default([])
});
function localDate(now,timezone){
 const p=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 return ['year','month','day'].map(k=>p.find(x=>x.type===k).value).join('-');
}
function nextOccurrence(d,f,anchorDay=Number(d.slice(8,10))){
 const days={daily:1,weekly:7,everyOtherWeek:14,every4Weeks:28};
 if(days[f])return addDays(d,days[f]);
 const months={monthly:1,everyOtherMonth:2,every3Months:3,every4Months:4,twiceAYear:6,yearly:12,everyOtherYear:24};
 if(months[f]){
  const [y,m,day]=d.split('-').map(Number),start=new Date(Date.UTC(y,m-1+months[f],1));
  return new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth(),Math.min(anchorDay,new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,0)).getUTCDate()))).toISOString().slice(0,10);
 }
 if(f==='never')return null;
 throw Error('Unsupported scheduled frequency '+f+'; resolve its obligations explicitly');
}
export function snapshotFromBudget(data,{timezone,now=new Date(),next_payday}){
 const b=data.budget??data.plan;if(!b||!Number.isSafeInteger(data.server_knowledge))throw Error('Missing full YNAB budget/version');
 const as_of=localDate(now,timezone),month=as_of.slice(0,7)+'-01';date(next_payday);
 const current=b.months?.find(m=>m.month===month&&!m.deleted);
 if(!current?.categories)throw Error('Current budget month missing');
 const groups=new Map((b.category_groups??[]).map(g=>[g.id,g]));
 const roots=new Map((b.categories??[]).map(c=>[c.id,c]));
 const categories=current.categories.map(c=>({...roots.get(c.id),...c,hidden:!!c.hidden||!!groups.get(c.category_group_id)?.hidden,category_group_name:groups.get(c.category_group_id)?.name??c.category_group_name}));
 const accounts=(b.accounts??[]).filter(a=>!a.deleted&&!a.closed);
 const credit=new Set(accounts.filter(a=>['creditCard','lineOfCredit'].includes(a.type)).map(a=>a.id));
 const tx=(b.transactions??[]).filter(t=>!t.deleted);
 const parents=new Map(tx.map(t=>[t.id,t]));
 const creditCats=new Set(tx.filter(t=>t.date>=month&&t.date<=as_of&&t.amount<0&&credit.has(t.account_id)).map(t=>t.category_id));
 for(const t of b.subtransactions??[]){const p=parents.get(t.transaction_id);if(!t.deleted&&p&&p.date>=month&&p.date<=as_of&&t.amount<0&&credit.has(p.account_id))creditCats.add(t.category_id);}
 const obligations=[],issues=[];
 for(const s of (b.scheduled_transactions??[]).filter(s=>!s.deleted&&s.amount<0&&!s.transfer_account_id)){
  let due=s.date_next;
  try{
   for(let i=0;due&&due<next_payday&&i<400;i++){
    date(due);
    if(due>=as_of || i===0){
     const splits=(b.scheduled_subtransactions??[]).filter(t=>!t.deleted&&t.scheduled_transaction_id===s.id);
     if(!s.category_id&&!splits.length)issues.push('Uncategorized scheduled outflow '+s.id);
     for(const t of splits.length?splits:[s]){
      if(t.amount<0&&!t.transfer_account_id)obligations.push({category_id:t.category_id,account_id:s.account_id,due_date:due,amount_milliunits:-integer(t.amount),scheduled_id:s.id});
     }
    }
    due=nextOccurrence(due,s.frequency,Number(s.date_next.slice(8,10)));
   }
   if(due&&due<next_payday)issues.push('Schedule expansion limit '+s.id);
  }catch(e){issues.push(e.message);}
 }
 const future=(b.months??[]).filter(m=>!m.deleted&&m.month>=month).map(m=>integer(m.to_be_budgeted,'future RTA'));
 return {budget_id:b.id,budget_name:b.name,month,as_of,captured_at:now.toISOString(),server_knowledge:data.server_knowledge,
  ready_to_assign:Math.min(integer(current.to_be_budgeted),...future),categories,accounts,transactions:tx,obligations,issues,
  category_catalog:[...roots.values()].map(c=>({...c,category_group_name:groups.get(c.category_group_id)?.name})),historical_months:(b.months??[]).filter(m=>!m.deleted&&m.month<month).sort((a,b)=>b.month.localeCompare(a.month)).slice(0,12).map(m=>({month:m.month,categories:(m.categories??[]).map(c=>({id:c.id,activity:c.activity}))})),credit_spending_category_ids:[...creditCats],future_assigned_categories:(b.months??[]).filter(m=>!m.deleted&&m.month>month).flatMap(m=>(m.categories??[]).filter(c=>!c.deleted&&c.budgeted!==0).map(c=>({month:m.month,category_id:c.id,assigned_milliunits:c.budgeted}))),currency_format:b.currency_format};
}
export function createYnabSnapshotReader({accessToken,budgetId,fetchImpl=fetch,now=()=>new Date()}){
 return async ({settings,next_payday})=>{
  const r=await fetchImpl('https://api.ynab.com/v1/budgets/'+budgetId,{headers:{Authorization:'Bearer '+accessToken},signal:AbortSignal.timeout(25000),redirect:'error'});
  if(!r.ok)throw Error('Fresh YNAB snapshot unavailable (HTTP '+r.status+')');
  const data=await r.json();
  const snapshot=snapshotFromBudget(data.data,{timezone:settings.timezone??'UTC',next_payday,now:now()});
  if(snapshot.budget_id!==budgetId)throw Error('Snapshot budget mismatch');
  return snapshot;
 };
}
export function createPaycheckService({secret,budgetId,loader,store,snapshotReader,stateReader,now=()=>Date.now()}){
 const root='budgets/'+budgetId+'/';
 const key=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid plan ID');return root+'paycheck-plans/'+id+'.json';};
 const cycle=payday=>root+'paycheck-cycles/'+date(payday)+'.json';
 async function loadPlan(id,subject){
  const p=await store.get(key(id));if(!p||p.subject!==subject||p.budget_id!==budgetId)throw Error('Plan unavailable for this user');
  return p;
 }
 return {
  async plan(input,subject){
   if(!subject)throw Error('Authenticated household member required');
   if(input.budget_id&&input.budget_id!==budgetId)throw Error('Wrong budget');
   const config=await loader.load(),policy=config.settings.allocation_policy;
   const snapshot=await snapshotReader({settings:config.settings,next_payday:input.next_payday});
   if(snapshot.budget_id!==budgetId)throw Error('Wrong snapshot budget');
   const existing=await store.get(cycle(input.payday));
   const importedCompleted=(config.history?.records??[]).filter(r=>r.status==='completed'&&(r.payday??r.date)>=input.payday&&(r.payday??r.date)<input.next_payday);
   const selected=new Set(input.income_transaction_ids);
   if(selected.size!==input.income_transaction_ids.length)throw Error('Duplicate income IDs');
   const deposits=snapshot.transactions.filter(t=>selected.has(t.id));
   if(deposits.length!==selected.size||deposits.some(t=>t.deleted||t.transfer_account_id||t.category_id!==policy?.rta_category_id||t.amount<=0||t.date<input.payday||t.date>snapshot.as_of||!snapshot.accounts.some(a=>a.id===t.account_id&&a.on_budget)))throw Error('Select actual received on-budget RTA inflows in this cycle; forecast income and transfers cannot be assigned');
   const result=calculatePaycheck({snapshot,policy,payday:input.payday,next_payday:input.next_payday,mode:input.mode,
    bill_resolutions:input.bill_resolutions.map(b=>({...b,amount_milliunits:b.amount===undefined?undefined:milliunits(b.amount)})),
    catch_up_topups:input.catch_up_topups.map(t=>({...t,available_goal_milliunits:milliunits(t.available_goal)})),
    remaining_choices:input.remaining_choices.map(t=>({...t,amount_milliunits:milliunits(t.amount)})),
    weekly_contributions:(input.weekly_contributions??[]).map(t=>({...t,already_contributed_milliunits:milliunits(t.already_contributed)})),card_gap_reviews:input.card_gap_reviews??[],
    floor_overrides:input.floor_overrides.map(t=>({...t,floor_milliunits:milliunits(t.floor)}))});
   if(input.mode==='new_payday'&&(existing||importedCompleted.length))result.questions.push({code:'completed_cycle',message:'This cycle has allocation history. Review it and use catch_up with verified remaining needs; do not repeat a full payday refill.'});
   if(await store.get(root+'write-lock.json'))result.questions.push({code:'write_recovery',message:'A write is active or awaiting reconciliation. Inspect durable receipt before proceeding.'});
   for(const message of snapshot.issues??[])result.questions.push({code:'snapshot_obligation',message});
   if(result.questions.length){result.status='needs_clarification';result.assignments=[];}
   result.household_revision=config.revision;result.expires_at=new Date(now()+30*60000).toISOString();
   result.received_income_milliunits=deposits.reduce((n,t)=>integer(n+t.amount),0);
   result.income_transactions=deposits.map(t=>({id:t.id,date:t.date,amount_milliunits:t.amount,cleared:t.cleared}));
   result.history={imported:importedCompleted,durable_cycle:existing};
   result.account_cash=snapshot.accounts.map(a=>({id:a.id,name:a.name,type:a.type,balance_milliunits:a.balance,cleared_balance_milliunits:a.cleared_balance,uncleared_balance_milliunits:a.uncleared_balance}));
   result.scheduled_outflows=snapshot.obligations;
   result.cash_review_required=true;
   if(result.status==='calculated'&&result.assignments.length){
    const plan_id=randomUUID();result.plan_id=plan_id;
    await store.put(key(plan_id),{...result,subject,created_at:new Date(now()).toISOString()},true);
   }
   return out(result);
  },
  async inspect({plan_id,payday},subject){
   if(!subject)throw Error('Authentication required');
   const active=await store.get(root+'write-lock.json');
   const receipt=active?.proposal_id?await store.get(root+'receipts/'+active.proposal_id+'.json'):null;
   if(plan_id){
    const p=await loadPlan(plan_id,subject);
    const receipts=await store.get(root+'paycheck-results/'+plan_id+'.json');
    return out({plan:p,result:receipts,active_write:active,write_receipt:receipt});
   }
   if(!payday)throw Error('Supply plan_id or payday');
   const saved=await store.get(cycle(payday));
   return out({payday,cycle:saved,result:saved?.latest_plan_id?await store.get(root+'paycheck-results/'+saved.latest_plan_id+'.json'):null,active_write:active,write_receipt:receipt});
  },
  async execute(input,subject,executeAssignments){
   const p=await loadPlan(input.plan_id,subject);
   // Gate receipts are checked before stale-state checks on a repeated confirmation.
   const guardedLoader={load:async()=>{const c=await loader.load();if(c.revision!==p.household_revision)throw Error('Household revision changed');return c;}};
   const guardedState=async()=>{if(Date.parse(p.expires_at)<now())throw Error('Plan expired');const s=await stateReader();if(s!==p.server_knowledge)throw Error('YNAB changed since calculation; recalculate');return s;};
   const gate=createWriteGate({secret,budgetId,loader:guardedLoader,store,stateReader:guardedState,now});
   const operation={budget_id:budgetId,plan_id:p.plan_id,assignments:p.assignments,preview_token:input.preview_token,both_partners_agree:input.both_partners_agree};
   if(!input.preview_token && input.cash_and_bills_reviewed!==true)return err('Review paying-account cash, bill resolutions and unsettled income before requesting an execution preview.');
   const result=await gate.run('execute_paycheck_plan',operation,subject,async args=>{
    const old=await store.get(cycle(p.payday));
    if(p.mode==='new_payday'&&old)throw Error('Payday already recorded; do not replay');
    // Keep the same global lock and durable write receipt through mutation and verification.
    const written=await executeAssignments({budget_id:budgetId,assignments:args.assignments});
    if(written.isError)return written;
    let payload=written.structuredContent;
    if(!payload){try{payload=JSON.parse(written.content.find(c=>c.type==='text').text);}catch{throw Error('Cannot verify write response');}}
    if(payload.results?.some(r=>r.status!=='updated'))return err('One or more category assignments failed or partially completed. Reconcile before retrying.');
    const fresh=await snapshotReader({settings:(await loader.load()).settings,next_payday:p.next_payday});
    for(const row of p.rows){const c=fresh.categories.find(c=>c.id===row.category_id);if(!c||c.budgeted!==row.assigned_after_milliunits||c.balance!==row.projected_available_milliunits)throw Error('Post-write verification differs; reconcile outcome');}
    if(fresh.ready_to_assign!==p.remaining_milliunits)throw Error('Post-write RTA differs; reconcile outcome');
    const completed={status:'verified_complete',plan_id:p.plan_id,payday:p.payday,mode:p.mode,completed_at:new Date(now()).toISOString(),household_revision:p.household_revision,rows:p.rows,remaining_milliunits:fresh.ready_to_assign,server_knowledge:fresh.server_knowledge,upstream_result:written};
    await store.put(root+'paycheck-results/'+p.plan_id+'.json',completed);
    await store.put(cycle(p.payday),{payday:p.payday,latest_plan_id:p.plan_id,status:'verified_complete',completed_plan_ids:[...(old?.completed_plan_ids??[]),p.plan_id],updated_at:completed.completed_at});
    return out(completed);
   });
   if(result.structuredContent?.status==='preview_only')result.structuredContent.plan_id=p.plan_id;
   return result;
  }
 };
}
export function registerPaycheckTools(server,{service,subject,executeAssignments}){
 const wrap=fn=>async input=>{try{return await fn(input);}catch(e){return err(e.message);}};
 server.registerTool('plan_paycheck',{description:'Calculate a paycheck proposal from a fresh YNAB snapshot and private household hierarchy. No YNAB writes. Start with get_household_settings and allocation history; resolve returned questions then recalculate. Amount inputs are currency units; result money fields ending _milliunits divide by 1000. Forecast income is never available money.',annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:false},inputSchema:planSchema},wrap(input=>service.plan(input,subject)));
 server.registerTool('get_paycheck_plan',{description:'Read a saved calculator plan, verified result, cycle completion or active write lock. Use after timeout before any retry. Does not mutate YNAB.',annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:true},inputSchema:z.object({budget_id:z.string().optional(),plan_id:uuid.optional(),payday:z.string().optional()})},wrap(input=>service.inspect(input,subject)));
 if(executeAssignments)server.registerTool('execute_paycheck_plan',{description:'Execute only a stored calculated paycheck plan. Prepare the exact signed preview with plan_id and cash_and_bills_reviewed=true before asking for final approval. Show the plan table and obtain one explicit joint approval. If this unchanged valid preview is already approved, submit it without asking again with the same plan_id, preview_token and both_partners_agree=true. Stale plans fail; uncertain outcomes keep durable lock. Never retry using a fresh plan after uncertain writes.',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true,idempotentHint:true},inputSchema:z.object({budget_id:z.string().optional(),plan_id:uuid,cash_and_bills_reviewed:z.boolean().optional(),preview_token:z.string().max(10000).optional(),both_partners_agree:z.boolean().optional()})},wrap(input=>service.execute(input,subject,executeAssignments)));
}
