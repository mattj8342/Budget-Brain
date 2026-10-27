import { createHmac,randomUUID,timingSafeEqual,createHash } from 'node:crypto';
import { z } from 'zod';
export const WRITE_TOOLS = new Set(['create_transactions','update_transactions','delete_transactions','set_category_budgets','set_category_targets','create_scheduled_transactions','update_scheduled_transactions','delete_scheduled_transactions','undo_operations','execute_paycheck_plan','apply_transaction_changes','execute_impact_plan']);
const canonical=value=>JSON.stringify(value,(_,v)=>v && typeof v==='object' && !Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const output=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
const error=message=>({isError:true,content:[{type:'text',text:message}]});
export function createWriteGate({secret,budgetId,loader,store,stateReader,now=()=>Date.now()}) {
  const key=createHmac('sha256',secret).update('budget-brain-full-write-v1').digest();
  const sign=s=>createHmac('sha256',key).update(s).digest('base64url');
  const lock=`budgets/${budgetId}/write-lock.json`;
  return {
    async run(name,args,subject,execute){
      const {preview_token,both_partners_agree,...operation}=args;
      if(!subject || !WRITE_TOOLS.has(name)) return error('Write is not permitted.');
      if(operation.budget_id!==budgetId) return error('Explicit configured budget required.');
      try {
        const config=await loader.load();
        const digest=createHash('sha256').update(canonical({name,operation})).digest('hex');
        if(!preview_token){
          const state=await stateReader();
          const proposal={v:1,id:randomUUID(),subject,budgetId,digest,revision:config.revision,state,expires:now()+30*60000};
          const encoded=Buffer.from(JSON.stringify(proposal)).toString('base64url');
          return output({status:'preview_only',operation:name,exact_arguments:operation,proposal_id:proposal.id,preview_token:`${encoded}.${sign(encoded)}`,expires_at:new Date(proposal.expires).toISOString(),household_revision:config.revision,instructions:"No YNAB changes made. Prepare this server preview before asking for final approval. Show all exact changes with resolved account/category/payee names, effects and resulting values where applicable. Obtain ONE explicit approval confirming both partners agree to the exact final proposal. If this same unchanged, unexpired preview is already explicitly approved, submit it without another conversational approval request. A category clarification, scenario choice or routine acknowledgment is not joint execution approval. Repeat this SAME tool with unchanged arguments, this preview_token and both_partners_agree=true. Changed payload/state/settings or expiry requires renewed review and approval. Never make a new preview just to retry an uncertain write."});
        }
        if(both_partners_agree!==true) return error('Explicit confirmation that both partners agree is required.');
        const [encoded,signature,extra]=preview_token.split('.');
        if(!encoded || !signature || extra || signature.length!==43 || !timingSafeEqual(Buffer.from(signature),Buffer.from(sign(encoded)))) return error('Invalid or modified preview.');
        const p=JSON.parse(Buffer.from(encoded,'base64url').toString());
        if(p.v!==1 || p.subject!==subject || p.budgetId!==budgetId || p.digest!==digest || !/^[a-f0-9-]{36}$/.test(p.id)) return error('Preview does not match this user, budget or exact operation.');
        const receipt=`budgets/${budgetId}/receipts/${p.id}.json`;
        const previous=await store.get(receipt);
        if(previous) return previous.status==='complete'?previous.result:error(`Proposal ${p.id} has status ${previous.status}. Do not retry with a new preview; reconcile its recorded outcome first.`);
        if(p.expires<now() || p.revision!==config.revision) return error('Preview expired or household settings changed. Review current state and approve a new proposal.');
        if(!(await store.put(lock,{proposal_id:p.id,subject,started_at:new Date(now()).toISOString()},true))) return error('Another write is active or awaiting recovery. No write attempted.');
        let claimed=false;let submitted=false;
        try{
          if(await stateReader()!==p.state) return error('YNAB changed since preview. Refresh and approve a revised proposal.');
          claimed=await store.put(receipt,{status:'started',proposal_id:p.id,subject,name,operation,approved_at:new Date(now()).toISOString()},true);
          if(!claimed) return error('This proposal was already claimed. Inspect its receipt before retrying.');
          submitted=true;
          const result=await execute(operation);
                    let payload=result.structuredContent;
          if(!payload){try{payload=JSON.parse(result.content?.find(c=>c.type==='text')?.text ?? '{}');}catch{payload={};}}
          const itemErrors=payload?.results?.some(item=>['error','failed','needs_review'].includes(item.status));
          const status=result.isError||itemErrors?'needs_review':'complete';
          await store.put(receipt,{status,proposal_id:p.id,subject,name,operation,result,finished_at:new Date(now()).toISOString()});
          if(status==='needs_review') return error(`Write proposal ${p.id} may have partially completed. It is blocked from replay and the write lock remains held. Inspect the receipt and YNAB before recovery. Original result: ${JSON.stringify(result)}`);
          submitted=false;
          return result;
        } finally {
          // Keep lock after an uncertain/partial outcome. Never automatically expire it.
          if(!submitted) await store.delete(lock);
        }
      }catch {return error('Write/configuration check failed or execution outcome is uncertain. Do not submit a new preview to retry. Check YNAB and the durable receipt/lock before recovery.');}
    }
  };
}
export function gatedRegistration(server,gate,subject,handlers=new Map(),schemas=new Map()) {
  return {registerTool(name,config,callback){
    handlers.set(name,callback);schemas.set(name,config.inputSchema);
    if(config.annotations?.readOnlyHint===true) return server.registerTool(name,config,callback);
    if(!WRITE_TOOLS.has(name)) throw new Error(`Unreviewed write tool ${name}`);
    return server.registerTool(name,{...config,description:config.description+' Budget Brain: prepare the server preview before asking for final approval. Obtain one explicit joint approval of the exact final proposal, then submit the same valid preview and unchanged arguments with both_partners_agree=true without asking again. Clarification is not approval. Changed/stale proposals need renewed approval; uncertain writes require reconciliation, not a fresh preview.',inputSchema:config.inputSchema.extend({preview_token:z.string().max(10000).optional(),both_partners_agree:z.boolean().optional()})},(args,extra)=>gate.run(name,args,subject,operation=>callback(operation,extra)));
  }};
}
