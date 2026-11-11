# dsh-plugin-payment-reconciler — Orders vs payments reconciler

Cross-checks orders against payments from local CSV/JSON files: matches by id, amount and date; missing payments, duplicates, currency differences and per-currency totals. Fully local, no network, no credentials.

## Tools

| Tool | Qué hace |
|---|---|
| `status` | Estado de Payment Reconciler |
| `load_orders` | Cargar pedidos |
| `load_payments` | Cargar pagos |
| `reconcile` | Conciliar pedidos vs pagos |
| `report` | Generar reporte |

## Input formats

CSV with header (comma, semicolon or tab) or JSON:

- **Orders**: `id` / `order_id`, `amount` / `total`, `date`, `currency`.
- **Payments**: `order_id` / `pedido_id` / `reference` (order id), `payment_id` / `id` / `transaction_id`, amount, date and currency.
- Amounts with symbols (`$1,234.56`, `1.234,56`) and ISO (`2026-01-10`) or `dd/mm/yyyy` dates are parsed.
- JSON: array of objects, or `{ "orders": [...] }` / `{ "payments": [...] }` / `{ "data": [...] }`. JSON-lines files (`.jsonl`) are accepted.

### `reconcile` classification

- **Matched**: one order and one payment, same id, amount within tolerance, date within tolerance.
- **Missing payments**: orders with no payment.
- **Duplicate payments**: orders with more than one payment.
- **Amount / date / currency differences**: matched by id but not by that field.
- **Unverifiable amount**: record without an amount on either side.
- **Payments without order**: payment order id not found in orders.
- **Repeated order ids**: same id twice in the orders file.

Default tolerances: amount ±0.01 and date ±1 day (configurable in `config.json` or per call).

## Example

```
status
load_orders   { "path": "C:\\data\\orders.csv" }
load_payments { "path": "C:\\data\\payments.json" }
reconcile     { "dateToleranceDays": 0 }
report        { "path": "C:\\data\\reconciliation.md", "format": "md", "confirm": true }
```

## Configuration

`<DSH_HOME>\payment-reconciler\config.json` (created automatically):

```json
{
  "allowedPaths": ["C:\\data"],
  "amountTolerance": 0.01,
  "dateToleranceDays": 1
}
```

- Empty `allowedPaths` = any local path. Can also be set with `DSH_PAYMENTS_ALLOWED_PATHS` (separated by `;`).
- A report without `path` goes to `<DSH_HOME>\cache\payment-reconciler\`.

## Safety

- Read by default; `reconcile` only analyses and works even in read-only mode.
- Only write: `report` with `confirm:true`, path inside `allowedPaths`, never overwrites existing files.
- `DSH_PAYMENTS_MODE=read-only` disables writing.
- Audit at `<DSH_HOME>\cache\payment-reconciler\audit.jsonl` (no raw records, only counts and paths).
- Action rate limit and 5 MB / 50,000 rows per file.

## Installation

From **DSH → Settings → Plugins** install `github:thegabopacheco-sudo/dsh-plugin-payment-reconciler` and allow the install script.

```
dsh plugin --profile <profile> add github:thegabopacheco-sudo/dsh-plugin-payment-reconciler
```

Requirements: Node >= 20.

## License

MIT © thegabopacheco-sudo
