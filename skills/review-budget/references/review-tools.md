# Review Budget: tool and evidence guide

This reference maps the review to the current Budget Brain server. The shared runtime-contract.md describes broader intended behavior; it is not evidence that every listed capability exists. Use this guide for the deployed read workflow and discover actual tools before invoking optional diagnostics.

## Core reads

| Tool | Purpose / query |
|---|---|
| get_household_settings | First call. Returns revision, settings, rules and imported history index. Use configured budget ID/timezone/exclusions/floors. |
| sync_budget_data | Refresh upstream YNAB caches when freshness matters; once per review is enough unless new changes justify another refresh. Up to five API reads; no YNAB mutation. |
| get_budget_health(budget_id, month) | Triage RTA, overspending, targets, card gaps and uncategorized/unapproved counts. Generic severity is not household priority. |
| get_monthly_budget(budget_id, month, include_hidden?) | Current month income, Assigned, activity, Available, RTA and category hierarchy. Include hidden categories when relevant; hidden does not prove irrelevant. |
| get_target_details(budget_id?) | Complete live target behavior, interval/frequency, deadline, current underfunding and goal-period progress. Prefer over get_targets for recurrence/mode. |
| get_accounts(budget_id) | Bank/card balances, uncleared amounts and paying-account liquidity. Account balances are not additional category money. |
| get_scheduled_transactions(budget_id, due_before) | Upcoming obligations through the review horizon. Omitting due_after avoids hiding overdue schedules. A schedule does not establish that an actual bill was paid. |
| search_transactions(budget_id, queries) | Targeted payment evidence, income and activity since a known allocation. Use date/account/category/payee filters; raise limits or narrow windows when results may be truncated. |
| list_categories(budget_id) | Resolve exact category ID and group, including similarly named categories. |

Read enough to support the requested conclusion; avoid fetching every optional diagnostic. Establish the month explicitly with YYYY-MM-01. Report tool failures or incomplete transaction windows as gaps instead of treating missing data as zero.

## Automatic history discovery and two sources

Call get_latest_allocation_report(budget_id) for an automatic read of the newest completed report across both sources below. It returns status found with report.source/content, none with report=null, or ambiguous_latest with candidates if same-day reports lack enough completion-time precision to order them. active_write and write_receipt expose ongoing/recovery state.

Call list_allocation_reports(budget_id, limit) to browse completed summaries; limit is 1-100 (default 20). Results include total_completed and has_more. Ordering is by completion date in household timezone, then known timestamp, not payday or random object ID. Same-day date-only results do not imply an exact time ordering. The current bounded scan supports up to 1,000 durable objects; errors or incomplete scans never establish an empty/latest history.



**Imported GitHub history:** get_household_settings.history.records lists the imported completed Markdown reports. Call get_household_allocation_history with the listed date. The report date may differ from its actual payday. Read latest applicable rules before interpreting older examples.

**New durable reports:** when get_paycheck_plan is advertised, supply a known payday (YYYY-MM-DD). It returns shared cycle/result, active_write and write_receipt. A known plan_id reads its creator's stored proposal/result; unfinished plans are user-bound. Shared completed cycle reports are retrieved by payday. A null cycle means no durable cycle record for that key, not proof that no write happened or that older imported history is absent.

If get_latest_allocation_report or list_allocation_reports is not advertised, ask the user to refresh server tools. Do not enumerate guessed dates. As a fallback, review a known payday/imported record and disclose that automatic latest discovery is unavailable in that connection.

If active_write or an uncertain/partial receipt exists, report recovery state and avoid proposing a replay. Do not force unlock, undo, or a new preview as part of a review.

## Optional diagnostics

- diagnose_credit_card_debt: investigate card reserve/debt gaps. Suggestions are generic and do not reconcile work-expense attribution. Do not execute returned set_budget_actions.
- get_spending_velocity / get_spending_analysis / get_spending_trends: investigate a spending concern with a stated window and correct treatment of transfers.
- forecast_category_balances: conditional end-of-month estimate based on spending history and schedules. It is not the household's protected-payday plan, can overlap spending assumptions, and does not prove affordability or future bank settlement.
- detect_anomalies: potential duplicates/unusual transactions, not established fraud or permission to delete transactions.
- detect_recurring_charges: evidence of recurring patterns, not permission to create scheduled transactions.

## Units and reasoning

Ordinary YNAB wrapper tools use currency units; inspect the actual schema/result labels. Saved paycheck reports use fields ending _milliunits; divide those by 1000 exactly once. Do not feed a milliunit number into a currency-unit input.

Distinguish Assigned (signed monthly funding), Available (remaining envelope balance), RTA (unassigned money), account cash (liquidity), target underfunding (monthly suggestion), reserve floor and issuer minimum. No single number substitutes for the others.

With a known report, compare rows by category ID and month. Explain subsequent spending, refunds and later assignments rather than treating a lower balance as a failed allocation. Future-month reserves and cash rollover must be reconciled once. Current read tools do not supply one guaranteed atomic snapshot or a comprehensive persistent work ledger.

## Read-only boundary and current limits

This workflow does not mutate YNAB, household settings, reports or execution state. It never calls plan_paycheck, execute_paycheck_plan, create/update/delete tools, category budget/target setters or undo. A selected action becomes a separate explicitly requested workflow.

Sustainability, Impacts and Guided Settings are not yet installed in this plugin version. Do not invoke them as if they exist. Review can summarize actual facts and diagnostic estimates; validated future-paycheck scenarios, settings saving and full work-ledger attribution remain future capabilities.
