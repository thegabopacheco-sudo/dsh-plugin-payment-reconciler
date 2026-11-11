# How dsh-plugin-payment-reconciler works

Cross-checks orders against payments from local CSV/JSON files and reports differences. No network: file reads and local computation only.

## Architecture

```
DSH ──MCP stdio──► server.mjs (single-file bundle)
                    ├─ config.json (allowedPaths, tolerances)
                    ├─ CSV/JSON parsers
                    ├─ in-memory reconciler
                    └─ report (only write, confirm:true)
```

1. `load_orders` / `load_payments` read the file, detect format (extension and content), delimiter and header, and normalize ids, amounts (`1.234,56` and `$1,234.56`) and dates (`2026-01-10`, `10/01/2026`, ISO with time).
2. Normalized records stay **in the server process memory** (no data cache is written).
3. `reconcile` indexes payments by order id and classifies each order: match, missing payment, duplicate, amount/date/currency difference or record without amount. Then it lists payments that do not belong to any order.
4. `report` rebuilds the reconciliation and writes Markdown or JSON.

## Matching rules

- Normalized id: lowercase, no accents, leading `#` stripped and separators removed (`O-1001` ≡ `o1001`).
- Amount with absolute tolerance (default `0.01`).
- Date with day tolerance (default `1`); if either side has no date it is not evaluated.
- Order of checks: id, amount, currency, date — each difference is reported in its own section.

## Safety

- Read by default; `reconcile` only analyses.
- `report` requires `confirm:true`, path inside `allowedPaths`, and never overwrites existing files.
- `read-only` mode via `DSH_PAYMENTS_MODE=read-only`.
- Path allowlist in `config.json` + `DSH_PAYMENTS_ALLOWED_PATHS`.
- Audit at `<DSH_HOME>\cache\payment-reconciler\audit.jsonl`: tool, paths, counts and errors; never full rows.
- Limits: 5 MB and 50,000 rows per file; per-tool rate limit.

## Validation

End-to-end tests with the official MCP client (`@modelcontextprotocol/client@2.2.0`) over temporary files:

```
cd dsh-plugin-payment-reconciler
npm install --no-audit --no-fund
node --check server.mjs
npm run build:bundle
cd test && npm install --no-audit --no-fund && node connect-test.mjs
```

The test loads CSV orders and JSON payments covering match, missing, duplicate, amount/date/currency differences, missing amount and payment without order; it checks reports and the `confirm:true`, `allowedPaths` and read-only blocks. The packaged artifact is validated with `tools/verify-artifact.ps1`.
