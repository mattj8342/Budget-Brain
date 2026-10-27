// Explicit per-deployment budget selection; no credentials or household IDs in code.
export function scopeRequest(body, budgetId, budgetName) {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return { error: 'A single JSON-RPC request is required.' };
  }
  if (!['tools/call', 'prompts/get'].includes(body.method)) return {};
  const args = body.params?.arguments ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { error: 'Invalid arguments.' };
  if (args.budget_id !== undefined && args.budget_id !== budgetId) {
    return { error: 'This deployment only permits the configured household budget.' };
  }
  if (body.method === 'tools/call' && body.params?.name === 'list_budgets') {
    // Do not enumerate other budgets accessible to the token.
    return { result: { budgets: [{ id: budgetId, name: budgetName, configured: true }] } };
  }
  body.params = { ...body.params, arguments: { ...args, budget_id: budgetId } };
  return {};
}
