import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '@maro-org/ynab-mcp/build/tools/index.js';
import { createWriteGate } from './write-gate.mjs';
import { registerTransactionBatchTool } from './transaction-batch.mjs';
const out=data=>({structuredContent:data,content:[{type:'text',text:JSON.stringify(data)}]});
function fixture(overrides={}) {
  const data=new Map(), calls=[];
  const store={get:async key=>data.get(key)??null,put:async(key,value,only)=>{if(only&&data.has(key))return false;data.set(key,value);return true;},delete:async key=>data.delete(key)};
  let state=1;
  const gate=createWriteGate({secret:'fake',budgetId:'budget',loader:{load:async()=>({revision:'r'})},store,stateReader:async()=>state});
  const schemas=new Map();registerTools({registerTool:(name,config)=>schemas.set(name,config.inputSchema)},{});
  const handlers=new Map([
    ['update_transactions',async input=>{calls.push('update');state++;return out({results:input.transactions.map(row=>({transaction_id:row.transaction_id,current_transaction_id:'current-'+row.transaction_id,status:'updated',transaction:{id:'current-'+row.transaction_id,...row}}))});}],
    ['create_transactions',async input=>{calls.push('create');state++;return out({created_count:input.transactions.length,transactions:input.transactions.map((row,i)=>({id:'created-'+i,...row}))});}]
  ]);
  for(const [name,fn] of Object.entries(overrides))handlers.set(name,async input=>{calls.push(name);return fn(input);});
  let schema,callback;
  registerTransactionBatchTool({registerTool:(name,config,fn)=>{assert.equal(name,'apply_transaction_changes');schema=config.inputSchema;callback=fn;}},{gate,subject:'alice',handlers,schemas});
  const operation={budget_id:'budget',updates:[{transaction_id:'old',category_id:'category'}],creates:[{account_id:'account',date:'2026-10-25',amount:-5,category_id:'category',approved:false,cleared:'uncleared'}]};
  return {data,calls,store,operation,invoke:args=>callback(schema.parse(args)),schema};
}
test('mixed transaction batch previews first and executes once after one exact approval despite its own state changes',async()=>{
  const f=fixture(),p=(await f.invoke(f.operation)).structuredContent;
  assert.equal(p.status,'preview_only');assert.equal(f.calls.length,0);
  assert.equal((await f.invoke({...f.operation,preview_token:p.preview_token})).isError,true);
  const args={...f.operation,preview_token:p.preview_token,both_partners_agree:true};
  const done=await f.invoke(args);assert.equal(done.structuredContent.status,'applied');
  assert.deepEqual(f.calls,['update','create']);
  assert.equal(done.structuredContent.results.length,2);
  assert.equal(done.structuredContent.results[0].current_transaction_id,'current-old');
  assert.deepEqual(await f.invoke(args),done);assert.deepEqual(f.calls,['update','create']);
  assert.equal(await f.store.get('budgets/budget/write-lock.json'),null);
});
test('changed batch arguments do not inherit approval',async()=>{
  const f=fixture(),p=(await f.invoke(f.operation)).structuredContent;
  const changed={...f.operation,creates:[{...f.operation.creates[0],amount:-6}],preview_token:p.preview_token,both_partners_agree:true};
  assert.equal((await f.invoke(changed)).isError,true);assert.equal(f.calls.length,0);
});
test('partial update stops creates and retains outer receipt and lock',async()=>{
  const f=fixture({update_transactions:async()=>out({results:[{transaction_id:'old',status:'error'}]})});
  const p=(await f.invoke(f.operation)).structuredContent;
  const args={...f.operation,preview_token:p.preview_token,both_partners_agree:true};
  assert.equal((await f.invoke(args)).isError,true);
  assert.ok(await f.store.get('budgets/budget/write-lock.json'));
  assert.deepEqual(f.calls,['update_transactions']);
  assert.equal((await f.invoke(args)).isError,true);assert.equal(f.calls.length,1);
});
test('create uncertainty preserves successful update evidence and blocks replay',async()=>{
  const f=fixture({create_transactions:async()=>{throw Error('connection lost');}});
  const p=(await f.invoke(f.operation)).structuredContent;
  const args={...f.operation,preview_token:p.preview_token,both_partners_agree:true};
  const failed=await f.invoke(args);assert.equal(failed.isError,true);
  const receipt=await f.store.get('budgets/budget/receipts/'+p.proposal_id+'.json');
  assert.equal(receipt.status,'needs_review');
  assert.equal(receipt.result.structuredContent.results[0].current_transaction_id,'current-old');
  assert.ok(await f.store.get('budgets/budget/write-lock.json'));
  await f.invoke(args);assert.equal(f.calls.length,2);
});
test('schemas reject empty batches, duplicate targets, excessive rows and invalid split totals before submission',()=>{
  const f=fixture();
  for(const input of [
    {budget_id:'budget'},
    {...f.operation,updates:[{transaction_id:'old',category_id:'a'},{transaction_id:'old',category_id:'b'}]},
    {updates:[{transaction_id:'old'}]},
    {updates:[{transaction_id:'old',subtransactions:[{amount:-5,category_id:'a'}]}]},
    {updates:[{transaction_id:'old',amount:-5,subtransactions:[{amount:-4,category_id:'a'}]}]},
    {updates:[{transaction_id:'old',amount:-5,category_id:'parent',subtransactions:[{amount:-5,category_id:'a'}]}]},
    {creates:Array.from({length:100},()=>f.operation.creates[0]),updates:f.operation.updates}
  ]) assert.equal(f.schema.safeParse(input).success,false);
  assert.equal(f.schema.safeParse({updates:[{transaction_id:'old',amount:-5,subtransactions:[{amount:-3,category_id:'a'},{amount:-2,category_id:'b'}]}]}).success,true);
  assert.equal(f.calls.length,0);
});
test('missing or duplicate created IDs are uncertain outcomes rather than success',async()=>{
  for(const response of [
    out({created_count:1,transactions:[]}),
    out({created_count:1,transactions:[{}]}),
    {content:[{type:'text',text:'unexpected non-JSON'}]}
  ]) {
    const f=fixture({create_transactions:async()=>response});
    const operation={budget_id:'budget',creates:f.operation.creates};
    const p=(await f.invoke(operation)).structuredContent;
    assert.equal((await f.invoke({...operation,preview_token:p.preview_token,both_partners_agree:true})).isError,true);
    assert.ok(await f.store.get('budgets/budget/write-lock.json'));
  }
});
test('update results must cover the exact requested transaction IDs',async()=>{
  const f=fixture({update_transactions:async()=>out({results:[{transaction_id:'another',current_transaction_id:'another',status:'updated'}]})});
  const p=(await f.invoke(f.operation)).structuredContent;
  assert.equal((await f.invoke({...f.operation,preview_token:p.preview_token,both_partners_agree:true})).isError,true);
  assert.equal(f.calls.length,1);
});
