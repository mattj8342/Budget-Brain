# Security boundaries

This repository contains a public reference implementation and fictional examples. The connected household deployment and its secrets/configuration remain private.

## Implemented controls

- Verify access token signature, issuer, audience, expiry and required claims on MCP requests.
- Authorize the verified subject against the deployment allowlist.
- Pin tool calls to an explicit budget.
- Load a consistent, budget-matching private household configuration.
- Bind exact write previews to the user, budget, operation, settings revision, upstream version and expiry.
- Coordinate retries with durable receipts and conditional object creation.
- Preserve locks/evidence for uncertain or partial outcomes.
- Log request/tool/outcome diagnostics without logging authorization headers, full argument payloads, or financial response bodies.

## Boundaries

The current service is configured for one household. Firestore-backed household routing and isolation need implementation and testing before independent households share the service. Client Firestore rules do not substitute for authorization in a privileged server.

Joint approval is an explicit caller attestation, not two independent signatures. Stale checks cannot make a sequence of upstream YNAB writes atomic. A held lock must be reconciled rather than deleted to force a retry.

Secrets belong in the deployment's secret store. Keep real budget IDs, household settings, account connections, receipts, allocation reports and operational logs out of public issues and commits.

For a security concern, contact the maintainer through the linked GitHub profile with a minimal description. Do not post credentials or real financial data publicly.
