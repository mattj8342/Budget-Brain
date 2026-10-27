import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApp } from './server.mjs';
import { diagnosticReason } from './diagnostics.mjs';

async function fixture(run) {
  const entries = [], rows = new Map();
  const secret = 'PRIVATE_API_CREDENTIAL_MUST_NOT_APPEAR';
  const issuer = 'https://identity.example/', resource = 'https://budget.example/mcp';
  const subject = 'auth0|PRIVATE_IDENTITY_MUST_NOT_APPEAR';
  const {privateKey, publicKey} = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'diagnostic-test';
  const token = await new SignJWT({sub:subject}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  let stateReads = 0;
  const app = createApp({accessToken:secret,budgetId:'11111111-1111-4111-8111-111111111111',authMode:'oauth',authConfig:{issuer,resource,allowedSubjects:subject,keySet:createLocalJWKSet({keys:[jwk]})},writeMode:'full',householdLoader:{load:async()=>({revision:'test-private-revision',settings:{},rules:'PRIVATE_RULES_MUST_NOT_APPEAR',history:{}})},writeStore:{get:async key=>rows.get(key)??null,put:async(key,value)=>{rows.set(key,value);return true;},delete:async key=>rows.delete(key)},stateReader:async()=>{stateReads++;return 1;},diagnosticLogger:entry=>entries.push(entry)});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:'+app.address().port+'/mcp';
  const call = (body,headers={}) => fetch(base,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',Accept:'application/json, text/event-stream',Cookie:'PRIVATE_COOKIE_MUST_NOT_APPEAR',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  try { await run({entries,call,rows,stateReads:()=>stateReads}); }
  finally {
    app.closeAllConnections(); await new Promise(resolve=>app.close(resolve));
    const logged = JSON.stringify(entries);
    for (const forbidden of [secret,token,subject,'PRIVATE_RULES_MUST_NOT_APPEAR','PRIVATE_COOKIE_MUST_NOT_APPEAR','PRIVATE_PAYEE_MUST_NOT_APPEAR','PRIVATE_PREVIEW_MUST_NOT_APPEAR','PRIVATE_PROTOCOL_MUST_NOT_APPEAR']) assert.ok(!logged.includes(forbidden),forbidden);
  }
}

test('diagnostics record malformed JSON without retaining raw request data',async()=>fixture(async({entries,call,stateReads})=>{
  const response = await call('{"PRIVATE_PAYEE_MUST_NOT_APPEAR":');
  assert.equal(response.status,400); await response.text();
  assert.match(response.headers.get('x-budget-brain-request-id'),/^[a-f0-9-]{36}$/);
  assert.ok(entries.some(row=>row.event==='mcp_rejection'&&row.reason==='invalid_json'));
  const finish = entries.find(row=>row.event==='mcp_request_finished');
  assert.equal(finish.http_status,400); assert.equal(finish.tool_handler_entered,false);
  assert.equal(stateReads(),0);
}));

test('diagnostics capture transport HTTP 400 reason and trusted tool name without logging headers or arguments',async()=>fixture(async({entries,call,stateReads})=>{
  const response = await call({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create_transactions',arguments:{preview_token:'PRIVATE_PREVIEW_MUST_NOT_APPEAR',transactions:[{account_id:'22222222-2222-4222-8222-222222222222',amount:-368.55,date:'2026-10-24',payee_name:'PRIVATE_PAYEE_MUST_NOT_APPEAR'}]}}},{'MCP-Protocol-Version':'PRIVATE_PROTOCOL_MUST_NOT_APPEAR'});
  assert.equal(response.status,400); await response.text();
  const error = entries.find(row=>row.event==='mcp_transport_error');
  assert.equal(error.reason,'unsupported_protocol_version'); assert.equal(error.tool_name,'create_transactions');
  assert.equal(entries.find(row=>row.event==='mcp_request_finished').tool_handler_entered,false);
  assert.equal(stateReads(),0);
}));

test('diagnostics distinguish tool schema rejection from actual handler entry',async()=>fixture(async({entries,call,stateReads})=>{
  const response = await call({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'create_transactions',arguments:{transactions:[{amount:'PRIVATE_PAYEE_MUST_NOT_APPEAR'}]}}});
  assert.equal(response.status,200);
  assert.equal((await response.json()).result.isError,true);
  assert.ok(entries.some(row=>row.event==='mcp_tool_response'&&row.reason==='invalid_tool_arguments'));
  assert.equal(entries.find(row=>row.event==='mcp_request_finished').tool_handler_entered,false);
  assert.equal(stateReads(),0);
}));

test('diagnostics retain preview and joint approval behavior without submitting YNAB writes',async()=>fixture(async({entries,call,rows,stateReads})=>{
  const operation={transactions:[{account_id:'22222222-2222-4222-8222-222222222222',amount:-5,date:'2026-10-24',payee_name:'PRIVATE_PAYEE_MUST_NOT_APPEAR'}]};
  const response=await call({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'create_transactions',arguments:operation}});
  const preview=(await response.json()).result.structuredContent;
  assert.equal(preview.status,'preview_only');
  assert.ok(entries.some(row=>row.event==='mcp_tool_response'&&row.preview_only));
  assert.ok(entries.some(row=>row.event==='mcp_tool_started'&&row.tool_name==='create_transactions'));
  assert.ok(!JSON.stringify(entries).includes(preview.preview_token));
  const denied=await call({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'create_transactions',arguments:{...operation,preview_token:preview.preview_token,both_partners_agree:false}}});
  assert.equal((await denied.json()).result.isError,true);
  assert.ok(entries.some(row=>row.event==='mcp_tool_response'&&row.reason==='joint_approval_required'));
  assert.equal(rows.size,0); assert.equal(stateReads(),1);
}));

test('diagnostics never reflect arbitrary method/tool names or raw error messages',async()=>fixture(async({entries,call})=>{
  const response=await call({jsonrpc:'2.0',id:5,method:'PRIVATE_PAYEE_MUST_NOT_APPEAR',params:{name:'PRIVATE_PREVIEW_MUST_NOT_APPEAR'}});
  await response.text();
  assert.ok(entries.some(row=>row.rpc_method==='unknown'));
  assert.equal(diagnosticReason(new Error('PRIVATE_PAYEE_MUST_NOT_APPEAR')),'unclassified_error');
  assert.equal(diagnosticReason(new Error('Bad Request: Unsupported protocol version: PRIVATE_PROTOCOL_MUST_NOT_APPEAR')),'unsupported_protocol_version');
}));

import { EventEmitter } from 'node:events';
import { createRequestDiagnostics } from './diagnostics.mjs';
test('diagnostic sinks cannot disrupt requests and trace correlation rejects untrusted text',()=>{
  const response=new EventEmitter(); response.setHeader=()=>{}; response.statusCode=200; response.writableFinished=true;
  assert.doesNotThrow(()=>{
    const diagnostic=createRequestDiagnostics({headers:{}},response,{logger:()=>{throw Error('sink failed');}});
    diagnostic.reject('invalid_json'); response.emit('finish');
  });
  const entries=[];
  const other=new EventEmitter(); other.setHeader=()=>{}; other.statusCode=200; other.writableFinished=true;
  createRequestDiagnostics({headers:{'x-cloud-trace-context':'PRIVATE_HEADER_MUST_NOT_APPEAR'}},other,{project:'test-project',logger:entry=>entries.push(entry)});
  other.emit('finish');
  assert.ok(!JSON.stringify(entries).includes('PRIVATE_HEADER_MUST_NOT_APPEAR'));
  assert.ok(entries.every(entry=>!entry['logging.googleapis.com/trace']));
});
