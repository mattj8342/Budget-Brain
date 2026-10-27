# Running a private deployment

The offline demo requires only Node.js 22+, npm ci --ignore-scripts, and npm test. A connected deployment requires infrastructure and credentials you control.

## Runtime configuration

| Variable | Purpose |
|---|---|
| AUTH_MODE | oauth for the authenticated remote service; cloud-run-iam is restricted to private IAM invocation |
| AUTH0_ISSUER | HTTPS issuer root ending in / |
| MCP_RESOURCE_URL | Exact public HTTPS /mcp audience |
| ALLOWED_SUBJECTS | Explicit Auth0 subjects authorized for this configured household |
| YNAB_BUDGET_ID | Explicit budget UUID |
| YNAB_API_TOKEN | Secret Manager injection |
| HOUSEHOLD_REPO | Your private owner/repository containing household/ |
| GITHUB_CONFIG_TOKEN | Secret Manager injection; Contents read access to that private configuration repository |
| WRITE_MODE | read-only by default; full requires OAuth, household configuration and durable storage |
| WRITE_STATE_BUCKET | Private Cloud Storage state bucket for full mode |
| PORT | Cloud Run listen port, normally 8080 |

See server/.env.example for placeholders only. The server does not automatically read a dotenv file.

## Household configuration

Copy examples/household into household/ in your own private configuration repository. Replace the fictional budget/category/account mappings from fresh YNAB data and review every rule. The example policy is designed for the synthetic demo, not a connected budget.

The loader expects household/settings.json, household/rules.md and household/allocation-history/index.json on main. It checks the selected budget and the current exact/joint-approval contract. Amount and target behavior come from live YNAB; priorities and coverage come from settings.

This implementation currently requires exact-change approval and configured joint agreement. Generalizing that contract for other household preferences is additional work. The six skill sources are companion instructions; the hosting client's supported packaging/installation workflow must be used to load them.

## Cloud deployment

Build server/Dockerfile with server/ as its context. Run the container on Cloud Run with a dedicated service identity, the intended OAuth metadata/audience, and the required private storage/secret permissions. The runtime must reach public MCP discovery while the application enforces OAuth on /mcp.

Start with read-only operation. Verify that an anonymous /mcp request returns 401 and that authorized users see only the selected budget. /health returns capability flags; it does not validate every upstream dependency.

Full mode adds real financial write capability. Validate private settings, storage, stale-preview behavior and recovery using synthetic tests and read-only checks first. Financial changes require the supported exact-preview flow and explicit configured approval.

Firestore provisioning is separate from application integration. This reference does not yet route independent households or save settings through a Firestore API.
