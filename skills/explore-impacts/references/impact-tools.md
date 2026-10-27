# Impact tools and calculator contract

Server 0.9.0 exposes these tools when household/full-write configuration is enabled. Discover actual tools; do not fabricate missing names.

| Tool | Effect |
|---|---|
| get_household_settings | Read private rules, settings and revision. |
| get_latest_allocation_report | Read newest completed allocation and recovery context. |
| compare_impacts | Read one current snapshot, calculate baseline/options; no draft or YNAB writes. |
| prepare_impact_plan | Save an eligible, user-bound funding draft; no YNAB write. |
| get_impact_plan | Read a plan/result by ID, or latest verified household impact result without ID; includes shared lock/receipt. |
| execute_impact_plan | Signed preview first; exact approved category funding only, then verify and save outcome. |

## compare_impacts input

- budget_id: optional; server pins the authorized household budget.
- next_payday: YYYY-MM-DD, after the snapshot date, within 62 days.
- horizon_end: optional YYYY-MM-DD; covers next payday and every reviewed goal. Maximum 366 days from snapshot.
- remaining_needs: [{category_id, amount}]. Currency units of desired Available still needed through next payday, after existing spending. This is not an additional assignment amount.
- bill_resolutions: [{category_id, status: "paid_or_none_due"}] or [{category_id, status: "unpaid", due_date, amount}]. Use evidence and reviewed dates, including overdue unpaid bills.
- goals: [{category_id, due_date, required_balance, basis: "auto" | "target_progress" | "available_balance", include_payday_on_deadline: false}]. Auto uses native period funding progress for a non-recurring spending target; otherwise desired Available. For target_progress required_balance must match the full live target amount. Read target-semantics.md. Optional same-day-payroll inclusion must be deliberate.
- goal_order_confirmed: true only when the input order is the reviewed funding priority; otherwise multiple goals are not allocated forecast room.
- paychecks: [{date, amount, committed_amount, commitments_confirmed, account_id?}]. Only confirmed net room is available for goal projection. Expected income is never current RTA. Account ID enables projected bank inflow.
- cash_events: [{date, account_id, amount, distinct_from_recorded_confirmed?}]. Signed currency units for additional future movements. Already registered transactions are already in balances.
- cash_events_complete: false by default; true only with reviewed coverage through horizon.
- scenarios: [] for baseline/context, or up to five [{id, label, moves, purchase?}].
- moves: [{from_category_id, to_category_id, amount}], amount positive. Endpoint is an actual category UUID or literal "ready_to_assign". Funding totals must conserve money.
- purchase: {category_id, account_id, amount, date, counts_toward_remaining_need?, distinct_from_recorded_confirmed?}. Positive currency amount. The server projects spending but never records it.

Use explicit choices, not invented default priorities or expected-income certainty. Server flags unknown/protected needs, unsafe sources, unfunded purchases, goal caps, duplicate-looking events and related future-month assignments.

## Output and interpretation

All fields ending _milliunits are integer YNAB units; divide by 1000 for currency display. Input amounts are currency units with at most three decimals.

comparison_fingerprint binds normalized assumptions, household revision, budget version and calendar. The result includes baseline, options, questions and recovery context. Option rows separate current funding changes from projected post-purchase balances; assignments are absolute resulting Assigned amounts, not deltas.

execution_eligible is a funding safety check, not a guarantee of future affordability. Future cash/income coverage and goal commitments must remain labeled. Deadline shortfall follows the provided forecast; even_spread_requirement_milliunits is a separate required-rate illustration. No completion date is invented past an unmet deadline.

No automatic recurring-target simulation, future-month assignment reconciliation, work expense attribution/extra payoff, bank transfers or purchases are executable in this version. Card purchases project new debt and funded payment reserve only; no bank payment is submitted.

## Draft, preview, approval and recovery

1. prepare_impact_plan({comparison_input: originalInput, comparison_fingerprint, scenario_id}) recomputes fresh state. stale_comparison means compare/review again; not_executable means resolve blockers. Prepared plans expire in 30 minutes and are bound to the creating household member.
2. execute_impact_plan({plan_id, impacts_reviewed:true}) produces the signed preview. Show it before one final configured joint approval.
3. execute_impact_plan({plan_id, preview_token, both_partners_agree:true}) executes the same proposal. Changed budget, settings, calendar or expiry blocks. Do not request duplicate approval for the unchanged valid preview.
4. get_impact_plan({plan_id}) reads durable result. No ID returns latest verified household impact report. Only verified_complete is confirmed success. A receipt replay returns prior results without executing again.

Private Cloud Storage paths within the existing household budget prefix:

- impact-plans/<plan_id>.json: user-bound draft.
- impact-results/<plan_id>.json: upstream evidence immediately after the write returns, then verified result.
- impact-latest.json: pointer to latest verified completion only.
- Existing write-lock.json and receipts/: shared recovery and replay protection across write workflows.

A partial upstream response, missing result or failed verification retains evidence/recovery state; do not claim nothing happened or retry automatically. The category write is sequential and cannot be promised atomic against concurrent external edits.
