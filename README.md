![Budget Brain architecture](docs/assets/budget-brain-architecture.png)

# Budget Brain

A household budgeting assistant built with reusable AI skills, a YNAB MCP integration, and a server that calculates, previews, and verifies budget changes.

I built Budget Brain for my household to make payday assignments, everyday transactions, and budget decisions easier to review together. This is the public reference version of that work. The connected deployment and real household configuration are maintained privately.

**Interested in a demo or beta access?** [Contact me through GitHub](https://github.com/mattj8342). This repository provides the code, skill sources, and a fictional example household. Access to the connected deployment is by arrangement.

[Architecture slide](docs/assets/budget-brain-architecture.pptx) · [Run the demo](#try-the-calculators) · [Engineering notes](docs/ENGINEERING.md) · [Example household](examples/household) · [Implementation status](#implementation-status)

## What I built

- **Reusable budgeting skills:** separate conversational workflows for payday assignment, budget review, transactions, purchase impacts, sustainability, and guided settings.
- **An MCP wrapper and cloud service:** authenticated Streamable HTTP, explicit budget scoping, private household configuration, and deployment on Google Cloud Run.
- **Deterministic financial calculators:** integer milliunit arithmetic for funding priorities, target behavior, one-time spending impacts, recurring income/cost comparisons, and cash timing.
- **A reviewed write process:** exact signed previews, configured joint approval, version/expiry checks, durable receipts, and recovery after uncertain results.
- **Shared household policy:** reusable instructions stay separate from each household's rules, category mappings, exclusions, and approval preferences.
- **Validation:** 135 server tests, synthetic examples, authenticated HTTP integration tests, and an offline demonstration.

The project builds on [Maronato's YNAB MCP server](https://github.com/Maronato/ynab-mcp). That package supplies the underlying YNAB tool layer. My work adds the household workflows, calculators, authentication adapter, policy checks, cloud persistence, and guarded execution around it. See [third-party notices](THIRD_PARTY_NOTICES.md).

## The skills

| Skill | Purpose | Source status |
|---|---|---|
| [Assign Paycheck](skills/assign-paycheck/SKILL.md) | Fund the household hierarchy from received income, then review an exact proposal. | Implemented |
| [Review Budget](skills/review-budget/SKILL.md) | Review live spending, upcoming bills, reserves, and completed allocation context. | Implemented |
| [Record Transactions](skills/record-transactions/SKILL.md) | Find possible duplicates, then create, categorize, or split the right transaction. | Implemented |
| [Explore Impacts](skills/explore-impacts/SKILL.md) | Compare funding choices and purchases against protected needs and conditional future pay. | Implemented |
| [Check Sustainability](skills/check-sustainability/SKILL.md) | Compare recurring commitments with reliable net income, actual spending, and cash timing. | Implemented |
| [Guided Settings](skills/guided-settings/SKILL.md) | Guide household connection, preferences, and settings review. | Instruction draft; onboarding integration is next |

Skills describe how the assistant should work. Server code performs the calculations and enforces supported write controls. A skill's instructions do not create missing APIs or authorize a budget change.

## Architecture

Auth0 identifies the user. The MCP service scopes requests to the configured household and YNAB budget. The server loads household policy, reads live YNAB data, and returns calculations or an exact write preview. Approved changes pass through the same execution and recovery controls.

The architecture above includes Firestore for household membership/settings and onboarding progress. Cloud Storage retains reports and durable execution records. Secret Manager holds credentials. [Read the architecture and data flow](docs/ARCHITECTURE.md).

### Implementation status

| Component | Current state |
|---|---|
| Five budgeting workflows, calculators, and MCP tools | Implemented and exercised in the private deployment |
| Cloud Run, Auth0 verification, Secret Manager, private report/write storage | Connected in the private deployment |
| Household configuration | Private GitHub configuration loader with commit-pinned reads |
| Firestore | Database provisioned; application integration is the next milestone |
| Guided Settings and onboarding webapp | Instruction source included; settings persistence and account/household onboarding remain to implement |
| Public self-service access | Requires household routing, isolation tests, onboarding, and a validated distribution route |

The deployed service currently supports an explicitly configured household with an authorized-user allowlist. Public multi-household routing is not implemented in this reference. The diagram presents the architecture; the table identifies the implementation boundary.

## Try the calculators

Requires Node.js 22 or later. Tests and the demo use synthetic data and need no account credentials.

```bash
git clone https://github.com/mattj8342/Budget-Brain.git
cd Budget-Brain/server
npm ci --ignore-scripts
npm test
npm run demo
```

The demo reads a [fictional household](examples/household/settings.json) and [synthetic budget snapshot](examples/demo/snapshot.json), calculates a payday proposal, and prints the results. It makes no YNAB calls, creates no execution plan, and writes no budget data. See [the walkthrough](docs/DEMO.md).

To inspect a focused test group:

```bash
node --test target-semantics.test.mjs
```

## A few engineering decisions

**Keep target behavior explicit.** Weekly refill targets count existing Available toward the configured payday window. Weekly set-aside targets count reviewed contributions already made for that cycle. Full recurrence frequency distinguishes a quarterly target from a monthly target. One-time spending progress differs from a requirement to retain an unspent balance.

**Treat a write as a reviewed operation.** A preview binds the exact operation to the authenticated user, budget, household revision, YNAB version, and expiry. A configured joint-agreement flag is the caller's attestation; it does not collect two independent signatures.

**Keep uncertainty visible.** Future income remains conditional. Missing bill status, unknown target semantics, incomplete cash forecasts, and uncertain write results become questions or blockers. A category balance is not proof of bank liquidity.

**Preserve recovery evidence.** Conditional object creation coordinates the write lock and receipts. An uncertain or partial result blocks further writes until reconciled. The YNAB API does not provide an atomic transaction across our version check and every upstream operation.

More detail: [engineering notes](docs/ENGINEERING.md) and [security boundaries](SECURITY.md).

## Repository guide

```text
skills/                 Five implemented workflows and Guided Settings instruction source
server/                 MCP service, calculators, cloud adapter, and tests
examples/household/      Fictional settings, rules, and an empty history index
examples/demo/           Synthetic snapshot for the offline demo
docs/assets/            Architecture image and editable PowerPoint slide
docs/                   Architecture, demo, setup, and validation notes
```

The example data is fabricated. Real budget identifiers, account connections, household history, tokens, logs, and private deployment identifiers are excluded from this repository.

## Next integration milestones

1. Connect Firestore through the service identity.
2. Resolve each authenticated user to their own household, budget, and credential reference.
3. Build the onboarding/settings webapp and connect Guided Settings to its APIs.
4. Verify isolation and settings migration before inviting a second independent household.
5. Run an invited-user walkthrough and validate the plugin installation route.

## Development and licensing

I developed this project with AI-assisted coding and iteration, using the household workflow as the product brief and tests to check supported behavior.

This is a public showcase. A project-wide reuse license has not been selected. Third-party dependencies retain their own licenses; see [notices](THIRD_PARTY_NOTICES.md).
