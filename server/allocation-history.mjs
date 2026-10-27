import {z} from 'zod';
import {date} from './allocation.mjs';
function dayAt(timestamp,timezone){
 const p=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp));
 return ['year','month','day'].map(k=>p.find(x=>x.type===k).value).join('-');
}
export function createAllocationHistory({budgetId,loader,store}){
 const root='budgets/'+budgetId+'/',prefix=root+'paycheck-results/';
 async function collect(){
  const config=await loader.load();
  if(typeof store.list!=='function')throw Error('History listing unavailable; refresh/deploy server tools');
  const names=await store.list(prefix);
  if(names.length>1000)throw Error('History exceeds current scan limit; no latest report inferred');
  const reports=[],warnings=[];
  for(let start=0;start<names.length;start+=16){
   const batch=await Promise.all(names.slice(start,start+16).map(async name=>{
    const match=new RegExp('^'+prefix+'([a-f0-9-]{36})\\.json$').exec(name);
    if(!match)return null;
    const r=await store.get(name);
    if(!r)throw Error('Report changed during lookup; retry read');
    if(r.status!=='verified_complete')return null;
    if(r.plan_id!==match[1]||(r.budget_id&&r.budget_id!==budgetId)||!Number.isFinite(Date.parse(r.completed_at??'')))throw Error('Invalid completed report; latest cannot be established');
    return {source:'cloud_storage',plan_id:r.plan_id,payday:r.payday??null,completed_on:dayAt(r.completed_at,config.settings.timezone??'UTC'),completed_at:r.completed_at,precision:'timestamp',_content:r};
   }));
   reports.push(...batch.filter(Boolean));
  }
  const seen=new Set();
  for(const r of config.history?.records??[]){
   if(r.status!=='completed')continue;
   date(r.date);
   if(r.file!=='ALLOCATION_'+r.date+'.md'||seen.has(r.file))throw Error('Invalid imported history index');
   seen.add(r.file);
   reports.push({source:'imported_github',record_date:r.date,payday:r.payday??null,completed_on:r.date,completed_at:null,precision:'date',file:r.file});
  }
  reports.sort((a,b)=>b.completed_on.localeCompare(a.completed_on)||(b.completed_at??'').localeCompare(a.completed_at??'')||(a.plan_id??a.file).localeCompare(b.plan_id??b.file));
  const active=await store.get(root+'write-lock.json');
  const receipt=active?.proposal_id?await store.get(root+'receipts/'+active.proposal_id+'.json'):null;
  if(active)warnings.push('A write is active or awaiting recovery. Completed history does not establish its outcome; inspect the receipt before further action.');
  return {config,reports,active_write:active,write_receipt:receipt,warnings};
 }
 const summary=r=>Object.fromEntries(Object.entries(r).filter(([k])=>k!=='_content'));
 return {
  async list(limit=20){
   if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Limit must be 1-100');
   const s=await collect();
   return {status:'ok',budget_id:budgetId,settings_revision:s.config.revision,order:'completion date in household timezone; timestamp within a known day',reports:s.reports.slice(0,limit).map(summary),total_completed:s.reports.length,has_more:s.reports.length>limit,active_write:s.active_write,write_receipt:s.write_receipt,warnings:s.warnings};
  },
  async latest(){
   const s=await collect(),first=s.reports[0];
   const base={budget_id:budgetId,settings_revision:s.config.revision,active_write:s.active_write,write_receipt:s.write_receipt,warnings:s.warnings};
   if(!first)return {...base,status:'none',report:null};
   const sameDay=s.reports.filter(r=>r.completed_on===first.completed_on);
   if(sameDay.length>1&&sameDay.some(r=>r.precision==='date'))return {...base,status:'ambiguous_latest',report:null,candidates:sameDay.map(summary),warnings:[...s.warnings,'Multiple completed reports share a date and at least one lacks completion time; exact latest order is unknown.']};
   const content=first.source==='cloud_storage'?first._content:await loader.history(first.record_date,s.config);
   return {...base,status:'found',report:{...summary(first),content},warnings:[...s.warnings,'Completed report is historical context; use fresh YNAB for current balances.']};
  }
 };
}
export function registerAllocationHistoryTools(server,service){
 const annotations={readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:true};
 const wrap=fn=>async args=>{try{const d=await fn(args);return {structuredContent:d,content:[{type:'text',text:JSON.stringify(d)}]};}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}};
 server.registerTool('get_latest_allocation_report',{description:'Automatically find and read the newest completed allocation across private verified Cloud Storage reports and imported GitHub history. Excludes drafts and incomplete results. Latest means completion date/time, not payday or object filename. Returns none or ambiguous_latest when latest cannot be established. Also reports active write/receipt state; never replays allocations.',annotations,inputSchema:z.object({budget_id:z.string().optional()})},wrap(()=>service.latest()));
 server.registerTool('list_allocation_reports',{description:'List completed allocation report summaries newest completion first across private storage and imported GitHub history. Includes source, payday when known, date precision and active write state. limit is 1-100. Does not mutate YNAB, reports or settings.',annotations,inputSchema:z.object({budget_id:z.string().optional(),limit:z.number().int().min(1).max(100).default(20)})},wrap(({limit})=>service.list(limit)));
}
