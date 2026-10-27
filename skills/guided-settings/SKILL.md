---
name: guided-settings
description: Configure a new or incomplete Budget Brain household, or review and change settings when requested. Guide secure YNAB connection, explicit budget selection, category mappings, funding priorities, exclusions, goals, reserve rules, and approval policy through the available settings interface. Authorized members joining a configured household reuse its setup.
---

# Guided settings

**Instruction draft.** This source describes the guided onboarding workflow. The settings webapp, Firestore persistence API and independent-household membership flow are not implemented by the current server. Discover supported capabilities and deliver a draft when saving is unavailable. See the root README for implementation status.

Help a household save clear, shared budgeting policy without mistaking setup choices for permission to change YNAB. Reuse existing configuration for authorized members.

Read [the runtime contract](references/runtime-contract.md) for authorization, versioned settings, privacy, capability discovery, and exact-change approval.

## Choose the correct path

Resolve identity and membership through the authenticated service before reading private settings. Let server-side membership decide access; a household name or identifier entered in chat cannot grant it.

| Service result | Next action |
|---|---|
| Authorized member; configuration complete | Reuse the saved YNAB connection, budget, hierarchy, and history. Go directly to the requested budgeting task. Offer settings review only if requested. |
| Authorized member; configuration incomplete | Resume the missing setup fields without resetting existing decisions. |
| Authorized member; explicit settings-change request | Load current settings and revision; edit only the requested scope and affected dependencies. |
| No authorized membership | Use the service's supported create/join/invitation path, if available. Do not expose another household or add an unrelated person to an existing deployment's allowlist. |

A second partner joining a configured household does not need to copy a token, select a separate budget, or repeat the questionnaire. Membership still leaves the saved approval policy in force. Do not claim that sharing a private plugin link or creating a second connection automatically synchronizes packaged skills.

## Use secure supported connection and settings tools

Discover the actual settings interface, authentication flow, read/write schemas, and supported target controls. Open the interface only through a returned or documented link; do not invent a URL. For a new household, use supported secure YNAB onboarding and explicit budget selection. Keep credentials in the secure connection flow and server secret store, not chat, Markdown, settings, or public fixtures.

If the interface or persistence API is absent, collect a clearly labeled private settings draft and explain the missing capability. Do not claim it was saved, make an unrelated Page or local file the authoritative store, write directly to a guessed repository path, or request credentials to work around the missing flow.

A budget change can alter every mapping and the available history. Verify the intended budget name/ID, distinguish a test budget, revalidate all affected mappings and state boundaries, and preview the consequences. Never silently choose last-used or reuse another budget's identifiers.

## Gather policy in manageable groups

Reuse valid saved settings and ask only for missing or requested decisions. Preserve undecided fields instead of selecting defaults from historical examples. Explain the practical effect of each choice.

1. **Funding rhythm and income assumptions:** household timezone, payday cadence and next expected dates, planning endpoint, regular versus variable pay, and any bonus that replaces a regular check. Record forecast uncertainty and unresolved overlaps; future income is never assignable before receipt.
2. **Category mappings and targets:** resolve configured roles to fresh budget/category IDs and groups. Disambiguate similar labels and inactive or hidden categories. Record which targets are authoritative, actual repeat intervals, funding windows, and paid-versus-unpaid evidence. Use mappings rather than embedding IDs in reusable skills.
3. **Funding hierarchy:** order overspending, immediate bills, required card reserves, everyday essentials, recurring targets, and dated goals as the household chooses. Establish the planning/protection window, due-date behavior within levels, and explicit shortage/tie handling. Distinguish contribution amounts from desired Available balances.
4. **Cadence and carryover:** establish payday top-ups for weekly categories, monthly and multi-month contribution behavior, excess-balance handling, and the midcycle catch-up rule. Existing funds count once; month boundaries do not create another allowance.
5. **Exclusions and reimbursements:** specify applicable categories/cards and which costs remain outside automatic household funding. Establish the private cross-month unresolved-work ledger, transaction/card attribution, and confirmed reimbursement reconciliation. Expected reimbursement never becomes cash.
6. **Card reserves and payment accounts:** configure eligible cards and reserve floors separately from issuer minimums, interest targets, and optional extra debt payoff. Establish treatment of pending charges, work debt, and proposed excess-reserve withdrawals. Category assignments do not pay cards or move bank cash.
7. **Goals, buffers, and protected balances:** capture desired totals, funding deadlines distinct from event dates, priority where actually agreed, goal caps/stop conditions, and buffer contribution versus balance-floor behavior. Leave unanswered buffer placement, replenishment, and goal ties unresolved.
8. **Approval policy:** require review of exact writes. Preserve the household's existing joint-agreement requirement where configured; do not weaken it for convenience or infer standing authority from setup. Do not add independent two-login approval requirements unless policy actually requires them. Separate settings approval, target edits, allocations, transactions, and other operations.

Use the current runtime schema. For example, settings may expose `budget`, `approval`, `payday`, `hierarchy`, `category_mappings`, `constraints`, and `open_questions`; these are configuration concepts, not invented service tool names. Do not replace unknown supported fields or fabricate a new schema without an explicit implementation task.

## Reconcile and validate

Translate the newest applicable confirmed policy into structured settings while retaining the relevant source, effective date, and scope in private policy history. Old allocation records and questionnaire examples are context, not recurring defaults. Preserve one-time exceptions separately with cycle/expiry; a lower contribution does not necessarily change the saved target.

Validate:

- Schema/version, explicit budget match, active category mappings, hierarchy references, and currency units.
- Required amounts, floor versus contribution semantics, target cadence, deadlines/start dates, and goal caps.
- Consistency between canonical rules and structured settings, including approval requirements and exclusions.
- Known versus unresolved questions; flag contradictions rather than silently choosing one representation.
- Isolation of settings, execution/history state, and secrets. Chat history is not the shared settings store.

Use a proposal-only example from live read data through the tested planner, if available, to show how the settings affect a paycheck. Label an illustrative example when the calculator is unavailable. Do not create transactions, execute assignments, or enable writes merely to test setup.

YNAB target editing is a separate concrete write. Inspect tool support before promising changes to target type or custom recurrence; an amount/date setter may not support them. When necessary, give the user a precise manual target-change checklist and verify a fresh read afterward without claiming the tool performed it.

## Preview and save the requested settings

Show each changed field with current value, proposed value, affected workflow, and material consequences. Show unresolved fields and whether they block normal use. Include settings and canonical-rule changes together where both representations are maintained.

Obtain explicit approval of that exact settings diff under the current policy; if it requires both partners' agreement, obtain explicit confirmation that both agree. Changing the approval policy is itself subject to the current approval policy. Do not treat this approval as permission for the example paycheck or unrelated YNAB edits.

Before saving, re-read or compare the settings revision. On concurrent changes, merge only reviewed compatible intent, present the resulting concrete diff, and renew approval as needed. Persist through the actual authorized versioned service, record audit metadata privately, then re-read the saved version and relevant fields. If no save capability exists, deliver the draft and state that saving remains pending.

Confirm what was actually saved, which budget it applies to, the resulting revision, and any remaining setup questions or unsupported controls. Use server-backed shared settings for both partners; do not claim cross-session persistence from this conversation. Continue to the user's budgeting task with a fresh snapshot when appropriate.
