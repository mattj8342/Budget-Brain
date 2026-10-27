import { randomUUID } from 'node:crypto';

const METHODS = new Set(['initialize','ping','notifications/initialized','notifications/cancelled','tools/list','tools/call','prompts/list','prompts/get','resources/list','resources/read','resources/templates/list','resources/subscribe','resources/unsubscribe','completion/complete','logging/setLevel']);
const ERROR_RULES = [
  [/^Parse error: Invalid JSON-RPC message/, 'invalid_json_rpc'],
  [/^Parse error: Invalid JSON/, 'invalid_json'],
  [/^Bad Request: Unsupported protocol version:/, 'unsupported_protocol_version'],
  [/^Bad Request: Server not initialized/, 'server_not_initialized'],
  [/^Bad Request: Mcp-Session-Id header is required/, 'missing_session_id'],
  [/^Session not found/, 'invalid_session_id'],
  [/^Invalid Request: Server already initialized/, 'already_initialized'],
  [/^Invalid Request: Only one initialization request/, 'invalid_initialization_batch'],
  [/^Invalid Request: Batch must not exceed/, 'batch_too_large'],
  [/^Not Acceptable:/, 'unsupported_accept_header'],
  [/^Unsupported Media Type:/, 'unsupported_content_type'],
  [/^(?:MCP error -32602: )?(?:Input validation error|Invalid arguments)/, 'invalid_tool_arguments'],
  [/^Preview expired or household settings changed\./, 'stale_preview'],
  [/^YNAB changed since preview\./, 'stale_ynab_state'],
  [/^Invalid or modified preview\./, 'invalid_preview'],
  [/^Preview does not match this user, budget or exact operation\./, 'preview_mismatch'],
  [/^Explicit confirmation that both partners agree is required\./, 'joint_approval_required'],
  [/^Another write is active or awaiting recovery\./, 'write_locked'],
  [/^Write\/configuration check failed or execution outcome is uncertain\./, 'write_check_failed_or_uncertain'],
  [/^Durable state read failed/, 'storage_read_failed'],
  [/^Durable history listing failed/, 'storage_list_failed']
];
// Messages are inspected only to select a constant code. Never return their contents.
export function diagnosticReason(error) {
  const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  return ERROR_RULES.find(([pattern]) => pattern.test(message))?.[1] ?? 'unclassified_error';
}

export function createRequestDiagnostics(req, res, { logger = entry => console.log(JSON.stringify(entry)), project = process.env.GOOGLE_CLOUD_PROJECT } = {}) {
  const started = Date.now(), requestId = randomUUID(), tools = new Set();
  let method = null, tool = null, stage = 'received', enteredTool = false, finished = false;
  // Cloud Run's trace header is used only after strict validation, never logged verbatim.
  const trace = typeof req.headers['x-cloud-trace-context'] === 'string' ? /^([a-f0-9]{32})\/[0-9]+(?:;o=[01])?$/.exec(req.headers['x-cloud-trace-context']) : null;
  const traceField = trace && /^[a-z][a-z0-9-]{4,62}$/.test(project ?? '') ? { 'logging.googleapis.com/trace': `projects/${project}/traces/${trace[1]}` } : {};
  function emit(event, fields = {}) {
    try { logger({ severity: event === 'mcp_rejection' || event === 'mcp_transport_error' || event === 'mcp_handler_error' ? 'WARNING' : 'INFO', event, request_id: requestId, rpc_method: method, tool_name: tool, stage, ...traceField, ...fields }); } catch { /* Logging must never change request or write behavior. */ }
  }
  res.setHeader('X-Budget-Brain-Request-Id', requestId);
  emit('mcp_request_received');
  function finish(aborted) {
    if (finished) return;
    finished = true;
    emit('mcp_request_finished', { http_status: res.statusCode, duration_ms: Date.now() - started, tool_handler_entered: enteredTool, aborted });
  }
  res.once('finish', () => finish(false));
  res.once('close', () => { if (!res.writableFinished) finish(true); });
  return {
    mark(value) { stage = value; },
    identify(body) {
      method = METHODS.has(body?.method) ? body.method : 'unknown';
      tool = method === 'tools/call' && tools.has(body?.params?.name) ? body.params.name : null;
    },
    reject(reason) { emit('mcp_rejection', { reason }); },
    transportError(error) { emit('mcp_transport_error', { reason: diagnosticReason(error) }); },
    handlerError() { emit('mcp_handler_error', { reason: 'unhandled_request_error' }); },
    response(message) {
      if (message?.error) {
        const code = Number.isSafeInteger(message.error.code) ? message.error.code : null;
        emit('mcp_rpc_error', { rpc_error_code: code, reason: diagnosticReason(message.error.message) });
      } else if (method === 'tools/call' && message?.result) {
        const failed = message.result.isError === true;
        const text = message.result.content?.find(item => item.type === 'text')?.text;
        emit('mcp_tool_response', { is_error: failed, preview_only: message.result.structuredContent?.status === 'preview_only', ...(failed ? { reason: diagnosticReason(text) } : {}) });
      }
    },
    instrument(server) {
      const register = server.registerTool.bind(server);
      server.registerTool = (name, config, callback) => {
        tools.add(name);
        return register(name, config, async (...args) => {
          enteredTool = true; stage = 'tool_handler'; tool = name;
          emit('mcp_tool_started');
          try { return await callback(...args); }
          catch (error) { emit('mcp_handler_error', { reason: diagnosticReason(error) }); throw error; }
        });
      };
    },
    dispatch(body) { this.identify(body); stage = 'transport'; emit('mcp_dispatch'); }
  };
}
