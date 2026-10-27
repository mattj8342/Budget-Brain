---
name: check-sustainability
description: Assess whether the connected Budget Brain household's reliable net income supports its recurring budget commitments, actual spending and upcoming cash needs. Use for overall sustainability or recurring shortfalls; use Explore Impacts for a specific proposed exception.
---

# Check sustainability

Answer whether the budget works over time and where cash timing or current funding creates pressure. Use the tested server analysis rather than hand-building a confident affordability total.

Read [Sustainability tools](references/sustainability-tools.md) for supported inputs and limits, and the [Runtime contract](references/runtime-contract.md) for authenticated household access and shared policy.

## Start with current household evidence

Load get_household_settings, the latest completed allocation report, and the latest verified impact result when available. These explain rules, exclusions and prior exceptions. Inspect active write recovery state before drawing a conclusion. A completed allocation or exception does not authorize a new assignment.

Call check_sustainability with an empty input to obtain current target costs, historical spending, current funding and unresolved questions. It reads one fresh coherent YNAB snapshot. The initial result is discovery, not a sustainability assurance.

Use fresh category/account IDs and relevant transaction/schedule reads to resolve the material questions. Current live balances govern. Saved household recurrence confirmations can resolve unclear connector fields through explicit category_reviews. Do not reset weekly allowances at month-end or overwrite confirmed custom recurrence based on an opaque cadence value.

Default to the next 90 days plus three completed spending months unless the user requests another horizon. State the period and snapshot time. Ask only about missing facts that could change the answer; group related questions rather than presenting every discovery row as a separate question.

## Review the assumptions

- Establish net recurring income by source, amount, cadence and reliability. A transfer, reimbursement, refund or bonus is not automatically recurring salary. Include variable and uncertain income separately. Actual deposits and expected income remain distinct.
- Confirm actual next pay dates and deposit accounts for cash timing. Semimonthly pay requires two reviewed paydays. Use income_adjustments when a special check replaces a scheduled check; use one_time_income only for an additional deposit.
- Review recurring funding commitments, including savings contributions. A target cost is not necessarily a bank outflow. Weekly/quarterly/annual averages differ from this month's underfunding.
- Treat balance goals and one-time spending targets as temporary needs. A funded goal does not become a perpetual monthly cost. Snoozing a recurring target does not prove the commitment ended.
- Review existing household debt principal separately from new card spending, interest targets and work debt. debt_paydown covers the additional principal contribution, not a full payment that also settles already-counted purchases.
- Review untargeted categories and intentional exclusions. Excluding a category from recurring commitments does not erase its actual historical spending. Work exclusions come from household policy; work cash outflows still matter to bank liquidity.
- Decide whether the completed spending months represent ordinary spending. Net category activity already includes refunds and split accounting. Historical hidden/deleted expense categories still count when available; missing months/categories prevent a complete claim.
- For cash timing, review all additional future bank movements, including bills, ordinary spending, card payments and transfers. Scheduled obligations are candidates to reconcile, not an automatically complete forecast. Include work cash movements even when excluded from household cost totals.

Only set income_coverage_confirmed, category_coverage_confirmed, debt_coverage_confirmed, spending_window_representative_confirmed and cash_flow_coverage_confirmed when the available evidence and user review support each statement. Do not set them merely to obtain a favorable status.

## Run and explain the analysis

Submit the reviewed inputs to check_sustainability. All views use the same refreshed snapshot and household revision. It saves no draft/report and changes no YNAB data or settings.

Lead with the returned finding and its scope: recurring shortfall, actual spending shortfall, timing shortfall, current funding gap, insufficient evidence, recovery needed, or support under the reviewed assumptions. More than one issue can coexist; inspect all views instead of treating the single status as the entire answer.

Present the relevant results in separate views:

1. **Ongoing budget:** reliable net income versus recurring funding commitments, with variable income shown separately.
2. **Actual spending:** measured net outflow and coverage over completed months, including exceptional spending and refunds.
3. **Current funding:** YNAB target underfunding, overspending, reviewed remaining-cycle top-ups, one-time goals and card floors.
4. **Cash timing:** actual forecast deposit dates, account-specific opening/closing cash and the earliest projected shortfall.

Do not sum these views. Current target underfunding, overspending and remaining needs may overlap. Assigned and Available are not separate cash pools. The calculator deliberately returns no combined catch-up total.

Explain the calendar-average basis and actual payday counts. The cash forecast treats same-day outflows before deposits; verify ordering before presenting such a shortage as certain. A bank balance includes reserved money and pending registered transactions, so it is not discretionary spending room.

If cash coverage, income reliability, target cadence, representative spending or future-month assignments remain uncertain, state the limitation next to the affected result. A favorable recurring target margin alone does not establish that the whole budget is sustainable.

## Route requested changes

This skill remains read-only even when the server permits writes. Do not save a plan, allocate income, edit targets, change transactions or revise household settings because the analysis suggests a change.

Use Explore Impacts for a selected expense or funding tradeoff, Assign Paycheck for received income, and Guided Settings only when it is available and the user requests a policy/setup change. Those workflows prepare their own concrete proposals and use the normal exact-preview approval process.

If a tool is unavailable, disclose that dependency and show only supported evidence. Do not invent a successful calculator invocation or bypass a recovery lock with a fresh proposal.

## Target interpretation

Read [Native target behavior and payday coverage](references/target-semantics.md) when interpreting targets, custom recurrence, current funding or one-time goals. This is the current server contract; preserve its refill/set-aside distinction and household-configured coverage. Use get_target_details rather than a lossy target summary. Existing approval and recovery steps above remain in force.
