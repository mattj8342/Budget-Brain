# Engineering notes

## Where the custom work lives

| Area | Implementation |
|---|---|
| HTTP/OAuth adapter and registration | server/server.mjs, auth.mjs, budget-policy.mjs |
| Exact previews and durable execution gate | server/write-gate.mjs |
| Cloud state and undo adapter | server/cloud-store.mjs |
| Household configuration and imported history | server/household.mjs |
| Paycheck calculation and plan lifecycle | server/allocation.mjs, paycheck.mjs |
| Complete native target interpretation | server/target-semantics.mjs |
| One-time impact comparisons and guarded funding | server/impacts.mjs, impact-service.mjs |
| Sustainability and cash timing | server/sustainability.mjs, sustainability-service.mjs |
| Completed allocation lookup | server/allocation-history.mjs |
| Mixed transaction changes | server/transaction-batch.mjs |
| Privacy-conscious request diagnostics | server/diagnostics.mjs |

The underlying YNAB tool layer comes from @maro-org/ynab-mcp. The custom adapter registers those tools behind Budget Brain's budget policy and write gate.

## Financial arithmetic

Calculators use safe integer milliunits and explicit currency conversion. Tests cover funding conservation, signed Assigned values, carryover, shortages, and earlier additions counted once. Live target fields supply amount, mode, frequency, deadlines, and funding progress. Household policy supplies coverage and order.

The target interpreter preserves refill versus set-aside behavior and full custom repeat intervals. Payday coverage is separate from recurring average cost. Non-recurring spending progress does not automatically require replenishing money already spent toward its goal.

## Write semantics

Previews are bound to user, budget, exact arguments, settings revision, YNAB version, and expiry. Shared durable state coordinates retries and concurrent requests. Completed receipts can return prior results; uncertain writes retain the lock.

Joint agreement is caller-attested. The server cannot prove what the human saw or collect independent partner signatures. A budget version check reduces stale execution but is not an atomic YNAB transaction. A bulk change can partially complete and require reconciliation.

## History and limits

The current history adapter scans at most 1,000 paycheck-result objects per budget, reads matching results in batches of 16, and lists 20 summaries by default (up to 100). Exceeding the scan guard returns an error; it does not discard older reports or establish a storage-capacity limit. Imported date-only records can make latest ordering ambiguous.

Undo covers operations recorded by this deployment and inherits upstream history limits. It is not a universal rollback. Historical reports are never replay instructions.

## Validation

The 135-test server suite covers HTTP/OAuth authorization and budget scope, previews and expiry, concurrent/retried writes, uncertain execution recovery, imported history, allocation math, transaction batches, impact forecasts, sustainability, and target semantics.

Tests use synthetic budgets, generated signing keys, mocked upstream results and in-memory state. The public export is rerun independently. Test results support the implemented paths and explicit limits; they do not imply completed public onboarding, database isolation, or successful real financial writes.

See VALIDATION.md for the public export's verification record.
