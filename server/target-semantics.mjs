// Shared target interpretation. No I/O and no household-specific category values.
const integer=(n,label='target amount')=>{if(!Number.isSafeInteger(n))throw Error('Invalid '+label);return n;};
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0?n:null;
export function normalizeTarget(c){
 const type=c.goal_type??null,code=c.goal_cadence,f=c.goal_cadence_frequency??1;
 let unit=null,every=null;
 if(code===0){unit='once';every=1;}
 else if(code===1){unit='month';every=f;}
 else if(code===2){unit='week';every=f;}
 else if(Number.isInteger(code)&&code>=3&&code<=12){unit='month';every=code-1;}
 else if(code===13){unit='year';every=f;}
 else if(code===14){unit='year';every=2;}
 if(!Number.isInteger(every)||every<1){unit=null;every=null;}
 const kind=type==='NEED'?'spending':type==='MF'?'contribution':['TB','TBD'].includes(type)?'balance':type==='DEBT'?'debt':type?'unsupported':'none';
 if(kind==='contribution'){unit='month';every=1;}
 if(kind==='balance'){unit='once';every=1;}
 const behavior=kind==='balance'?'have_balance':kind==='contribution'?'set_aside':kind==='spending'?(c.goal_needs_whole_amount===true?'set_aside':c.goal_needs_whole_amount===false?'refill':'unknown'):'unknown';
 return {kind,type,behavior,amount_milliunits:nonnegative(c.goal_target),period_unit:unit,every,recurring:unit===null?null:unit!=='once',deadline:c.goal_target_date??null,creation_month:c.goal_creation_month??null,snoozed:!!c.goal_snoozed_at,needs_whole_amount:c.goal_needs_whole_amount??null,raw_cadence:code??null,raw_cadence_frequency:c.goal_cadence_frequency??null,current_underfunded_milliunits:nonnegative(c.goal_under_funded),period_funded_milliunits:nonnegative(c.goal_overall_funded),period_left_milliunits:nonnegative(c.goal_overall_left)};
}
export function remainingTargetFunding(c){
 const n=normalizeTarget(c);
 if(n.amount_milliunits===null)return null;
 if(n.kind==='balance')return Math.max(0,integer(n.amount_milliunits-integer(c.balance)));
 if(n.kind==='spending'&&n.recurring===false){
  if(n.period_left_milliunits!==null)return n.period_left_milliunits;
  if(n.period_funded_milliunits!==null)return Math.max(0,n.amount_milliunits-n.period_funded_milliunits);
  return null;
 }
 return n.current_underfunded_milliunits;
}
export function targetRecurrence(c){
 const n=normalizeTarget(c);
 if(!['spending','contribution'].includes(n.kind)||n.amount_milliunits===null||n.recurring!==true)return null;
 return {amount:n.amount_milliunits,cadence:{week:'weekly',month:'monthly',year:'annual'}[n.period_unit],every:n.every,source:n.kind==='contribution'?'monthly_funding_target':'spending_target',behavior:n.behavior,target:n};
}
export function isWeeklyRefill(c){const n=normalizeTarget(c);return n.kind==='spending'&&n.behavior==='refill'&&n.period_unit==='week'&&n.every===1&&n.amount_milliunits!==null&&n.amount_milliunits>0;}
export function targetDrivenCategories(categories,policy){
 const p=policy.target_driven_essentials;if(!p)return [];
 const list=categories.filter(c=>p.group_ids.includes(c.category_group_id)&&!c.hidden&&!c.deleted&&!c.internal);
 const rank=new Map(p.priority_category_ids.map((id,i)=>[id,i]));
 return list.sort((a,b)=>(rank.get(a.id)??1e6)-(rank.get(b.id)??1e6)||a.id.localeCompare(b.id));
}
export function registerTargetDetails(server,{snapshotReader,loader,budgetId,subject}){
 server.registerTool('get_target_details',{description:'Read complete live target semantics: refill/set-aside/balance behavior, repeat unit and full interval (including quarterly), deadlines, funded/spent-period progress and current underfunding. Does not save or change anything. Output *_milliunits divide by 1000. Older get_targets summaries omit custom repeat frequency; prefer this tool for behavior/recurrence.',annotations:{readOnlyHint:true,idempotentHint:true,destructiveHint:false,openWorldHint:true},inputSchema:{}},async()=>{
  try{if(!subject)throw Error('Authentication required');const config=await loader.load();if(config.settings?.budget?.id!==budgetId)throw Error('Household budget mismatch');const snapshot=await snapshotReader({settings:config.settings,next_payday:new Date(Date.now()+2*86400000).toISOString().slice(0,10)});
   if(snapshot.budget_id!==budgetId)throw Error('Budget mismatch');
   const data={budget_id:budgetId,as_of:snapshot.as_of,server_knowledge:snapshot.server_knowledge,household_revision:config.revision,categories:snapshot.categories.filter(c=>!c.hidden&&!c.deleted&&!c.internal).map(c=>({category_id:c.id,name:c.name,group_id:c.category_group_id,group:c.category_group_name,available_milliunits:c.balance,target:normalizeTarget(c),remaining_target_funding_milliunits:remainingTargetFunding(c)}))};
   return {content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};
  }catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
 });
}

export function cardReserve(c,f,snapshot,policy,requested=f.floor_milliunits){
 const reserve=integer(requested,'card reserve');if(reserve<0)throw Error('Negative card reserve');
 if(policy.card_reserve_mode!=='debt_capped_reviewed')return {desired_milliunits:reserve,need_milliunits:Math.max(0,reserve-(c.projected??c.balance)),debt_milliunits:null,gap_milliunits:null};
 const a=snapshot.accounts?.find(a=>a.id===f.account_id&&a.on_budget&&!a.closed&&!a.deleted&&['creditCard','lineOfCredit'].includes(a.type));
 if(!a)throw Error('Verified card-account mapping missing');
 const debt=Math.max(0,-integer(a.balance)),available=integer(c.projected??c.balance),gap=Math.max(0,debt-available),desired=Math.min(debt,reserve);
 return {account_id:a.id,debt_milliunits:debt,gap_milliunits:gap,desired_milliunits:desired,need_milliunits:gap>0?Math.max(0,desired-available):0};
}
