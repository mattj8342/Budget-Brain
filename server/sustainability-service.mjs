import {z} from 'zod';
import {addDays,date} from './allocation.mjs';
import {analyzeSustainability} from './sustainability.mjs';
const uuid=z.string().uuid(),day=z.string().refine(v=>{try{date(v);return true;}catch{return false;}},'Use YYYY-MM-DD');
const money=z.number().finite().min(0).max(1e10).refine(v=>Math.abs(v*1000-Math.round(v*1000))<1e-6,'At most three decimals');
const signed=money.or(z.number().finite().min(-1e10).max(0).refine(v=>Math.abs(v*1000-Math.round(v*1000))<1e-6));
const cadence=z.enum(['weekly','biweekly','semimonthly','monthly','quarterly','annual']),certainty=z.enum(['reliable','variable','uncertain']);
const income=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),label:z.string().min(1).max(100),amount:money,cadence,every:z.number().int().min(1).max(120).default(1),certainty,next_date:day.optional(),account_id:uuid.optional(),paydays:z.array(z.number().int().min(1).max(31)).length(2).optional()});
export const sustainabilitySchema=z.object({
 budget_id:z.string().optional(),horizon_end:day.optional(),history_months:z.number().int().min(1).max(12).default(3),spending_window_representative_confirmed:z.boolean().default(false),
 income_streams:z.array(income).max(30).default([]),income_coverage_confirmed:z.boolean().default(false),category_coverage_confirmed:z.boolean().default(false),debt_coverage_confirmed:z.boolean().default(false),
 debt_paydown:z.array(z.object({card_category_id:uuid,amount:money,cadence,every:z.number().int().min(1).max(120).default(1),reason:z.string().min(1).max(200)})).max(50).default([]),
 income_adjustments:z.array(z.object({stream_id:z.string(),date:day,amount:money,certainty,reason:z.string().min(1).max(160)})).max(100).default([]),
 one_time_income:z.array(z.object({id:z.string().min(1).max(50),label:z.string().min(1).max(100),date:day,amount:money,certainty,account_id:uuid.optional(),distinct_from_forecast_confirmed:z.boolean().default(false)})).max(100).default([]),
 category_reviews:z.array(z.object({category_id:uuid,classification:z.enum(['recurring','one_time','excluded']),amount:money.optional(),cadence:cadence.optional(),every:z.number().int().min(1).max(120).default(1),reason:z.string().min(1).max(200),remaining_available:money.optional(),required_balance:money.optional(),due_date:day.optional()})).max(500).default([]),
 cash_events:z.array(z.object({id:z.string().min(1).max(60),label:z.string().min(1).max(100),date:day,account_id:uuid,amount:signed,kind:z.enum(['expense','debt_payment','other']),certainty:certainty.default('reliable'),distinct_from_registered_confirmed:z.boolean().default(false)})).max(500).default([]),
 transfers:z.array(z.object({date:day,from_account_id:uuid,to_account_id:uuid,amount:money.positive(),distinct_from_registered_confirmed:z.boolean().default(false)})).max(100).default([]),
 cash_flow_coverage_confirmed:z.boolean().default(false)
}).superRefine((v,ctx)=>{for(const r of v.category_reviews)if(r.classification==='recurring'&&(r.amount===undefined||!r.cadence))ctx.addIssue({code:'custom',message:'Recurring reviews require amount and cadence'});for(const s of v.income_streams)if(s.cadence==='semimonthly'&&(!s.paydays||s.every!==1))ctx.addIssue({code:'custom',message:'Semimonthly income requires two paydays and every=1'});});
export function createSustainabilityService({budgetId,loader,snapshotReader,store}){
 return {async analyze(raw,subject){
  if(!subject)throw Error('Authenticated household member required');
  const input=sustainabilitySchema.parse(raw);if(input.budget_id&&input.budget_id!==budgetId)throw Error('Wrong budget');input.budget_id=budgetId;
  const config=await loader.load();
  // Default horizon is computed by snapshot local date, not caller/host timezone.
  const initial=input.horizon_end??addDays(new Date().toISOString().slice(0,10),92);
  const snapshot=await snapshotReader({settings:config.settings,next_payday:addDays(initial,1)});
  if(snapshot.budget_id!==budgetId)throw Error('Wrong snapshot budget');
  input.horizon_end??=addDays(snapshot.as_of,90);
  const result=analyzeSustainability({snapshot,settings:config.settings,input});
  result.active_write=store?await store.get('budgets/'+budgetId+'/write-lock.json'):null;
  result.recovery_state_checked=!!store;
  if(result.active_write){result.status='needs_reconciliation';result.questions.push({code:'write_recovery_required',message:'Reconcile the active write before relying on a whole-budget conclusion.'});}
  return {content:[{type:'text',text:JSON.stringify({...result,household_revision:config.revision})}],structuredContent:{...result,household_revision:config.revision}};
 }};
}
export function registerSustainabilityTools(server,{service,subject}){
 server.registerTool('check_sustainability',{description:'Read-only whole-budget review using one fresh YNAB snapshot and household rules. Separates recurring income/target commitments, historical net spending, current funding needs and reviewed dated bank cash flow. Empty input returns available evidence and questions, not a sustainability assurance. Currency inputs; output *_milliunits divide by 1000. Review income reliability, target cadence and cash coverage; forecast income is never assignable today. No plan, report, draft, YNAB or settings writes. Use Explore Impacts for a specific change or Assign Paycheck for received income.',annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:true},inputSchema:sustainabilitySchema},async input=>{try{return await service.analyze(input,subject);}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});
}
