# Native target behavior and payday coverage — server 0.9.0

Use get_target_details after reading household settings. It reads one coherent live snapshot and returns target.kind/type/behavior, amount_milliunits, period_unit, every, recurring, deadline, current_underfunded_milliunits, period_funded_milliunits and period_left_milliunits. Financial output *_milliunits divides by 1000. The upstream get_targets summary can omit custom frequency; monthly cadence with every=3 is quarterly.

Household settings choose mappings, priority, exclusions, reserve policy and payday coverage periods. The general server has no household category names or goal amounts. Live YNAB chooses target amounts, mode, repeat interval and progress. Never copy a lossy connector view over confirmed recurrence or edit targets without a separate request.

## Payday

For each weekly target, preserve its behavior while applying the configured coverage window:
- Refill: reach the configured number of weekly amounts in Available, subtracting existing/projected Available.
- Set aside: make the configured number of weekly contributions, subtracting reviewed contributions already made for this cycle and earlier additions in this plan. Use weekly_contributions; do not infer cycle contributions from monthly net Assigned.
- Catch-up never starts another full allowance. Review remaining-cycle Available for refills and already-made cycle contributions for set-aside targets.
- Other cadences use native remaining funding, not doubled monthly amounts. At a month boundary, nonweekly targets need explicit remaining Available coverage through the next payday; catch_up_topups supplies available_goal. Do not blindly add current-month and future-month underfunding.
- After required Essentials and the configured buffer, review all other eligible targets, including clothing/travel. Show native remaining funding, full recurrence and deadlines. Ask about priority under shortage; remaining_choices chooses contributions. No automatic extra card payoff or trip ranking.

## Cards

Read current card account debt, reserve Available and uncovered gap using verified account/category mappings. Account balance already includes registered uncleared items; do not add them again. With debt_capped_reviewed policy, a fully reserved or zero-debt card gets no addition; reserve proposals cap at outstanding debt. Discuss remaining gaps and priority before choosing the default reserve versus a supported larger contribution. Send card_gap_reviews only for cards whose gap choice was actually reviewed. It is not final write approval. Larger contributions need the existing minimum/attribution evidence; unresolved work debt must not be treated as household payoff.

## One-time targets and Sustainability

Non-recurring spending targets track period funding even when money has been spent. Use remaining_target_funding_milliunits, not full target minus current Available. Have-a-balance goals instead require money still unspent. Unknown period progress is a question; do not invent a balance goal.

Impacts goals accept basis auto, target_progress or available_balance. Auto uses funding progress for non-recurring spending targets, otherwise an Available balance requirement. For target_progress supply the full live target amount as required_balance, so the server can verify it and transform the remaining gap. A hypothetical purchase consumes planned spending funds without automatically requiring them to be replaced. An explicit available_balance basis intentionally requires unspent money. Future income and purchases remain hypothetical.

Sustainability averages actual recurrence (including frequency), labels refill averages as planned spending capacity, and keeps current underfunding, overspending, reviewed cycle needs and one-time gaps separate. Payday coverage is not an extra recurring cost on top of the native weekly target.

All existing signed-preview, exact joint approval, expiry/state checks, replay protection and uncertain-write recovery rules continue. A gap discussion or funding preference is not a second execution approval.
