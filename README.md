# dsh-plugin-payment-reconciler — Conciliador de pedidos y pagos

Cruza pedidos contra pagos desde CSV/JSON locales: coincidencias por id, monto y fecha; faltantes, duplicados, diferencias de moneda y totales por moneda. Todo local, sin red ni credenciales.

## Herramientas

| Tool | Qué hace |
|---|---|
| `status` | Estado de Payment Reconciler |
| `load_orders` | Cargar pedidos |
| `load_payments` | Cargar pagos |
| `reconcile` | Conciliar pedidos vs pagos |
| `report` | Generar reporte |

## Formatos de entrada

CSV con encabezado (coma, punto y coma o tab) o JSON:

- **Pedidos**: `id` / `order_id`, `amount` / `monto` / `total`, `date` / `fecha`, `currency` / `moneda`.
- **Pagos**: `order_id` / `pedido_id` / `reference` (id del pedido), `payment_id` / `id` / `transaction_id`, monto, fecha y moneda.
- Ayuda la detección de montos con símbolos (`$1,234.56`, `1.234,56`) y fechas ISO (`2026-01-10`) o `dd/mm/aaaa`.
- JSON: arreglo de objetos, o `{ "orders": [...] }` / `{ "payments": [...] }` / `{ "data": [...] }`. También JSON por líneas (`.jsonl`).

### Clasificación de `reconcile`

- **Coinciden**: un pedido con un pago, mismo id, monto dentro de tolerancia y fecha dentro de tolerancia.
- **Faltan pagos**: pedidos sin ningún pago.
- **Pagos duplicados**: pedidos con más de un pago.
- **Diferencias de monto / fecha / moneda**: coinciden por id pero no por esos campos.
- **Sin monto verificable**: registro sin monto en alguna de las dos fuentes.
- **Pagos sin pedido**: pagos cuyo id de pedido no existe en los pedidos.
- **Ids de pedido repetidos**: el mismo id aparece dos veces en el archivo de pedidos.

Tolerancias por defecto: monto ±0.01 y fecha ±1 día (configurables en `config.json` o por argumento).

## Ejemplo

```
status
load_orders  { "path": "C:\\datos\\pedidos.csv" }
load_payments { "path": "C:\\datos\\pagos.json" }
reconcile    { "dateToleranceDays": 0 }
report       { "path": "C:\\datos\\conciliacion.md", "format": "md", "confirm": true }
```

## Configuración

`<DSH_HOME>\payment-reconciler\config.json` (se crea solo):

```json
{
  "allowedPaths": ["C:\\datos"],
  "amountTolerance": 0.01,
  "dateToleranceDays": 1
}
```

- `allowedPaths` vacío = cualquier ruta local. Se puede complementar con `DSH_PAYMENTS_ALLOWED_PATHS` (separadas por `;`).
- El reporte sin `path` se escribe en `<DSH_HOME>\cache\payment-reconciler\`.

## Seguridad

- Lectura por defecto; `reconcile` solo analiza y funciona incluso en read-only.
- Única escritura: `report` con `confirm:true`, ruta dentro de `allowedPaths` y sin sobrescribir archivos existentes.
- `DSH_PAYMENTS_MODE=read-only` desactiva la escritura.
- Auditoría en `<DSH_HOME>\cache\payment-reconciler\audit.jsonl` (sin datos crudos, solo conteos y rutas).
- Rate limit de acciones y límite de 5 MB / 50 000 filas por archivo.

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-payment-reconciler` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-payment-reconciler
```

Requisitos: Node >= 20.

## Licencia

MIT © thegabopacheco-sudo
