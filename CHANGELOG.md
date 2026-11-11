# Changelog

## 0.1.0 — 2026-11-11

- Primera versión de dsh-plugin-payment-reconciler.
- Tools MCP `payments`: `status`, `load_orders`, `load_payments`, `reconcile` y `report`.
- Carga de pedidos y pagos desde CSV/JSON local, con detección de formato, separador y encabezado.
- Conciliación por id con tolerancias de monto y fecha; faltantes, duplicados, diferencias de monto/fecha/moneda, registros sin monto, pagos sin pedido y totales por moneda.
- Reporte Markdown/JSON de la única escritura, con `confirm:true`, `allowedPaths` y sin sobrescritura.
- Modo read-only con `DSH_PAYMENTS_MODE=read-only`, auditoría en `<DSH_HOME>/cache/payment-reconciler/audit.jsonl`, rate limit y límites de tamaño.
- Tests end-to-end locales con `@modelcontextprotocol/client@2.2.0`.
