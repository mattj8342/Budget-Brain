# Transaction tools and runtime limits

Use actual tools from the connected Budget Brain app. Host namespaces differ; names below identify tools, not JavaScript function paths.

## Reads

- get_household_settings: canonical settings/rules and current revision, including approval policy.
- get_accounts: resolve the intended account, type and closed state.
- list_categories: resolve category IDs with their group names. Include hidden categories when an existing entry requires them.
- sync_budget_data: refresh cached YNAB data before uncertain duplicate checks and after execution.
- search_transactions: up to 10 queries; each can filter account_id, since_date, until_date, signed amount_min/amount_max, merchant substring and other supported fields. limit is 1–500; default 50. Do not limit a duplicate search to unapproved or uncategorized entries.
- get_paycheck_plan: with a relevant payday date, read active_write/write_receipt for the same budget. It is not a general list of every transaction receipt; missing state does not establish that an earlier operation did not execute.

Search exact signed amount in the intended account without requiring a merchant match, then compare merchant/date/context. Separately search merchant/date for tip-adjusted or settled amounts when evidence suggests an amount changed. Expand ambiguous candidates; do not consider a purchase on another account a duplicate solely because merchant and amount match. A bank-import ID, known transaction ID and confirmed account are stronger evidence than a name.

Search output is in currency units. YNAB raw API/storage fields may use milliunits: 1000 per currency unit. Follow the actual field contract; do not pass milliunits to these transaction tools.

## apply_transaction_changes (server 0.6.0)

Optional budget_id remains pinned by the server. Include either creates or updates, or both; omit unused arrays rather than sending an empty array. Maximum 100 combined changes.

creates has the same transaction item schema as create_transactions:
account_id, date (YYYY-MM-DD), signed amount in currency units; optional payee_name/payee_id, category_id, memo, cleared, approved, flag_color and subtransactions.

updates has the same transaction item schema as update_transactions:
transaction_id and only reviewed changed fields. For a split replacement include full subtransactions and the reviewed parent amount, even when unchanged. Subtransactions have amount, category_id and optional payee/memo. The parent spending category must be omitted or null. Split amounts must sum exactly in milliunits. Do not target the same transaction twice.

First call: exact operation without preview_token or approval attestation. Response preview_only includes exact_arguments, proposal_id, household_revision, expires_at and preview_token. No YNAB change. Prepare before the final approval question.

Execution: repeat identical operation arguments plus preview_token and both_partners_agree=true after the configured explicit agreement. One approval covers the full exact batch. Do not re-ask for an unchanged, valid, already-approved preview.

The outer gate checks identity, selected budget, signed exact payload, settings revision, expiry and YNAB state, and holds one durable budget write lock/receipt across the batch. It executes updates before creates. Existing upstream create/update handlers preserve remote undo records. Changing a split can replace the original transaction; read current_transaction_id in results.

status applied contains per-item results and underlying stage responses. Confirmed creates return transaction_id and transaction; updates include transaction_id, current_transaction_id, status and transaction. Applied is not a claim of fresh independent verification. Refresh/read back the returned IDs before making that claim.

A missing/error/partial stage stops subsequent stages and leaves the durable lock for reconciliation. Earlier changes can have happened: there is no atomic rollback across these operations or protection against every external YNAB edit. Never replay a whole batch after an uncertain outcome.

## Approval and boundaries

One caller explicitly attests that both partners agree where household policy requires it. Independent partner logins are not required unless actual settings say so. Clarifying categories or confirming receipt arithmetic is not final execution approval. YNAB approved is a stored transaction flag and is independent of both_partners_agree.

No skill provides a platform safety override. Report the exact available error, stage and time without attributing a cause unsupported by evidence. Do not resend through raw APIs, another connector or a different tool to route around a block.

This workflow does not promise bank matching, automatic recurring entries, bank payments, funding changes, automatic duplicate deletion or a transaction history web UI. Propose those separately when requested and supported.

## Offline review scenarios (not live YNAB tests)

- A purchase already correctly split: classify unchanged, no write payload.
- Same amount on two nearby dates: surface both candidates instead of treating the first as the duplicate.
- Existing uncategorized entry plus a genuinely missing purchase: one update/create batch preview, one joint approval, then fresh verification.
- User answers which trip/subscription: treat as clarification; prepare the preview before the one final approval question.
- An exact valid preview is already jointly approved: execute unchanged without another question.
- Timeout after a reported partial stage: stop, inspect recorded state/fresh entries, preserve the lock; do not generate a new preview.
