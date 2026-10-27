# Budget Brain server

Server 0.9.0 is a Node.js MCP adapter around @maro-org/ynab-mcp, with household policy, deterministic calculators, guarded writes and cloud persistence.

From this folder, run npm ci --ignore-scripts, npm test and npm run demo. Tests and the offline demo require no YNAB or cloud credentials.

See ../docs/SETUP.md for private deployment configuration, ../docs/ENGINEERING.md for module responsibilities and limits, and ../SECURITY.md for authorization/recovery boundaries. TARGETS.md documents native target behavior and current calculator inputs.

The current connected service is scoped to one explicitly configured budget and authorized-subject allowlist. Database-backed household routing and onboarding APIs are the next integration milestone.
