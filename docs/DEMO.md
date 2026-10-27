# Offline demo

From server/:

```bash
npm ci --ignore-scripts
npm test
npm run demo
```

demo.mjs reads examples/household/settings.json and examples/demo/snapshot.json. All identifiers, accounts, dates, amounts and category activity in those files are synthetic.

The example applies this household's chosen order:

1. Unpaid monthly bills before next payday.
2. Annual bills before next payday.
3. Reviewed card reserve, capped at outstanding debt.
4. Essentials, respecting refill versus set-aside behavior.
5. Required payday buffer.
6. Selected travel and clothing target contributions.

The example also contains an excluded work category. The calculator does not automatically fund that balance.

Weekly coverage and card reserve amounts are example household choices. They are not globally hardcoded defaults. Reviewed cycle contributions are explicit inputs, not inferred from monthly net Assigned.

The script prints a calculation and demonstrates target recurrence. It calls no MCP execution tool, reads no credentials, saves no plan, and performs no YNAB request.

The full tests additionally exercise signed previews and execution lifecycle against mocks. Nothing in the demo is approval to run a financial change.
