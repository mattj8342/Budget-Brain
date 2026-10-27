# Paycheck calculator v1 tools

The generic shared runtime contract remains at runtime-contract.md. This document describes the actual v0.9.0 integration and its explicit capability limits.

## plan_paycheck

Required: payday and next_payday (YYYY-MM-DD), income_transaction_ids (actual received RTA inflows).
Optional budget_id is always pinned to the authenticated household.

- mode: new_payday (default), or catch_up.
- bill_resolutions: [{category_id, status: "paid_or_none_due"}] or [{category_id, status: "unpaid", due_date, amount}]. The amount is the complete still-unpaid obligation total for the category through the day before next payday. Do not duplicate scheduled and manually resolved amounts.
- catch_up_topups: [{category_id, available_goal}]. Weekly refill categories need reviewed remaining-cycle goals in catch_up mode; nonweekly categories crossing a month boundary use this field for reviewed Available coverage. These are desired remaining Available balances, not additions.
- weekly_contributions: [{category_id, already_contributed}]. Reviewed net contributions already made for this payday cycle, currency units. Weekly set-aside targets need an explicit value, including zero; monthly net Assigned is not cycle evidence.
- card_gap_reviews: [category_id]. Cards whose debt/reserve gap and funding priority have actually been discussed. This is planning input, not write approval.
- remaining_choices: [{category_id, amount}]. Explicit additional one-time non-card contributions after mandatory stages; not recurring settings and not withdrawals.
- floor_overrides: [{category_id, floor}]. May raise a configured payment Available floor for a verified issuer minimum; may not lower it.

All input amounts are currency units. The calculator converts to integer milliunits. Output financial fields named _milliunits must be divided by 1000 for display. Output assignments contain absolute Assigned amounts in currency units; never treat them as deltas.

The server loads household policy, YNAB current month, future RTA constraints, targets, accounts, transactions and scheduled obligations from one fresh full-budget response. It uses at most the conservative minimum current/future RTA to avoid stealing funds already assigned ahead. Inflow sums are disclosed but never added to RTA.

status needs_clarification includes questions and draft rows for discussion, with no executable assignments or stored plan_id. Resolve questions and call again. status calculated may still include unmet needs; explain shortages rather than claiming everything is funded. When there are positive assignments, it includes a user-bound stored plan_id expiring after 30 minutes.

Target dates alone do not prove bill payment. Scheduled outflows provide due evidence; missing, overdue or ambiguous bills need explicit resolution. Normal horizon excludes next payday; clarify deposit/payment timing separately.

## execute_paycheck_plan

First call: plan_id and cash_and_bills_reviewed=true. Result preview_only contains exact_arguments, proposal_id, preview_token, household_revision and expires_at. No YNAB changes occur.

After exact joint approval: same plan_id, preview_token and both_partners_agree=true. The server checks the original YNAB version and settings revision, uses the shared durable lock/receipt, applies absolute category assignments, verifies fresh month values and saves a private report. verified_complete is the success state.

Plans are bound to the authenticated user and selected budget. The other household member can inspect shared cycle completion using payday, but must create their own plan to execute it.

## get_paycheck_plan

Supply plan_id to read the current user's saved plan and verified result, or payday to read shared cycle completion. active_write reports a held lock. Read before any retry after an uncertain outcome. Missing completion does not prove no write happened; a lock/started receipt needs operator reconciliation.

## Explicit limits

- Extra card payoff needs a reconciled persistent work-expense ledger; v1 does not implement that attribution.
- Current overspending on credit can change card reserves automatically. V1 flags affected combined plans and requires separate correction and refresh.
- No category withdrawals, historical-month writes or bank payments through this planner.
- Quarterly and other nonweekly goals use current monthly suggestions for discussion; the planner does not invent recurrence or permanent goal rankings.
- Bills after month end are reserved in the current month, with positive carryover counted once. Catch-up uses remaining needs from the original cycle.
- Uncertain schedules (including twice-monthly) block automatic execution until resolved.
- Existing generic write tools remain available, but bypassing planner questions with them is not a validated paycheck allocation.
- Verification covers fresh YNAB category values and RTA; the service cannot guarantee bank settlement or atomicity against changes made outside Budget Brain.
