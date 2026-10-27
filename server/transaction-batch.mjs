import { z } from 'zod';

const output = data => ({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
function payload(result) {
  if (result?.structuredContent) return result.structuredContent;
  try { return JSON.parse(result?.content?.find(item=>item.type==='text')?.text ?? 'null'); } catch { return null; }
}
function validateRows(input, ctx) {
  const creates=input.creates??[], updates=input.updates??[];
  if (!creates.length && !updates.length) ctx.addIssue({code:'custom',message:'At least one create or update is required.'});
  if (creates.length+updates.length>100) ctx.addIssue({code:'custom',message:'At most 100 total changes per proposal.'});
  if (new Set(updates.map(row=>row.transaction_id)).size!==updates.length) ctx.addIssue({code:'custom',message:'A transaction can be updated only once per proposal.'});
  for (const row of [...creates,...updates]) {
    if (row.transaction_id && Object.keys(row).length===1) ctx.addIssue({code:'custom',message:'An update must specify a change.'});
    if (row.subtransactions?.length) {
      if (row.amount===undefined) ctx.addIssue({code:'custom',message:'Split updates must include the unchanged or explicitly reviewed parent amount.'});
      else {
        const money=[row.amount,...row.subtransactions.map(item=>item.amount)];
        if (money.some(value=>!Number.isSafeInteger(Math.round(value*1000)) || Math.abs(value*1000-Math.round(value*1000))>0.000001)) ctx.addIssue({code:'custom',message:'Amounts must fit integer YNAB milliunits.'});
        else if (Math.round(row.amount*1000)!==row.subtransactions.reduce((sum,item)=>sum+Math.round(item.amount*1000),0)) ctx.addIssue({code:'custom',message:'Split amounts must sum exactly to the parent amount.'});
      }
      if (row.category_id!==undefined && row.category_id!==null) ctx.addIssue({code:'custom',message:'A split parent must not specify a spending category.'});
    }
  }
}
// One outer gate owns approval, version checks, durable lock and receipt for all stages.
// Operations are sequential, not an atomic YNAB transaction. Never replay a partial batch.
export async function applyTransactionChanges(operation, handlers) {
  const results=[], stages=[];
  for (const [kind,field,name] of [['update','updates','update_transactions'],['create','creates','create_transactions']]) {
    const requested=operation[field]??[];
    if (!requested.length) continue;
    let response;
    try { response=await handlers.get(name)({budget_id:operation.budget_id,transactions:requested}); }
    catch {
      results.push({operation:kind,status:'needs_review',message:'Submitted stage outcome is uncertain; inspect YNAB and the receipt.'});
      return {...output({status:'needs_review',results,stages}),isError:true};
    }
    const data=payload(response);
    stages.push({operation:kind,response});
    if (kind==='update' && Array.isArray(data?.results)) results.push(...data.results.map(row=>({...row,operation:kind})));
    if (kind==='create' && Array.isArray(data?.transactions)) results.push(...data.transactions.map(row=>({operation:kind,status:'created',transaction_id:row.id,transaction:row})));
    const expected = kind==='create'
      ? data?.created_count===requested.length && data?.transactions?.length===requested.length && data.transactions.every(row=>typeof row.id==='string'&&row.id) && new Set(data.transactions.map(row=>row.id)).size===requested.length
      : data?.results?.length===requested.length && data.results.every(row=>row.status==='updated' && typeof row.current_transaction_id==='string' && row.current_transaction_id) && new Set(data.results.map(row=>row.transaction_id)).size===requested.length && requested.every(row=>data.results.some(result=>result.transaction_id===row.transaction_id));
    if (response?.isError || !expected) {
      results.push({operation:kind,status:'needs_review',message:'Stage did not confirm every requested change; remaining stages were not submitted.'});
      return {...output({status:'needs_review',results,stages}),isError:true};
    }
  }
  return output({status:'applied',results,stages,instructions:'API reported these changes. Read fresh transactions by returned IDs (including replacement IDs) and verify fields/splits before claiming verification. This batch is not atomic; do not recreate it after uncertain outcomes.'});
}

export function registerTransactionBatchTool(server,{gate,subject,handlers,schemas}) {
  if (!handlers.has('create_transactions') || !handlers.has('update_transactions')) throw Error('Transaction handlers unavailable');
  const schema=z.object({
    budget_id:z.string().optional(),
    creates:schemas.get('create_transactions').shape.transactions.optional(),
    updates:schemas.get('update_transactions').shape.transactions.optional(),
    preview_token:z.string().max(10000).optional(),
    both_partners_agree:z.boolean().optional()
  }).superRefine(validateRows);
  server.registerTool('apply_transaction_changes',{
    title:'Record and categorize transactions',
    description:'Create and/or update ordinary transactions as one exact guarded proposal. Search for duplicates and resolve category/split questions first. First call prepares a preview only; do this before asking for final approval. Present all create/update actions once and obtain the configured explicit joint approval once. Reuse that same valid preview and approval for identical arguments; never ask again merely to submit it. YNAB changed state, settings, payload or expiry requires renewed review/approval. Updates run before creates; partial failures stop and retain a recovery lock. No atomic rollback or automatic retry. Amounts are currency units, not milliunits. Split updates must include parent amount. Read back returned transaction IDs after success.',
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:true},
    inputSchema:schema
  },input=>gate.run('apply_transaction_changes',input,subject,operation=>applyTransactionChanges(operation,handlers)));
}
