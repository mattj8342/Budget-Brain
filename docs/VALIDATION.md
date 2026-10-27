# Public export validation

Reference baseline: server 0.9.0 and generic budgeting skills 1.6.0.

- The original private release passed 135 server tests locally and in Cloud Shell.
- The public export runs the same suite independently with synthetic data.
- The offline demo loads only the fictional files under examples/.
- All six public skill entrypoints are checked for valid skill structure; Guided Settings remains an instruction draft.
- Markdown links, source imports, the example budget contract and public-file allowlist are checked.
- The architecture image is rendered from the edited PowerPoint, inspected visually and included with its editable source.
- Public text and PowerPoint XML are scanned for private budget/user IDs, deployment endpoints, personal financial records, private repository references and credential patterns.
- Runtime credentials, real household history, private plugin bindings, deployment logs, node_modules and private Git history are excluded.

The GitHub workflow installs pinned npm dependencies and runs the synthetic suite. It has no cloud credentials, no deployment step, and read-only repository permissions.

These checks do not certify public multi-household isolation or complete the Firestore/settings-webapp integration. No live YNAB writes are used to validate this export.
