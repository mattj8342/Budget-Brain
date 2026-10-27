import {createSustainabilityService,registerSustainabilityTools} from './sustainability-service.mjs';
import { createImpactService, registerImpactTools } from './impact-service.mjs';
import { registerTransactionBatchTool } from './transaction-batch.mjs';
import { createRequestDiagnostics } from './diagnostics.mjs';
import { createAllocationHistory, registerAllocationHistoryTools } from './allocation-history.mjs';
import { createPaycheckService, createYnabSnapshotReader, registerPaycheckTools } from './paycheck.mjs';
import { createHouseholdLoader, registerHouseholdTools } from './household.mjs';
import { createCloudStore, CloudUndoStore } from './cloud-store.mjs';
import { createWriteGate, gatedRegistration } from './write-gate.mjs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '@maro-org/ynab-mcp/build/tools/index.js';
import { registerPrompts } from '@maro-org/ynab-mcp/build/prompts/index.js';
import { registerResources } from '@maro-org/ynab-mcp/build/resources/index.js';
import { UndoEngine } from '@maro-org/ynab-mcp/build/undo/engine.js';
import { createAuth } from './auth.mjs';
import { scopeRequest } from './budget-policy.mjs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTargetDetails } from './target-semantics.mjs';
import { createYnabMcpServer } from '@maro-org/ynab-mcp/build/server.js';

// OAuth verifies every MCP request; IAM mode is only for private Cloud Run invocation.
export function createApp({ accessToken, budgetId, budgetName = "Selected household budget", authMode, authConfig, writeMode = 'read-only', householdLoader, writeStore, stateReader, snapshotReader, diagnosticLogger }) {
  if (!accessToken) throw new Error('YNAB_API_TOKEN is required');
  if (!budgetId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(budgetId)) throw new Error('YNAB_BUDGET_ID must be an explicit budget UUID');
  if (!['oauth', 'cloud-run-iam'].includes(authMode)) throw new Error('Explicit AUTH_MODE oauth or cloud-run-iam is required');
  const auth = authMode === 'oauth' ? createAuth(authConfig) : null;
  if (!['read-only','full'].includes(writeMode)) throw new Error('Invalid WRITE_MODE');
  const fullWrites = writeMode === 'full';
  if (fullWrites && (authMode !== 'oauth' || !householdLoader || !writeStore)) throw new Error('Full writes require OAuth, household configuration, and durable state');
  const readState = stateReader ?? (async () => {
    const r = await fetch(`https://api.ynab.com/v1/budgets/${budgetId}`,{headers:{Authorization:`Bearer ${accessToken}`},signal:AbortSignal.timeout(15000),redirect:'error'});
    if(!r.ok) throw new Error('Cannot verify current YNAB state');
    const d=await r.json();
    if(!Number.isSafeInteger(d.data?.server_knowledge)) throw new Error('Missing YNAB version');
    return d.data.server_knowledge;
  });
  const writeGate = fullWrites ? createWriteGate({secret:accessToken,budgetId,loader:householdLoader,store:writeStore,stateReader:readState}) : null;
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    const diagnostic = url.pathname === '/mcp' ? createRequestDiagnostics(req, res, { logger: diagnosticLogger }) : null;
    diagnostic?.mark('authentication');
    if (req.headers.origin) { diagnostic?.reject('origin_not_allowed'); res.writeHead(403).end(); return; }
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', readOnly: !fullWrites, writeMode, householdConfiguration: !!householdLoader })); return;
    }
    if (auth && ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(url.pathname) && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.metadata)); return;
    }
    if (url.pathname === '/mcp' && auth && !(await auth.authorize(req, res))) { diagnostic.reject('authorization_failed'); return; }
    diagnostic?.mark('http_validation');
    if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { diagnostic.reject('method_not_allowed'); res.writeHead(405, { Allow: 'POST' }).end(); return; }
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
      diagnostic.reject('unsupported_content_type'); res.writeHead(415).end(); return;
    }
    let body;
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) { diagnostic.reject('request_too_large'); res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { diagnostic.reject('invalid_json'); res.writeHead(400).end(); return; }
    diagnostic.identify(body);
    diagnostic.mark('budget_scope');
    const scoped = scopeRequest(body, budgetId, budgetName);
    if (scoped.error || scoped.result) {
      if (scoped.error) diagnostic.reject('budget_scope_or_request_shape');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const id = body?.id ?? null;
      if (scoped.error) {
        res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32602,message:scoped.error}}));
      } else {
        res.end(JSON.stringify({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(scoped.result)}],structuredContent:scoped.result}}));
      }
      return;
    }
    if (!fullWrites && body?.method === 'tools/call' && /^(create_|update_|delete_|set_|undo_)/.test(body.params?.name ?? '')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      diagnostic.reject('writes_disabled');
      res.end(JSON.stringify({jsonrpc:'2.0',id:body.id ?? null,result:{isError:true,content:[{type:'text',text:'Writes are disabled in this read-only deployment.'}]}})); return;
    }
    const upstream = createYnabMcpServer({accessToken,dataDirectory:'/tmp/budget-brain',readOnly:!fullWrites,version:'0.9.0'});
    let server=upstream.server;
    const handlers = new Map();
    const schemas = new Map();
    if(fullWrites) {
      upstream.context.undoEngine=new UndoEngine(upstream.context.ynabClient,new CloudUndoStore(writeStore));
      server=new McpServer({name:'budget-brain',version:'0.9.0'});
      diagnostic.instrument(server);
      registerTools(gatedRegistration(server,writeGate,req.householdSubject,handlers,schemas),upstream.context);
      registerPrompts(server);registerResources(server);
    }
    if(fullWrites) registerTransactionBatchTool(server,{gate:writeGate,subject:req.householdSubject,handlers,schemas});
    if(!fullWrites) diagnostic.instrument(server);
    if(householdLoader) registerHouseholdTools(server,householdLoader);
    if(fullWrites) registerPaycheckTools(server,{
      subject:req.householdSubject,
      service:createPaycheckService({secret:accessToken,budgetId,loader:householdLoader,store:writeStore,
        snapshotReader:snapshotReader ?? createYnabSnapshotReader({accessToken,budgetId}),stateReader:readState}),
      executeAssignments:handlers.get('set_category_budgets')
    });
    if(fullWrites) registerImpactTools(server,{subject:req.householdSubject,service:createImpactService({secret:accessToken,budgetId,loader:householdLoader,store:writeStore,snapshotReader:snapshotReader ?? createYnabSnapshotReader({accessToken,budgetId})}),executeAssignments:handlers.get('set_category_budgets')});
    if(householdLoader && auth) registerTargetDetails(server,{subject:req.householdSubject,budgetId,loader:householdLoader,snapshotReader:snapshotReader ?? createYnabSnapshotReader({accessToken,budgetId})});
    if(householdLoader && auth) registerSustainabilityTools(server,{subject:req.householdSubject,service:createSustainabilityService({budgetId,loader:householdLoader,store:writeStore,snapshotReader:snapshotReader ?? createYnabSnapshotReader({accessToken,budgetId})})});
    if(householdLoader && writeStore && auth) registerAllocationHistoryTools(server,createAllocationHistory({budgetId,loader:householdLoader,store:writeStore}));
    const transport = new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    transport.onerror = error => diagnostic.transportError(error);
    const send = transport.send.bind(transport);
    transport.send = (message, options) => { diagnostic.response(message); return send(message, options); };
    diagnostic.dispatch(body);
    res.on('close', () => { void server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req,res,body);
    } catch {
      diagnostic.handlerError();
      if (!res.headersSent) res.writeHead(500).end(); else res.end();
      await server.close().catch(() => {});
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!['oauth','cloud-run-iam'].includes(process.env.AUTH_MODE)) throw new Error('Explicit AUTH_MODE is required');
  const app = createApp({accessToken:process.env.YNAB_API_TOKEN,budgetId:process.env.YNAB_BUDGET_ID,budgetName:process.env.YNAB_BUDGET_NAME,authMode:process.env.AUTH_MODE,writeMode:process.env.WRITE_MODE ?? 'read-only',householdLoader:process.env.HOUSEHOLD_REPO ? createHouseholdLoader({repository:process.env.HOUSEHOLD_REPO,token:process.env.GITHUB_CONFIG_TOKEN,budgetId:process.env.YNAB_BUDGET_ID}) : undefined,writeStore:process.env.WRITE_MODE === 'full' ? createCloudStore(process.env.WRITE_STATE_BUCKET) : undefined,authConfig:{issuer:process.env.AUTH0_ISSUER,resource:process.env.MCP_RESOURCE_URL,allowedSubjects:process.env.ALLOWED_SUBJECTS}});
  app.listen(Number(process.env.PORT ?? 8080),process.env.K_SERVICE ? '0.0.0.0' : '127.0.0.1',()=>console.log('Budget Brain MCP service started'));
  process.on('SIGTERM',()=>app.close(()=>process.exit(0)));
}





