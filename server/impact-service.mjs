import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { date, addDays } from './allocation.mjs';
import { calculateImpacts, impactHorizon } from './impacts.mjs';
import { createWriteGate } from './write-gate.mjs';
const out=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
const err=message=>({isError:true,content:[{type:'text',text:message}]});
const uuid=z.string().uuid(), day=z.string().refine(value=>{try{date(value);return true;}catch{return false;}},'Use YYYY-MM-DD');
const money=z.number().finite().nonnegative().max(1e10).refine(n=>Math.abs(n*1000-Math.round(n*1000))<1e-6,'At most three decimal places');
const endpoint=z.union([uuid,z.literal('ready_to_assign')]);
const purchase=z.object({category_id:uuid,account_id:uuid,amount:money.positive(),date:day,counts_toward_remaining_need:z.boolean().default(false),distinct_from_recorded_confirmed:z.boolean().default(false)});
export const impactInputSchema=z.object({
 budget_id:z.string().optional(),next_payday:day,horizon_end:day.optional(),
 remaining_needs:z.array(z.object({category_id:uuid,amount:money})).max(200).default([]),
 bill_resolutions:z.array(z.object({category_id:uuid,status:z.enum(['paid_or_none_due','unpaid']),due_date:day.optional(),amount:money.optional()})).max(200).default([]),
 goals:z.array(z.object({category_id:uuid,due_date:day,required_balance:money,basis:z.enum(['auto','available_balance','target_progress']).default('auto'),include_payday_on_deadline:z.boolean().default(false)})).max(30).default([]),
 goal_order_confirmed:z.boolean().default(false),
 paychecks:z.array(z.object({date:day,amount:money,committed_amount:money,commitments_confirmed:z.boolean().default(false),account_id:uuid.optional()})).max(60).default([]),
 cash_events:z.array(z.object({date:day,account_id:uuid,amount:z.number().finite().min(-1e10).max(1e10),distinct_from_recorded_confirmed:z.boolean().default(false)})).max(300).default([]),
 cash_events_complete:z.boolean().default(false),
 scenarios:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),label:z.string().min(1).max(160),moves:z.array(z.object({from_category_id:endpoint,to_category_id:endpoint,amount:money.positive()})).max(100).default([]),purchase:purchase.optional()})).max(5).default([])
}).superRefine((input,ctx)=>{
 for(const row of input.bill_resolutions)if(row.status==='unpaid'&&(row.amount===undefined||!row.due_date))ctx.addIssue({code:'custom',message:'Unpaid bill resolutions require amount and due_date'});
});
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export function createImpactService({secret,budgetId,loader,store,snapshotReader,now=()=>Date.now()}){
 const root='budgets/'+budgetId+'/',planKey=id=>root+'impact-plans/'+uuid.parse(id)+'.json',resultKey=id=>root+'impact-results/'+uuid.parse(id)+'.json';
 const pointer=root+'impact-latest.json';
 async function state(){const active=await store.get(root+'write-lock.json');return {active_write:active,write_receipt:active?.proposal_id?await store.get(root+'receipts/'+uuid.parse(active.proposal_id)+'.json'):null};}
 async function analysis(raw,subject){
  if(!subject)throw Error('Authenticated household member required');
  const input=impactInputSchema.parse(raw);
  if(input.budget_id&&input.budget_id!==budgetId)throw Error('Wrong budget');
  input.budget_id=budgetId;
  const config=await loader.load();
  // Existing coherent snapshot reader takes an exclusive schedule horizon, independent of storage.
  const preliminaryEnd=input.horizon_end??input.goals.reduce((last,g)=>g.due_date>last?g.due_date:last,addDays(input.next_payday,28));
  const snapshot=await snapshotReader({settings:config.settings,next_payday:addDays(preliminaryEnd,1)});
  if(snapshot.budget_id!==budgetId)throw Error('Wrong snapshot budget');
  const result=calculateImpacts({snapshot,settings:config.settings,input});
  const recovery=await state();
  if(recovery.active_write)for(const option of result.options){option.execution_eligible=false;option.status='needs_review';option.blockers.push({code:'write_recovery_required'});}
  const fingerprint=createHash('sha256').update(canonical({version:result.calculator_version,input,revision:config.revision,state:snapshot.server_knowledge,as_of:snapshot.as_of,month:snapshot.month,recovery:recovery.active_write?.proposal_id??null})).digest('hex');
  return {config,snapshot,input,result:{...result,comparison_fingerprint:fingerprint,household_revision:config.revision,...recovery,allocation_context:{imported_completed_records:(config.history?.records??[]).filter(r=>r.status==='completed')},expires_at:new Date(now()+30*60000).toISOString()}};
 }
 async function load(id,subject){const plan=await store.get(planKey(id));if(!plan||plan.subject!==subject||plan.budget_id!==budgetId)throw Error('Impact plan unavailable for this user');return plan;}
 return {
  async compare(input,subject){return out((await analysis(input,subject)).result);},
  async prepare({comparison_input,comparison_fingerprint,scenario_id},subject){
   const current=await analysis(comparison_input,subject);
   if(current.result.comparison_fingerprint!==comparison_fingerprint)return out({status:'stale_comparison',message:'Baseline or inputs changed; compare again and review before preparing a plan.'});
   const option=current.result.options.find(o=>o.id===scenario_id);
   if(!option)throw Error('Unknown scenario');
   if(!option.execution_eligible)return out({status:'not_executable',blockers:option.blockers,message:'Only fully supported funding changes using current money can be prepared.'});
   const plan_id=randomUUID(),expires_at=new Date(now()+30*60000).toISOString();
   const plan={plan_id,status:'prepared',subject,budget_id:budgetId,as_of:current.snapshot.as_of,month:current.snapshot.month,created_at:new Date(now()).toISOString(),expires_at,household_revision:current.config.revision,server_knowledge:current.snapshot.server_knowledge,input:current.input,comparison_fingerprint,option,expected_card_balances:current.snapshot.categories.filter(c=>current.config.settings.allocation_policy.card_category_ids.includes(c.id)).map(c=>({category_id:c.id,balance:c.balance}))};
   if(!(await store.put(planKey(plan_id),plan,true)))throw Error('Plan storage collision');
   const {subject:_,...publicPlan}=plan;
   return out({...publicPlan,instructions:'Prepared funding plan only. Call execute_impact_plan with impacts_reviewed=true to obtain the exact server preview BEFORE requesting one final joint approval. Hypothetical purchases and forecast income are not written.'});
  },
  async inspect({plan_id},subject){
   if(!subject)throw Error('Authentication required');const recovery=await state();
   if(plan_id){const plan=await load(plan_id,subject),{subject:_,...publicPlan}=plan;return out({plan:publicPlan,result:await store.get(resultKey(plan_id)),...recovery});}
   const latest=await store.get(pointer);return out({latest_result:latest?.plan_id?await store.get(resultKey(latest.plan_id)):null,...recovery});
  },
  async execute(input,subject,executeAssignments){
   const p=await load(input.plan_id,subject);
   if(!input.preview_token&&input.impacts_reviewed!==true)return err('Review exact funding changes, goal consequences and cash/forecast limits before preparing an execution preview.');
   const guardedLoader={load:async()=>{const c=await loader.load();if(c.revision!==p.household_revision)throw Error('Household revision changed');return c;}};
   const guardedState=async()=>{
    if(Date.parse(p.expires_at)<now())throw Error('Impact plan expired');
    const c=await guardedLoader.load(),fresh=await snapshotReader({settings:c.settings,next_payday:addDays(impactHorizon(p.input,p.as_of),1)});
    if(fresh.server_knowledge!==p.server_knowledge||fresh.as_of!==p.as_of||fresh.month!==p.month)throw Error('YNAB state or calendar changed since comparison');
    return fresh.server_knowledge;
   };
   const gate=createWriteGate({secret,budgetId,loader:guardedLoader,store,stateReader:guardedState,now});
   const result=await gate.run('execute_impact_plan',{budget_id:budgetId,plan_id:p.plan_id,assignments:p.option.assignments,preview_token:input.preview_token,both_partners_agree:input.both_partners_agree},subject,async operation=>{
    const written=await executeAssignments({budget_id:budgetId,assignments:operation.assignments});
    await store.put(resultKey(p.plan_id),{status:'write_returned_needs_verification',plan_id:p.plan_id,submitted_at:new Date(now()).toISOString(),upstream_result:written});
    let payload=written.structuredContent;if(!payload){try{payload=JSON.parse(written.content?.find(c=>c.type==='text')?.text??'null');}catch{}}
    if(written.isError||payload?.results?.length!==operation.assignments.length||payload.results.some(r=>r.status!=='updated'))return {...out({status:'needs_review',message:'Impact funding write may have partially completed. Inspect the receipt and current budget before any retry.',upstream_result:written}),isError:true};
    const config=await guardedLoader.load(),fresh=await snapshotReader({settings:config.settings,next_payday:addDays(impactHorizon(p.input,p.as_of),1)});
    for(const row of p.option.rows){const c=fresh.categories.find(c=>c.id===row.category_id);if(!c||c.budgeted!==row.assigned_after_milliunits||c.balance!==row.funding_available_after_milliunits)throw Error('Impact post-write category verification differs');}
    if(fresh.ready_to_assign!==p.option.ready_to_assign_after_funding_milliunits)throw Error('Impact post-write RTA differs');
    for(const row of p.expected_card_balances)if(fresh.categories.find(c=>c.id===row.category_id)?.balance!==row.balance)throw Error('Unexpected automatic card reserve change; reconcile outcome');
    const completed={status:'verified_complete',plan_id:p.plan_id,completed_at:new Date(now()).toISOString(),household_revision:p.household_revision,calculator_version:'impacts-1.1.0',execution_scope:'category funding only',option:p.option,server_knowledge:fresh.server_knowledge,remaining_milliunits:fresh.ready_to_assign,upstream_result:written};
    await store.put(resultKey(p.plan_id),completed);await store.put(pointer,{plan_id:p.plan_id,completed_at:completed.completed_at});return out(completed);
   });
   if(result.structuredContent?.status==='preview_only')result.structuredContent.plan_id=p.plan_id;
   return result;
  }
 };
}
export function registerImpactTools(server,{service,subject,executeAssignments}){
 const wrap=fn=>async input=>{try{return await fn(input);}catch(e){return err(e.message);}};
 const read={readOnlyHint:true,destructiveHint:false,openWorldHint:true,idempotentHint:true};
 server.registerTool('compare_impacts',{description:'Read-only comparison of explicit one-time purchase/reallocation options against one coherent current snapshot. Empty scenarios returns baseline/context. Currency-unit inputs; output money fields ending _milliunits divide by 1000. Future paychecks require explicit prior commitments and remain conditional. Goal basis auto uses live funding progress for one-time spending targets; available_balance explicitly requires an unspent balance. Supply the full live target amount for target_progress. No recurrence guesses or automatic ranking. Does not save a plan or mutate YNAB. Returned comparison_fingerprint binds later plan preparation to the same inputs/state. Read household rules and latest completed allocation first.',annotations:read,inputSchema:impactInputSchema},wrap(input=>service.compare(input,subject)));
 server.registerTool('prepare_impact_plan',{description:'Save a user-bound funding draft for a selected executable comparison option. No YNAB writes. Supply the original comparison_input, comparison_fingerprint and scenario_id. A stale comparison must be refreshed/reviewed. Only current-month funding from existing money is executable; future purchases and forecast income stay hypothetical.',annotations:{...read,readOnlyHint:false,idempotentHint:false},inputSchema:z.object({budget_id:z.string().optional(),comparison_input:impactInputSchema,comparison_fingerprint:z.string().regex(/^[a-f0-9]{64}$/),scenario_id:z.string()})},wrap(input=>service.prepare(input,subject)));
 server.registerTool('get_impact_plan',{description:'Read your prepared impact plan/result by plan_id, or the household latest completed impact report when plan_id is omitted. Includes active shared write lock/receipt for recovery. Missing state is not proof that an uncertain write never happened.',annotations:read,inputSchema:z.object({budget_id:z.string().optional(),plan_id:uuid.optional()})},wrap(input=>service.inspect(input,subject)));
 if(executeAssignments)server.registerTool('execute_impact_plan',{description:'Execute only a stored impact funding plan. First call with impacts_reviewed=true returns exact preview, with no YNAB changes. Show it and obtain one explicit configured joint approval. Then submit the same plan_id/preview_token and both_partners_agree=true without asking again for an unchanged valid approved preview. Stale state/settings/calendar/expiry blocks; partial outcomes keep recovery lock. Applies and verifies category funding only, never hypothetical purchases, future income, targets or bank payments.',annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:true,idempotentHint:true},inputSchema:z.object({budget_id:z.string().optional(),plan_id:uuid,impacts_reviewed:z.boolean().optional(),preview_token:z.string().max(10000).optional(),both_partners_agree:z.boolean().optional()})},wrap(input=>service.execute(input,subject,executeAssignments)));
}
