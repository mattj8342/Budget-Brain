# Sustainability tools (server 0.8.0)

check_sustainability is a read-only analysis tool. It requires authenticated household access, loads current rules and one coherent budget snapshot, and reads an existing write lock when storage is configured. It makes no YNAB, configuration or storage writes. Results are returned in chat; this version does not save a sustainability report automatically.

Call get_household_settings and latest completed allocation/impact context first. Use actual tool discovery. Empty input discovers available evidence and questions without claiming complete income or spending coverage.

## Inputs

All amounts use currency units, with at most three decimal places. Output fields ending _milliunits use integer YNAB units, divided by 1000 for display.

- budget_id: optional; the server pins the authenticated household's selected budget.
- horizon_end: optional YYYY-MM-DD, after the household-local snapshot date and within 366 days. Default 90 days after that date.
- history_months: 1–12 completed months before the current month, default 3. The current partial month is not averaged as a full spending month.
- income_streams: [{id, label, amount, cadence, every?, certainty, next_date?, account_id?, paydays?}]. amount is net per occurrence. cadence is weekly, biweekly, semimonthly, monthly, quarterly or annual. every defaults to 1. certainty is reliable, variable or uncertain. next_date is the next actual future deposit date. For semimonthly, provide two ordered paydays in 1–31 and every=1; month-end dates clamp correctly.
- income_adjustments: [{stream_id, date, amount, certainty, reason}]. Replaces one generated payday amount, without changing the ongoing regular income basis. Unknown dates/streams fail instead of adding an extra check.
- one_time_income: [{id, label, date, amount, certainty, account_id?, distinct_from_forecast_confirmed?}]. Extra future deposits only. No contribution to ongoing average income. A match to a generated deposit requires reconciliation.
- category_reviews: [{category_id, classification, reason, amount?, cadence?, every?, remaining_available?, required_balance?, due_date?}]. classification is recurring, one_time or excluded. Recurring overrides require reviewed amount and cadence. remaining_available is the desired balance still needed through the reviewed period, not an additional assignment. required_balance/due_date define an explicitly reviewed one-time balance goal. Work/card categories cannot be converted into ordinary household target costs through this override.
- debt_paydown: [{card_category_id, amount, cadence, every?, reason}]. Reviewed additional existing household principal reduction. Excludes new spending already represented in category costs, interest already targeted elsewhere and unresolved work debt. Card reserve floors and full bank payments are separate.
- cash_events: [{id, label, date, account_id, amount, kind, certainty?, distinct_from_registered_confirmed?}]. Additional future signed bank movements. kind is expense, debt_payment or other. Positive inflows enter the base cash projection only when reliable. Registered pending transactions are already reflected in current balances.
- transfers: [{date, from_account_id, to_account_id, amount, distinct_from_registered_confirmed?}]. Positive amount between two open on-budget cash accounts; moves cash without creating income or expenses.
- income_coverage_confirmed, category_coverage_confirmed, debt_coverage_confirmed, spending_window_representative_confirmed, cash_flow_coverage_confirmed: false by default. Set each only after review. These describe separate evidence, not permission to write.

Dates and account IDs must match real evidence. Income forecasts require future dates, while reviewed cash events may also occur on the snapshot date. A regular next deposit beyond the horizon is valid and contributes no dated income inside that horizon.

## Calculations and output

**Ongoing:** monthly averages of reliable income and reviewed recurring commitments, plus separate variable/uncertain income. Weekly averages use 52/12 and biweekly 26/12, rounded per item to milliunits. Actual dated forecasts count generated dates instead. Savings funding can be a commitment without being spending.

Live MF goals imply monthly funding. NEED target cadence supports documented weekly/monthly/custom-month/year repeat values. TB/TBD balance goals and nonrepeating NEED targets remain one-time. Ambiguous targets and untargeted categories require review. Explicit reviewed overrides preserve custom recurrence. Scheduled bills do not get added again to their target costs.

**Actual spending:** completed-month category activity, net of refunds. YNAB's category aggregation avoids counting parent and split transactions twice. Card payment/internal categories and configured work exclusions do not enter household spending totals. Hidden/deleted expense categories remain included when present. Missing months or unknown historical category mappings keep coverage incomplete. Current recurring exclusions do not erase historical outflows.

**Current funding:** current YNAB underfunding, negative Available, reviewed top-ups, one-time goal gaps and card reserve floors appear separately. Existing Available reduces a reviewed top-up once. These totals overlap and combined_pressure_total is intentionally null. Future-month assignments are surfaced for reconciliation and never added to current cash or average income.

**Timing:** current account balances plus reliable dated deposits and reviewed future cash movements. Full card payments and work outflows belong here even though they must not inflate household spending twice. Category target funding is not an account transfer. Same-day outflows precede inflows conservatively. Scheduled obligations are review candidates only; they do not silently become a complete cash forecast.

A returned recurring_shortfall or actual_spending_shortfall can coexist with timing issues. supported_under_reviewed_assumptions requires reviewed income/category/debt scope, complete representative history and confirmed cash coverage. It remains conditional. Negative RTA, current overspending or a card floor gap returns current_funding_gap even when averages are positive. An active write lock changes status to needs_reconciliation. Inspect questions, all four views and limitations before presenting a conclusion.

## Boundary and handoffs

This tool has no preview or execution fields and persists no analysis. It does not normalize every future financial scenario or reconcile a work ledger, future assignments, loan amortization, interest/fees or full-year seasonality automatically. Use Explore Impacts for a specific chosen change and Assign Paycheck for received income. Guided Settings remains a future workflow until available.

Server source: sustainability.mjs (pure calculations), sustainability-service.mjs (schema/authenticated read), paycheck.mjs (shared coherent snapshot including completed-month activity). Tests use synthetic data and no live writes.
