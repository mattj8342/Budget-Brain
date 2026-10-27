---
name: explore-impacts
description: Compare one-time purchases or category funding changes against the connected Budget Brain household's live baseline, protected needs, dated goals and conditional future paychecks. Use for what-if questions, funding tradeoffs and next-paycheck pressure; prepare a guarded funding plan only when requested.
---

# Explore impacts

Help the user understand what an exception costs and which purpose gives up money. Start with analysis; deciding which option is preferable does not authorize a write.

Read [Runtime contract](references/runtime-contract.md) and [Impact tools](references/impact-tools.md) before using connected data. Resolve the authenticated household and selected budget through the server. Treat saved reports as context and live YNAB as the current state.

## Begin with the household and the question

1. Call get_household_settings. Read its hierarchy, bill protection, essential allowances, work exclusions, card floors, goals, and approval policy. Never substitute remembered household details.
2. Call get_latest_allocation_report and get_impact_plan without a plan ID. Note completed funding, earlier exceptions and any active write recovery state. Do not replay a completed allocation or assume a draft was executed.
3. Establish the next actual payday and the proposed amount, date, category and paying account. Distinguish category funding, an actual purchase, bank transfers and card payments. Use fresh category/account IDs and transactions to resolve ambiguity.
4. Call compare_impacts with scenarios=[] for baseline/context if needed. The server reads one coherent live snapshot for each comparison. It includes current category funding, account balances, registered transactions, scheduled bills and known future-month assignments.
5. Review remaining essential needs through next payday, bill status, and the specific goals/paychecks needed for the question. Reuse confirmed settings and report evidence; ask only unresolved questions. A month boundary does not restart the payday allowance.

A positive category balance is not automatically free money. Preserve protected bills, remaining essentials and card floors. Work expense categories, card payment categories and unresolved work-related payoff changes are excluded as funding sources in this version.

## Build a fair comparison

Use one compare_impacts request containing the baseline assumptions and up to five explicit scenarios. Change only the declared moves/purchase. Supply currency units for inputs; divide output fields ending _milliunits by 1000 for display.

- Represent moves as exact source/destination amounts, with ready_to_assign only for received unassigned money. Do not sweep balances or count expected deposits as today's funding.
- A purchase remains hypothetical. Specify its spending category, paying account, amount and date. Mark counts_toward_remaining_need only when the expense replaces part of an already reviewed essential need; otherwise it is additional spending.
- Check registered transactions first. Current account balances already include pending transactions. Do not project a purchase or cash event again merely because it is uncleared. Resolve a possible existing match before confirming distinct_from_recorded_confirmed.
- For each dated goal, review target behavior and full recurrence. Use funding progress for a non-recurring spending target, or an explicit available_balance basis for money that must remain unspent. Do not blindly treat a spending target's full amount as an Available balance requirement. Include same-day payroll only when its availability before payment is confirmed.
- For future paychecks, state expected amount and committed_amount for bills, essentials and prior promises. Set commitments_confirmed only after reviewing that total. Confirm the priority order when several goals compete for the same money; never allocate the same paycheck room to multiple goals independently.
- Cash events are additional future bank movements, not transactions already in the current balance. Set cash_events_complete only after reviewing all relevant cash movements through the horizon. Category funding does not transfer bank cash.

Forecast income is conditional. Distinguish an equal-spread goal contribution from the actual deadline shortfall under the reviewed paycheck forecast. Withdrawing $100 does not automatically mean the next paycheck must replace $100; show the calculator's delta and assumptions.

If known future-month assignments overlap an affected goal/category, reconcile them before preparing funding. This version flags the overlap rather than treating future funding as new income or silently simulating rollover. Recurring expense changes, automatic target edits, extra card payoff and work-ledger reconciliation need further server support; explain supported facts without claiming those calculations are complete.

## Present the choice

Lead with whether current funding supports the option, which protection conflicts, or what unanswered assumptions prevent a conclusion. Include relevant rows in a compact baseline/options table:

- Source and destination Available before/after funding, exact assignment changes, and Ready to Assign.
- Hypothetical Available after spending, separate from the funding state.
- Protected needs and remaining gaps.
- Dated goal balance, deadline shortfall, equal-spread contribution and next forecast payday contribution delta.
- Cash-account effect or card debt/payment-reserve projection, with coverage limitations.

State snapshot date, settings revision, horizon and forecast assumptions. Never translate funding_supported_now into a guarantee that a purchase is affordable: it means the category funding checks passed. Incomplete cash coverage, uncertain income and uncovered future obligations remain explicit.

Offer a few concrete alternatives: smaller amount, later purchase, reviewed optional source, or keep the baseline. Do not change standing household policy to make an option pass. A completed exception is history, not a new recurring rule.

## From a chosen option to approved funding

When the user requests execution:

1. Call prepare_impact_plan with the original comparison_input, comparison_fingerprint and selected scenario_id. A stale or not_executable response requires resolving/reviewing its reason; do not reconstruct the plan through raw writes.
2. Call execute_impact_plan with plan_id and impacts_reviewed=true to obtain the exact server preview before the final approval question. This first call changes no YNAB funding.
3. Display the concrete budget/month, sources, destinations, resulting Assigned/Available, RTA and material consequences. Explain that execution funds categories only; the hypothetical purchase and forecast deposits are not recorded.
4. Obtain one explicit approval of that exact final proposal according to household policy. Where joint agreement is required, the caller can attest that both partners agree; do not independently contact another person or require a second login.
5. Submit the same plan_id and preview_token with both_partners_agree=true. Do not ask again when the unchanged valid preview has already received that explicit joint approval. Never set approval flags based merely on choosing an option.
6. Read the result and get_impact_plan. Report verified completion only when the server verified live funding. Changed state, rules, date, expiry or payload requires renewed preview/review/approval.

If execution is partial or uncertain, preserve the lock and receipts, inspect fresh results and reconcile. Do not automatically retry, roll back or bypass the gate. A subsequent actual purchase belongs in Record Transactions once it occurs, with its own duplicate check and exact approved proposal. There is no automatic purchase creation or bank payment in this workflow.

## Target interpretation

Read [Native target behavior and payday coverage](references/target-semantics.md) when interpreting targets, custom recurrence, current funding or one-time goals. This is the current server contract; preserve its refill/set-aside distinction and household-configured coverage. Use get_target_details rather than a lossy target summary. Existing approval and recovery steps above remain in force.
