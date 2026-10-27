import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from './server.mjs';
test('HTTP handshake and read-only guard without real credentials',async()=>{
  const app=createApp({authMode:'cloud-run-iam',accessToken:'fake-token-no-live-api-calls',budgetId:'11111111-1111-4111-8111-111111111111'});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.address().port}`;
  const client=new Client({name:'adapter-test',version:'1.0.0'});
  try {
    assert.equal((await fetch(base+'/health')).status,200);
    assert.equal((await fetch(base+'/mcp')).status,405);
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{Origin:'https://untrusted.example'}})).status,403);
    assert.equal((await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
    const listed = await client.callTool({name:'list_budgets',arguments:{}});
    assert.equal(listed.structuredContent.budgets.length,1);
    assert.equal(listed.structuredContent.budgets[0].id,'11111111-1111-4111-8111-111111111111');
    for (const denied of ['last-used','22222222-2222-4222-8222-222222222222']) {
      await assert.rejects(client.callTool({name:'get_budget_summary',arguments:{budget_id:denied}}),/only permits/);
    }
    const {tools}=await client.listTools();
    assert.ok(tools.some(t=>t.name==='get_budget_summary'));
    for(const name of ['set_category_budgets','create_transactions','undo_operations']) {
      const result=await client.callTool({name,arguments:{}});
      assert.equal(result.isError,true);
      assert.match(result.content[0].text,/Writes are disabled/);
    }
    console.log(`Discovered ${tools.length} upstream tools; rejected writes without YNAB calls`);
  } finally {
    await client.close();
    app.closeAllConnections();
    await new Promise(resolve=>app.close(resolve));
  }
});


import { scopeRequest } from './budget-policy.mjs';
test('budget policy pins omitted budgets and rejects batch bypasses',()=>{
  const body={method:'tools/call',params:{name:'get_accounts',arguments:{}}};
  assert.deepEqual(scopeRequest(body,'selected','Demo'),{});
  assert.equal(body.params.arguments.budget_id,'selected');
  assert.ok(scopeRequest([body],'selected','Demo').error);
  assert.ok(scopeRequest({method:'tools/call',params:{arguments:[]}},'selected','Demo').error);
  const prompt={method:'prompts/get',params:{name:'monthly-review'}};
  scopeRequest(prompt,'selected','Demo');
  assert.equal(prompt.params.arguments.budget_id,'selected');
  assert.throws(()=>createApp({accessToken:'fake'}),/explicit budget UUID/);
});


import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import { createAuth } from './auth.mjs';

test('OAuth rejects invalid tokens and other users; authorized MCP stays scoped and read-only', async () => {
  const issuer = 'https://identity.example/';
  const resource = 'https://budget.example/mcp';
  const subject = 'auth0|test-household-user';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  const keySet = createLocalJWKSet({ keys: [jwk] });
  async function token(overrides = {}, signingKey = privateKey) {
    return new SignJWT({ iss: issuer, aud: resource, sub: subject, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
  }
  const app = createApp({ accessToken: 'fake', budgetId: '11111111-1111-4111-8111-111111111111', authMode: 'oauth', authConfig: { issuer, resource, allowedSubjects: subject, keySet } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const client = new Client({ name: 'oauth-test', version: '1' });
  try {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const meta = await (await fetch(base + path)).json();
      assert.equal(meta.resource, resource);
      assert.deepEqual(meta.authorization_servers, [issuer]);
      assert.ok(!JSON.stringify(meta).includes(subject));
    }
    for (const method of ['GET','POST','DELETE']) {
      const denied = await fetch(base+'/mcp', { method });
      assert.equal(denied.status,401);
      assert.match(denied.headers.get('www-authenticate'), /resource_metadata=/);
    }
    const badKey = await generateKeyPair('RS256');
    for (const bad of ['not-a-jwt', await token({aud:'other-api'}), await token({iss:'https://other.example/'}), await token({exp:1}), await token({exp:undefined}), await token({nbf:Math.floor(Date.now()/1000)+600}), await token({},badKey.privateKey)]) {
      assert.equal((await fetch(base+'/mcp', {headers:{Authorization:`Bearer ${bad}`}})).status,401);
    }
    assert.equal((await fetch(base+'/mcp',{headers:{Authorization:`Bearer ${await token({sub:'auth0|other-user'})}`}})).status,403);
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'), { requestInit: { headers: { Authorization: `Bearer ${await token()}` } } }));
    assert.ok((await client.listTools()).tools.length > 0);
    const budgets = await client.callTool({ name: 'list_budgets', arguments: {} });
    assert.equal(budgets.structuredContent.budgets.length,1);
    await assert.rejects(client.callTool({name:'get_accounts',arguments:{budget_id:'22222222-2222-4222-8222-222222222222'}}),/only permits/);
    const write = await client.callTool({name:'create_transactions',arguments:{}});
    assert.equal(write.isError,true);
    assert.match(write.content[0].text,/Writes are disabled/);
  } finally {
    await client.close();
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  }
  assert.throws(()=>createAuth({issuer,resource,allowedSubjects:'',keySet}),/household member/);
  assert.throws(()=>createAuth({issuer:'http://identity.example/',resource,allowedSubjects:subject,keySet}),/HTTPS/);
  assert.throws(()=>createApp({accessToken:'fake',budgetId:'11111111-1111-4111-8111-111111111111'}),/Explicit AUTH_MODE/);
});

test('full-write MCP advertises gated schemas and previews without calling YNAB', async () => {
 const issuer='https://identity.example/',resource='https://budget.example/mcp',subject='auth0|allowed';
 const {privateKey,publicKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='k';
 const token=await new SignJWT({sub:subject}).setProtectedHeader({alg:'RS256',kid:'k'}).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const memoryStore=()=>{const rows=new Map();return {get:async k=>rows.get(k)??null,put:async(k,v,only)=>{if(only&&rows.has(k))return false;rows.set(k,v);return true;},delete:async k=>rows.delete(k)};};
 const app=createApp({accessToken:'fake',budgetId:'11111111-1111-4111-8111-111111111111',authMode:'oauth',authConfig:{issuer,resource,allowedSubjects:subject,keySet:createLocalJWKSet({keys:[jwk]})},writeMode:'full',householdLoader:{load:async()=>({revision:'test',settings:{},rules:'test',history:{}})},writeStore:memoryStore(),stateReader:async()=>1});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const client=new Client({name:'test',version:'1'});
 try{
 await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.address().port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 const listing=await client.listTools();assert.ok(listing.tools.some(t=>t.name==='get_household_settings'));
 for(const tool of listing.tools.filter(t=>t.annotations?.readOnlyHint===false&&t.name!=='prepare_impact_plan')){assert.ok(tool.inputSchema.properties.preview_token,tool.name);assert.ok(tool.inputSchema.properties.both_partners_agree,tool.name);}
 const preview=await client.callTool({name:'create_transactions',arguments:{transactions:[{account_id:'22222222-2222-4222-8222-222222222222',date:'2026-10-24',amount:-5,payee_name:'Fake test'}]}});
 assert.equal(preview.structuredContent.status,'preview_only');
 const mixed=await client.callTool({name:'apply_transaction_changes',arguments:{creates:[{account_id:'22222222-2222-4222-8222-222222222222',date:'2026-10-24',amount:-5,approved:false,cleared:'uncleared'}],updates:[{transaction_id:'33333333-3333-4333-8333-333333333333',category_id:'44444444-4444-4444-8444-444444444444'}]}});
 assert.equal(mixed.structuredContent.status,'preview_only');
 assert.equal(mixed.structuredContent.operation,'apply_transaction_changes');
 const rules=await client.callTool({name:'get_household_settings',arguments:{}});assert.equal(rules.structuredContent.rules,'test');
 }finally{await client.close();app.closeAllConnections();await new Promise(r=>app.close(r));}
});



import {fixture as impactFixture} from './impact-fixture.mjs';
test('authenticated MCP exposes impact comparisons and guarded funding previews without live writes',async()=>{
 const f=impactFixture(),issuer='https://identity.example/',resource='https://budget.example/mcp',subject='auth0|allowed';
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='impact';
 const token=await new SignJWT({sub:subject}).setProtectedHeader({alg:'RS256',kid:'impact'}).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const data=new Map(),store={get:async k=>data.get(k)??null,put:async(k,v,only)=>{if(only&&data.has(k))return false;data.set(k,v);return true;},delete:async k=>data.delete(k)};
 const app=createApp({accessToken:'fake',budgetId:f.snapshot.budget_id,authMode:'oauth',authConfig:{issuer,resource,allowedSubjects:subject,keySet:createLocalJWKSet({keys:[jwk]})},writeMode:'full',householdLoader:{load:async()=>({settings:f.settings,revision:'synthetic',history:{records:[]}})},writeStore:store,stateReader:async()=>1,snapshotReader:async()=>structuredClone(f.snapshot),diagnosticLogger:()=>{}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));const client=new Client({name:'impacts-test',version:'1'});
 try{
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+app.address().port+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
  const listing=await client.listTools();assert.equal(listing.tools.find(t=>t.name==='prepare_impact_plan').annotations.readOnlyHint,false);assert.equal(listing.tools.find(t=>t.name==='compare_impacts').annotations.readOnlyHint,true);for(const name of ['compare_impacts','prepare_impact_plan','get_impact_plan','execute_impact_plan'])assert.ok(listing.tools.some(t=>t.name===name));
  const comparison=await client.callTool({name:'compare_impacts',arguments:f.input});assert.ok(!comparison.isError);assert.equal(data.size,0);
  const plan=await client.callTool({name:'prepare_impact_plan',arguments:{comparison_input:f.input,comparison_fingerprint:comparison.structuredContent.comparison_fingerprint,scenario_id:'move'}});assert.equal(plan.structuredContent.status,'prepared');
  const preview=await client.callTool({name:'execute_impact_plan',arguments:{plan_id:plan.structuredContent.plan_id,impacts_reviewed:true}});assert.equal(preview.structuredContent.status,'preview_only');assert.equal(preview.structuredContent.operation,'execute_impact_plan');
 }finally{await client.close();app.closeAllConnections();await new Promise(r=>app.close(r));}
});

import {fixture as sustainabilityFixture} from './sustainability-fixture.mjs';
test('authenticated sustainability MCP is read-only in both read-only and full-write deployments',async()=>{
 const f=sustainabilityFixture(),issuer='https://identity.example/',resource='https://budget.example/mcp',subject='auth0|sustainability-user';
 const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='sustainability';
 const token=await new SignJWT({sub:subject}).setProtectedHeader({alg:'RS256',kid:'sustainability'}).setIssuer(issuer).setAudience(resource).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 for(const mode of ['read-only','full']){
  let puts=0,reads=0;const store={get:async()=>null,put:async()=>{puts++;throw Error('Read-only analysis must never write');},delete:async()=>assert.fail('No state deletion')};
  const app=createApp({accessToken:'fake',budgetId:f.snapshot.budget_id,authMode:'oauth',authConfig:{issuer,resource,allowedSubjects:subject,keySet:createLocalJWKSet({keys:[jwk]})},writeMode:mode,householdLoader:{load:async()=>({settings:f.settings,revision:'test',history:{records:[]}})},writeStore:mode==='full'?store:undefined,stateReader:async()=>8,snapshotReader:async()=>{reads++;return structuredClone(f.snapshot);},diagnosticLogger:()=>{}});
  await new Promise(r=>app.listen(0,'127.0.0.1',r));const client=new Client({name:'sustainability-test',version:'1'});
  try{
   await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:'+app.address().port+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+token}}}));
   const listing=await client.listTools(),tool=listing.tools.find(t=>t.name==='check_sustainability');assert.equal(tool.annotations.readOnlyHint,true);assert.equal(tool.inputSchema.properties.preview_token,undefined);
   const result=await client.callTool({name:'check_sustainability',arguments:f.input});assert.equal(result.isError,undefined);assert.equal(result.structuredContent.status,'supported_under_reviewed_assumptions');assert.equal(reads,1);assert.equal(puts,0);
   const empty=await client.callTool({name:'check_sustainability',arguments:{}});assert.equal(empty.structuredContent.status,'insufficient_evidence');assert.equal(puts,0);
   await assert.rejects(client.callTool({name:'check_sustainability',arguments:{budget_id:'22222222-2222-4222-8222-222222222222'}}),/only permits/);
  }finally{await client.close();app.closeAllConnections();await new Promise(r=>app.close(r));}
 }
});
