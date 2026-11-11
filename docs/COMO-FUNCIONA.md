# Cómo funciona dsh-plugin-payment-reconciler

Cruza pedidos contra pagos desde CSV/JSON locales y reporta diferencias. No hay red: solo lectura de archivos y cómputo local.

## Arquitectura

```
DSH ──MCP stdio──► server.mjs (bundle single-file)
                    ├─ config.json (allowedPaths, tolerancias)
                    ├─ parsers CSV/JSON
                    ├─ conciliador en memoria
                    └─ report (única escritura, confirm:true)
```

1. `load_orders` / `load_payments` leen el archivo, detectan formato (extensión y contenido), separador y encabezado, normalizan ids, montos (`1.234,56` y `$1,234.56`) y fechas (`2026-01-10`, `10/01/2026`, ISO con hora).
2. Los registros normalizados quedan **en memoria del proceso** (no se escribe ningún caché con datos).
3. `reconcile` indexa los pagos por id de pedido y clasifica cada pedido: coincidencia, pago faltante, duplicado, diferencia de monto/fecha/moneda o registro sin monto. Después lista los pagos que no corresponden a ningún pedido.
4. `report` reconstruye la conciliación y escribe Markdown o JSON.

## Reglas de matching

- Id normalizado: minúsculas, sin acentos, sin `#` inicial y sin separadores (`O-1001` ≡ `o1001`).
- Monto con tolerancia absoluta (default `0.01`).
- Fecha con tolerancia en días (default `1`); si falta fecha en alguna fuente no se evalúa.
- Primero id, después monto, después moneda y después fecha: cada diferencia se reporta en su sección.

## Herramientas reales

- `status`: Estado de Payment Reconciler
- `load_orders`: Cargar pedidos
- `load_payments`: Cargar pagos
- `reconcile`: Conciliar pedidos vs pagos
- `report`: Generar reporte

## Seguridad

- Lectura por defecto; `reconcile` solo analiza.
- `report` requiere `confirm:true`, ruta dentro de `allowedPaths` y no sobrescribe archivos existentes.
- Modo `read-only` con `DSH_PAYMENTS_MODE=read-only`.
- Lista blanca de rutas en `config.json` + `DSH_PAYMENTS_ALLOWED_PATHS`.
- Auditoría en `<DSH_HOME>\cache\payment-reconciler\audit.jsonl`: herramienta, rutas, conteos y errores; nunca filas completas.
- Límites: 5 MB y 50 000 filas por archivo; rate limit por herramienta.

## Verificación

Tests end-to-end con el cliente MCP oficial (`@modelcontextprotocol/client@2.2.0`) sobre archivos temporales:

```
cd dsh-plugin-payment-reconciler
npm install --no-audit --no-fund
node --check server.mjs
npm run build:bundle
cd test && npm install --no-audit --no-fund && node connect-test.mjs
```

El test carga pedidos CSV y pagos JSON con casos de coincidencia, faltante, duplicado, diferencia de monto, diferencia de fecha, moneda distinta, registro sin monto y pago sin pedido; verifica reportes y bloqueos por `confirm:true`, `allowedPaths` y read-only. El artefacto empaquetado se valida con `tools/verify-artifact.ps1`.
