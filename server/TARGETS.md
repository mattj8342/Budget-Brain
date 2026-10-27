# Live target semantics — server 0.9.0

get_target_details is an authenticated, budget-scoped read from one coherent YNAB response. It exposes behavior, full period unit/every, raw cadence/frequency, current underfunding, period funded/left, and one-time remaining funding. It writes neither YNAB nor a draft. Unknown behavior/progress is not a guessed balance goal.

target-semantics.mjs is shared by Paycheck, Sustainability and Impacts. NEED goal_needs_whole_amount true means set-aside; false means refill. TB/TBD means unspent balance. MF means monthly contribution. Custom recurrence includes goal_cadence_frequency; monthly cadence with frequency 3 is every three months. The older upstream get_targets summary omits that field.

allocation_policy.target_driven_essentials contains group_ids, priority_category_ids, weekly_refill_periods:2 and buffer_category_id. Legacy weekly_topups/monthly_targets arrays remain supported when the new policy is absent. New policy discovers visible Essentials from the configured groups, applies native remaining funding except for weekly refill payday coverage, and funds the buffer after all Essentials. Excluded mappings fail. No fixed target amounts are copied into policy.

New-payday weekly refills use max(0,2*live_target-projected_available). Catch-up needs reviewed Available goals. At month boundaries nonweekly categories require reviewed coverage via catch_up_topups (currency-unit available_goal), rather than equating this month's underfunding to next month's coverage. Native underfunding and reviewed coverage are combined with max, never added twice. Snoozed or unknown required targets block executable plans.

Sustainability separates recurring average spending/funding capacity, current native target underfunding, reviewed remaining-cycle topups and one-time gaps. Refill averages are planned spending capacity, not guaranteed new contributions after rollover. Buffer payday coverage is not an extra cost on top of its native weekly target.

Impacts goal basis auto uses target_progress for non-recurring NEED; otherwise available_balance. Explicit target_progress requires that goal.required_balance match the live full target amount and known period progress. Internally available threshold = current Available + remaining target funding; hypothetical spending consumes that threshold when the purchase occurs. available_balance deliberately demands unspent money. Unknown progress fails. Existing required-needs protections now include dynamic Essentials and the buffer; forecast income and purchases remain hypothetical. New contributions cannot exceed native one-time target gaps without changing/reviewing the goal itself.

Full OAuth membership, explicit budget ID, exact signed preview, one final configured joint approval, state/calendar/settings expiry checks and durable receipts remain intact. This release makes no target edits or financial writes during verification.

## Payday coverage and reserve review

The configured weekly_refill_periods (1–9) controls both weekly behaviors; it is household data, not a server-fixed two-week amount. A weekly set-aside uses periods*target minus reviewed cycle contributions and earlier plan additions. weekly_contributions contains category_id and already_contributed in currency units. Explicit zero is meaningful; monthly net Assigned is not proof of payday-cycle contributions. Nonweekly targets still use native current remaining funding. Weekly targets outside Essentials follow the same coverage when chosen in the remaining-target stage.

card_reserve_mode=debt_capped_reviewed requires explicit card_floors account_id mappings. Use current full account balance including uncleared items once. Fully reserved/zero-debt cards need no addition; desired reserve=min(configured or reviewed floor,debt). Remaining card gaps are returned for discussion. card_gap_reviews is an array of category IDs whose gap/priority choice has been discussed; it is planning evidence, not execution permission. Larger reserve changes remain explicit floor_overrides and must be supported by verified minimum/non-work attribution. No automatic full-gap payoff or bank payment is introduced.

Remaining target discovery covers all eligible targeted non-bill categories beyond Essentials/buffer, including clothing and travel, with full recurrence/progress. Bills remain handled by verified due obligations, avoiding a second contribution for already-paid bills. The user reviews shortage/deadline priority via remaining_choices; there is no invented permanent trip ranking.

Target-driven household policy uses allocation_policy.schema_version=2. Calculators also accept legacy version 1. Older deployed calculators reject version 2 rather than silently ignoring its required stages during rollout.
