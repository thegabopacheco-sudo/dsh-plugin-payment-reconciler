#!/usr/bin/env node
// dsh-plugin-payment-reconciler — conciliación de pedidos contra pagos para DeepSeek Harness.
// Tools: status, load_orders, load_payments, reconcile, report.
// Todo local: CSV/JSON en disco, sin red, sin credenciales.
// Lectura por defecto; la única escritura es report con confirm:true (nunca sobrescribe).

import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, realpathSync, statSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const SLUG = 'payment-reconciler';
const SERVER_NAME = 'payments';
const DSH_HOME = (() => {
  const v = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  if (v) return v;
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, SLUG, 'config.json');
const CACHE_DIR = path.join(DSH_HOME, 'cache', SLUG);
const AUDIT_FILE = path.join(CACHE_DIR, 'audit.jsonl');
const READ_ONLY = String(process.env.DSH_PAYMENTS_MODE || '').toLowerCase() === 'read-only';
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 50_000;
const MAX_REPORT_ITEMS = 200;

const log = (m) => process.stderr.write(`[payments] ${m}\n`);

function audit(entry) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

const rateBuckets = new Map();
function rateLimit(bucket = 'read', max = 180, windowMs = 60_000) {
  const now = Date.now();
  const hits = (rateBuckets.get(bucket) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= max) throw new Error(`rate limit: demasiadas acciones (${bucket}); espera un minuto`);
  hits.push(now);
  rateBuckets.set(bucket, hits);
}

const state = { orders: null, payments: null, lastReconcile: null };

// ---------------------------------------------------------------- configuración

function defaultConfig() {
  return {
    allowedPaths: [],
    amountTolerance: 0.01,
    dateToleranceDays: 1,
    note: 'allowedPaths vacío = cualquier ruta local. amountTolerance/dateToleranceDays se usan por defecto en reconcile.',
  };
}

function loadConfig() {
  try {
    if (existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {};
      const base = defaultConfig();
      return {
        ...base,
        ...parsed,
        allowedPaths: Array.isArray(parsed.allowedPaths) ? parsed.allowedPaths.map(String) : base.allowedPaths,
      };
    }
  } catch (error) {
    log(`config inválida: ${error.message}`);
  }
  return defaultConfig();
}

function saveConfig(config) {
  mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function allowedRoots() {
  const roots = [];
  const env = String(process.env.DSH_PAYMENTS_ALLOWED_PATHS || '').trim();
  if (env) {
    for (const part of env.split(path.delimiter)) if (part.trim()) roots.push(path.resolve(part.trim()));
  }
  for (const p of loadConfig().allowedPaths) if (String(p).trim()) roots.push(path.resolve(String(p).trim()));
  return [...new Set(roots)];
}

function isInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  const escapes = process.platform === 'win32' ? rel.toLowerCase().startsWith('..') : rel.startsWith('..');
  return !escapes && !path.isAbsolute(rel);
}

function assertAllowed(candidate) {
  const roots = allowedRoots();
  if (roots.length === 0) return; // sin allowlist: cualquier ruta local
  if (roots.some((root) => isInside(root, candidate))) return;
  throw new Error(`ruta fuera de allowedPaths: ${path.resolve(candidate)}. Permitidas: ${roots.join('; ')}`);
}

function resolveReadable(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) throw new Error('path obligatorio (archivo CSV o JSON)');
  let resolved = path.resolve(raw);
  assertAllowed(resolved);
  if (!existsSync(resolved)) throw new Error(`archivo no encontrado: ${resolved}`);
  let stat;
  try { stat = statSync(resolved); } catch (error) { throw new Error(`no se pudo leer ${resolved}: ${error.message}`); }
  if (!stat.isFile()) throw new Error(`no es un archivo regular: ${resolved}`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`archivo demasiado grande: ${stat.size} bytes (máximo ${MAX_FILE_BYTES})`);
  try { resolved = realpathSync.native(resolved); } catch { /* ruta válida sin realpath */ }
  assertAllowed(resolved);
  return resolved;
}

function resolveWritable(inputPath) {
  const resolved = path.resolve(String(inputPath || '').trim());
  if (!inputPath || !String(inputPath).trim()) throw new Error('path obligatorio para el reporte');
  assertAllowed(resolved);
  return resolved;
}

// ---------------------------------------------------------------- parsing CSV/JSON

const normKey = (value) => String(value)
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '');

const ID_KEYS = ['id', 'orderid', 'idpedido', 'pedidoid', 'paymentid', 'pagoid', 'transactionid', 'transaccion', 'txn', 'uuid'];
const ORDER_KEYS = ['orderid', 'idpedido', 'pedidoid', 'order', 'pedido', 'orden', 'orderreference', 'reference', 'ref', 'folio'];
const AMOUNT_KEYS = ['amount', 'monto', 'total', 'importe', 'valor', 'cantidad', 'price', 'subtotal'];
const DATE_KEYS = ['date', 'fecha', 'fechapago', 'paidat', 'createdat', 'fechapedido', 'orderdate', 'timestamp', 'ts'];
const CURRENCY_KEYS = ['currency', 'moneda', 'divisa', 'coin'];
const KNOWN_HEADERS = new Set([...ID_KEYS, ...ORDER_KEYS, ...AMOUNT_KEYS, ...DATE_KEYS, ...CURRENCY_KEYS,
  'status', 'estado', 'method', 'metodo', 'note', 'nota', 'cliente', 'customer', 'email', 'correo']);

function parseCsvRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
      row = [];
    } else if (ch === '\r') {
      /* saltar CR */
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0].trim() === '')) rows.push(row);
  }
  return rows;
}

function parseCsvRecords(text) {
  const cleaned = text.replace(/^\uFEFF/, '');
  const firstLine = cleaned.split(/\r?\n/, 1)[0] || '';
  const counts = [
    [',', (firstLine.match(/,/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  const delimiter = counts[0][1] > 0 ? counts[0][0] : ',';
  const rows = parseCsvRows(cleaned, delimiter);
  if (rows.length === 0) return { records: [], skipped: [], delimiter, hasHeader: false };
  const hasHeader = rows[0].some((cell) => KNOWN_HEADERS.has(normKey(cell)));
  const headers = hasHeader ? rows[0].map(normKey) : rows[0].map((_, index) => `col${index + 1}`);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const records = [];
  const skipped = [];
  for (let index = 0; index < dataRows.length; index++) {
    if (index >= MAX_ROWS) { skipped.push({ row: index + 1, reason: `máximo ${MAX_ROWS} filas` }); break; }
    const row = dataRows[index];
    const map = {};
    headers.forEach((key, column) => { if (key) map[key] = row[column] ?? ''; });
    if (Object.values(map).every((value) => String(value).trim() === '')) continue;
    const record = extractRecord(map, { hasHeader });
    if (!record.id) { skipped.push({ row: index + (hasHeader ? 2 : 1), reason: 'sin id utilizable' }); continue; }
    records.push(record);
  }
  return { records, skipped, delimiter, hasHeader, headers };
}

function parseJsonRecords(text) {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  let payload;
  try { payload = JSON.parse(trimmed); } catch {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim() !== '');
    payload = lines.map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`JSON inválido en la línea ${index + 1}`); }
    });
  }
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    for (const key of ['orders', 'order', 'pedidos', 'payments', 'pagos', 'data', 'rows', 'items', 'records', 'results']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
  }
  throw new Error('JSON debe ser un arreglo de objetos (o {orders|payments|data|rows|items|records: [...]})');
}

function toPlainMap(record) {
  const map = {};
  if (!record || typeof record !== 'object' || Array.isArray(record)) return map;
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    map[normKey(key)] = String(value).trim();
  }
  return map;
}

function extractRecord(map, options = {}) {
  const pick = (keys) => {
    for (const key of keys) {
      const value = map[key];
      if (value !== undefined && String(value).trim() !== '') return String(value).trim();
    }
    return '';
  };
  let id = pick(ORDER_KEYS);
  const orderId = id;
  const paymentId = pick(['id', 'paymentid', 'pagoid', 'transactionid', 'transaccion', 'txn', 'uuid']);
  const genericId = pick(ID_KEYS);
  if (!id) id = paymentId || genericId;
  const amountRaw = pick(AMOUNT_KEYS);
  const dateRaw = pick(DATE_KEYS);
  return {
    id,
    idKey: normKey(id).replace(/^#+/, ''),
    orderId,
    orderRef: orderId || id,
    paymentId,
    amount: parseAmount(amountRaw),
    amountRaw,
    date: parseDate(dateRaw),
    dateRaw,
    currency: pick(CURRENCY_KEYS).toUpperCase() || '',
    status: pick(['status', 'estado']),
  };
}

function parseAmount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(/[^\d.,+\-]/g, '');
  if (!text) return null;
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const decimal = lastComma > lastDot ? ',' : '.';
    const thousands = decimal === ',' ? '.' : ',';
    text = text.split(thousands).join('');
    text = text.replace(decimal, '.');
  } else if (lastComma >= 0) {
    const parts = text.split(',');
    text = parts.length === 2 && parts[1].length <= 2 ? `${parts[0]}.${parts[1]}` : parts.join('');
  } else if ((text.match(/\./g) || []).length > 1) {
    const parts = text.split('.');
    const last = parts[parts.length - 1];
    text = last.length <= 2 ? `${parts.slice(0, -1).join('')}.${last}` : parts.join('');
  }
  const number = Number(text);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}

function isoDate(year, month, day) {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (match) {
    let first = Number(match[1]);
    let second = Number(match[2]);
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    // dd/mm por defecto; si el primero no puede ser día, se interpreta mm/dd.
    if (first > 12 && second <= 12) { const tmp = first; first = second; second = tmp; }
    return isoDate(year, second, first);
  }
  const stamp = Date.parse(text);
  if (!Number.isNaN(stamp)) {
    const dt = new Date(stamp);
    return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return null;
}

function dayDiff(a, b) {
  if (!a || !b) return null;
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

function loadFile(inputPath, formatHint) {
  const resolved = resolveReadable(inputPath);
  let text;
  try { text = readFileSync(resolved, 'utf8'); } catch (error) { throw new Error(`no se pudo leer ${resolved}: ${error.message}`); }
  const ext = path.extname(resolved).toLowerCase();
  const hint = String(formatHint || 'auto').toLowerCase();
  let format;
  if (hint === 'csv') format = 'csv';
  else if (hint === 'json') format = 'json';
  else if (ext === '.csv' || ext === '.tsv') format = 'csv';
  else if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson') format = 'json';
  else format = text.trim().startsWith('[') || text.trim().startsWith('{') ? 'json' : 'csv';

  let records;
  let skipped;
  let extra = {};
  if (format === 'csv') {
    const parsed = parseCsvRecords(text);
    records = parsed.records;
    skipped = parsed.skipped;
    extra = { delimiter: parsed.delimiter, hasHeader: parsed.hasHeader };
  } else {
    const raw = parseJsonRecords(text);
    records = [];
    skipped = [];
    raw.forEach((row, index) => {
      if (index >= MAX_ROWS) return;
      const record = extractRecord(toPlainMap(row), { hasHeader: true });
      if (!record.id) { skipped.push({ row: index + 1, reason: 'sin id utilizable' }); return; }
      records.push(record);
    });
    if (raw.length > MAX_ROWS) skipped.push({ row: MAX_ROWS + 1, reason: `máximo ${MAX_ROWS} filas` });
  }
  return { resolved, format, records, skipped, extra };
}

function describeLoad(kind, loaded) {
  const records = loaded.records;
  const withAmount = records.filter((r) => r.amount !== null).length;
  const withDate = records.filter((r) => r.date !== null).length;
  const withCurrency = records.filter((r) => r.currency !== '').length;
  const sample = records.slice(0, 8).map((r) => r.id).join(', ');
  const lines = [
    `${kind === 'orders' ? 'Pedidos' : 'Pagos'} cargados: ${records.length} desde ${loaded.resolved}`,
    `Formato: ${loaded.format}${loaded.extra.hasHeader === false ? ' (sin encabezado detectado)' : ''}${loaded.extra.delimiter ? ` · delimitador "${loaded.extra.delimiter}"` : ''}`,
    `Con monto: ${withAmount}/${records.length} · con fecha: ${withDate}/${records.length} · con moneda: ${withCurrency}/${records.length}`,
    records.length ? `Primeros ids: ${sample}${records.length > 8 ? ', …' : ''}` : 'No se cargó ningún registro.',
  ];
  if (loaded.skipped.length > 0) lines.push(`Filas omitidas: ${loaded.skipped.length}${loaded.skipped[0] ? ` (ej. fila ${loaded.skipped[0].row}: ${loaded.skipped[0].reason})` : ''}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- conciliación

function validTolerance(value, name, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} debe ser un número entre ${min} y ${max}`);
  return value;
}

function reconcileData(args = {}) {
  if (!state.orders) throw new Error('primero carga los pedidos con load_orders');
  if (!state.payments) throw new Error('primero carga los pagos con load_payments');
  if (state.orders.records.length === 0) throw new Error('el archivo de pedidos no tiene registros válidos');
  if (state.payments.records.length === 0) throw new Error('el archivo de pagos no tiene registros válidos');

  const config = loadConfig();
  const amountTolerance = validTolerance(args.amountTolerance, 'amountTolerance', Number(config.amountTolerance ?? 0.01), 0, 1_000_000);
  const dateToleranceDays = validTolerance(args.dateToleranceDays, 'dateToleranceDays', Number(config.dateToleranceDays ?? 1), 0, 3660);
  const limit = Math.min(Math.max(Number(args.limit ?? 20) || 20, 1), MAX_REPORT_ITEMS);

  const paymentsByOrder = new Map();
  const paymentsWithoutOrderRef = [];
  for (const payment of state.payments.records) {
    const key = payment.orderId ? normKey(payment.orderId).replace(/^#+/, '') : payment.idKey;
    if (!key) { paymentsWithoutOrderRef.push(payment); continue; }
    const list = paymentsByOrder.get(key) || [];
    list.push(payment);
    paymentsByOrder.set(key, list);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    sources: { orders: state.orders.resolved, payments: state.payments.resolved },
    tolerances: { amountTolerance, dateToleranceDays },
    counts: { orders: state.orders.records.length, payments: state.payments.records.length },
    matched: [],
    missingPayment: [],
    duplicateOrders: [],
    duplicatePaymentIds: [],
    amountMismatch: [],
    dateMismatch: [],
    currencyMismatch: [],
    incomplete: [],
    missingOrder: [],
    duplicateOrderIds: [],
  };

  const usedPayments = new Set();
  const seenOrderIds = new Set();
  for (const order of state.orders.records) {
    if (seenOrderIds.has(order.idKey)) { result.duplicateOrderIds.push(order); continue; }
    seenOrderIds.add(order.idKey);
    const payments = paymentsByOrder.get(order.idKey) || [];
    for (const payment of payments) usedPayments.add(payment);
    if (payments.length === 0) { result.missingPayment.push(order); continue; }
    if (payments.length > 1) { result.duplicateOrders.push({ order, payments }); continue; }
    const payment = payments[0];
    if (order.amount === null || payment.amount === null) {
      result.incomplete.push({ order, payment, reason: order.amount === null ? 'pedido sin monto' : 'pago sin monto' });
      continue;
    }
    const difference = Math.round(Math.abs(order.amount - payment.amount) * 100) / 100;
    if (difference > amountTolerance) { result.amountMismatch.push({ order, payment, difference }); continue; }
    if (order.currency && payment.currency && order.currency !== payment.currency) {
      result.currencyMismatch.push({ order, payment }); continue;
    }
    if (order.date && payment.date) {
      const days = dayDiff(order.date, payment.date);
      if (days !== null && Math.abs(days) > dateToleranceDays) { result.dateMismatch.push({ order, payment, days }); continue; }
    }
    result.matched.push({ order, payment, difference });
  }

  for (const order of result.duplicateOrderIds) {
    for (const payment of paymentsByOrder.get(order.idKey) || []) usedPayments.add(payment);
  }
  for (const payment of state.payments.records) {
    if (usedPayments.has(payment)) continue;
    result.missingOrder.push(payment);
  }
  result.missingOrder.push(...paymentsWithoutOrderRef);

  const totalsByCurrency = new Map();
  const addTotal = (currency, kind, amount) => {
    const key = currency || 'SIN_MONEDA';
    const entry = totalsByCurrency.get(key) || { currency: key, orders: 0, payments: 0 };
    entry[kind] = Math.round((entry[kind] + amount) * 100) / 100;
    totalsByCurrency.set(key, entry);
  };
  for (const order of state.orders.records) if (order.amount !== null) addTotal(order.currency, 'orders', order.amount);
  for (const payment of state.payments.records) if (payment.amount !== null) addTotal(payment.currency, 'payments', payment.amount);
  result.totalsByCurrency = [...totalsByCurrency.values()].map((entry) => ({ ...entry, difference: Math.round((entry.orders - entry.payments) * 100) / 100 })).sort((a, b) => a.currency.localeCompare(b.currency));

  result.counts.matched = result.matched.length;
  result.counts.missingPayment = result.missingPayment.length;
  result.counts.duplicateOrders = result.duplicateOrders.length;
  result.counts.amountMismatch = result.amountMismatch.length;
  result.counts.dateMismatch = result.dateMismatch.length;
  result.counts.currencyMismatch = result.currencyMismatch.length;
  result.counts.incomplete = result.incomplete.length;
  result.counts.missingOrder = result.missingOrder.length;
  result.counts.duplicateOrderIds = result.duplicateOrderIds.length;
  result.limit = limit;
  state.lastReconcile = result;
  return result;
}

function amountText(value) {
  return value === null || value === undefined ? 's/monto' : Number(value).toFixed(2);
}

function truncateList(lines, limit, total) {
  const shown = lines.slice(0, limit);
  if (total > limit) shown.push(`… y ${total - limit} más (aumenta el argumento limit; máximo ${MAX_REPORT_ITEMS}).`);
  return shown;
}

function summarizeReconcile(result) {
  const summary = {
    Coinciden: result.counts.matched,
    'Faltan pagos': result.counts.missingPayment,
    'Pagos duplicados': result.counts.duplicateOrders,
    'Diferencias de monto': result.counts.amountMismatch,
    'Diferencias de fecha': result.counts.dateMismatch,
    'Moneda distinta': result.counts.currencyMismatch,
    'Sin monto (no verificables)': result.counts.incomplete,
    'Pagos sin pedido': result.counts.missingOrder,
    'Ids de pedido repetidos': result.counts.duplicateOrderIds,
  };
  const lines = [
    `Conciliación: ${result.counts.orders} pedido(s) vs ${result.counts.payments} pago(s)`,
    `Tolerancias: monto ±${result.tolerances.amountTolerance} · fecha ±${result.tolerances.dateToleranceDays} día(s)`,
    Object.entries(summary).map(([key, value]) => `${key}: ${value}`).join(' · '),
    '',
  ];
  if (result.totalsByCurrency.length > 0) {
    lines.push('Totales por moneda:');
    for (const entry of result.totalsByCurrency) {
      lines.push(`- ${entry.currency}: pedidos ${entry.orders.toFixed(2)} · pagos ${entry.payments.toFixed(2)} · diferencia ${entry.difference.toFixed(2)}`);
    }
    lines.push('');
  }
  if (result.missingPayment.length > 0) {
    lines.push(`Pedidos sin pago (${result.counts.missingPayment}):`);
    lines.push(...truncateList(result.missingPayment.map((order) => `- ${order.id} · ${amountText(order.amount)} ${order.currency || ''} · ${order.date || 's/fecha'}${order.dateRaw ? ` (${order.dateRaw})` : ''}`), result.limit, result.counts.missingPayment));
  }
  if (result.duplicateOrders.length > 0) {
    lines.push(`Pedidos con más de un pago (${result.counts.duplicateOrders}):`);
    lines.push(...truncateList(result.duplicateOrders.map(({ order, payments }) => `- ${order.id} · ${payments.length} pagos: ${payments.map((p) => `${p.paymentId || p.id} (${amountText(p.amount)} ${p.currency || ''})`).join(', ')}`), result.limit, result.counts.duplicateOrders));
  }
  if (result.duplicateOrderIds.length > 0) {
    lines.push(`Ids de pedido repetidos en el archivo de pedidos (${result.counts.duplicateOrderIds}):`);
    lines.push(...truncateList(result.duplicateOrderIds.map((order) => `- ${order.id}`), result.limit, result.counts.duplicateOrderIds));
  }
  if (result.amountMismatch.length > 0) {
    lines.push(`Diferencias de monto (${result.counts.amountMismatch}):`);
    lines.push(...truncateList(result.amountMismatch.map(({ order, payment, difference }) => `- ${order.id}: pedido ${amountText(order.amount)} ${order.currency || ''} vs pago ${amountText(payment.amount)} ${payment.currency || ''} (Δ ${difference.toFixed(2)})`), result.limit, result.counts.amountMismatch));
  }
  if (result.dateMismatch.length > 0) {
    lines.push(`Diferencias de fecha (${result.counts.dateMismatch}):`);
    lines.push(...truncateList(result.dateMismatch.map(({ order, payment, days }) => `- ${order.id}: pedido ${order.date} vs pago ${payment.date} (${days > 0 ? '+' : ''}${days} día(s))`), result.limit, result.counts.dateMismatch));
  }
  if (result.currencyMismatch.length > 0) {
    lines.push(`Moneda distinta (${result.counts.currencyMismatch}):`);
    lines.push(...truncateList(result.currencyMismatch.map(({ order, payment }) => `- ${order.id}: pedido ${order.currency} vs pago ${payment.currency}`), result.limit, result.counts.currencyMismatch));
  }
  if (result.incomplete.length > 0) {
    lines.push(`Registros sin monto verificable (${result.counts.incomplete}):`);
    lines.push(...truncateList(result.incomplete.map(({ order, payment, reason }) => `- ${order.id}: ${reason}`), result.limit, result.counts.incomplete));
  }
  if (result.missingOrder.length > 0) {
    lines.push(`Pagos sin pedido (${result.counts.missingOrder}):`);
    lines.push(...truncateList(result.missingOrder.map((payment) => `- ${payment.paymentId || payment.id} (pago) ref pedido "${payment.orderRef || '—'}" · ${amountText(payment.amount)} ${payment.currency || ''} · ${payment.date || 's/fecha'}`), result.limit, result.counts.missingOrder));
  }
  if (result.counts.matched === 0 && result.counts.orders === 0) lines.push('No hay nada que conciliar.');
  if (result.missingPayment.length === 0 && result.duplicateOrders.length === 0 && result.amountMismatch.length === 0
    && result.dateMismatch.length === 0 && result.currencyMismatch.length === 0 && result.incomplete.length === 0
    && result.missingOrder.length === 0 && result.duplicateOrderIds.length === 0) {
    lines.push('Todo concilia: no se detectaron diferencias.');
  }
  return lines.join('\n');
}

function buildReport(result, format) {
  if (format === 'json') {
    return `${JSON.stringify({ plugin: SLUG, version: VERSION, ...result }, null, 2)}\n`;
  }
  const lines = [
    `# Conciliación de pedidos y pagos`,
    '',
    `- Generado: ${result.generatedAt}`,
    `- Pedidos: ${result.counts.orders} · \`${result.sources.orders}\``,
    `- Pagos: ${result.counts.payments} · \`${result.sources.payments}\``,
    `- Tolerancias: monto ±${result.tolerances.amountTolerance} · fecha ±${result.tolerances.dateToleranceDays} día(s)`,
    '',
    '## Resumen',
    '',
    '| Métrica | Valor |',
    '|---|---|',
    `| Coinciden | ${result.counts.matched} |`,
    `| Faltan pagos | ${result.counts.missingPayment} |`,
    `| Pagos duplicados | ${result.counts.duplicateOrders} |`,
    `| Diferencias de monto | ${result.counts.amountMismatch} |`,
    `| Diferencias de fecha | ${result.counts.dateMismatch} |`,
    `| Moneda distinta | ${result.counts.currencyMismatch} |`,
    `| Sin monto | ${result.counts.incomplete} |`,
    `| Pagos sin pedido | ${result.counts.missingOrder} |`,
    `| Ids de pedido repetidos | ${result.counts.duplicateOrderIds} |`,
    '',
    '## Totales por moneda',
    '',
    '| Moneda | Pedidos | Pagos | Diferencia |',
    '|---|---|---|---|',
    ...(result.totalsByCurrency.length ? result.totalsByCurrency.map((entry) => `| ${entry.currency} | ${entry.orders.toFixed(2)} | ${entry.payments.toFixed(2)} | ${entry.difference.toFixed(2)} |`) : ['| — | — | — | — |']),
    '',
    '## Detalle',
    '',
  ];
  const section = (title, rows) => {
    lines.push(`### ${title}`, '');
    lines.push(...(rows.length ? rows : ['- sin registros']));
    lines.push('');
  };
  section(`Pedidos sin pago (${result.counts.missingPayment})`, result.missingPayment.slice(0, MAX_REPORT_ITEMS).map((order) => `- ${order.id} · ${amountText(order.amount)} ${order.currency || ''} · ${order.date || 's/fecha'}`));
  section(`Pedidos con más de un pago (${result.counts.duplicateOrders})`, result.duplicateOrders.slice(0, MAX_REPORT_ITEMS).map(({ order, payments }) => `- ${order.id} · ${payments.length} pagos: ${payments.map((p) => `${p.paymentId || p.id} (${amountText(p.amount)} ${p.currency || ''})`).join(', ')}`));
  section(`Diferencias de monto (${result.counts.amountMismatch})`, result.amountMismatch.slice(0, MAX_REPORT_ITEMS).map(({ order, payment, difference }) => `- ${order.id}: pedido ${amountText(order.amount)} vs pago ${amountText(payment.amount)} (Δ ${difference.toFixed(2)})`));
  section(`Diferencias de fecha (${result.counts.dateMismatch})`, result.dateMismatch.slice(0, MAX_REPORT_ITEMS).map(({ order, payment, days }) => `- ${order.id}: pedido ${order.date} vs pago ${payment.date} (${days} día(s))`));
  section(`Moneda distinta (${result.counts.currencyMismatch})`, result.currencyMismatch.slice(0, MAX_REPORT_ITEMS).map(({ order, payment }) => `- ${order.id}: ${order.currency} vs ${payment.currency}`));
  section(`Sin monto verificable (${result.counts.incomplete})`, result.incomplete.slice(0, MAX_REPORT_ITEMS).map(({ order, reason }) => `- ${order.id}: ${reason}`));
  section(`Pagos sin pedido (${result.counts.missingOrder})`, result.missingOrder.slice(0, MAX_REPORT_ITEMS).map((payment) => `- ${payment.paymentId || payment.id} · ref "${payment.orderRef || '—'}" · ${amountText(payment.amount)} ${payment.currency || ''}`));
  section(`Ids de pedido repetidos (${result.counts.duplicateOrderIds})`, result.duplicateOrderIds.slice(0, MAX_REPORT_ITEMS).map((order) => `- ${order.id}`));
  section(`Coincidencias (${result.counts.matched})`, result.matched.slice(0, MAX_REPORT_ITEMS).map(({ order, payment }) => `- ${order.id} → ${payment.paymentId || payment.id} · ${amountText(order.amount)} ${order.currency || ''} · ${order.date || 's/fecha'}`));
  lines.push(`_Generado por ${SLUG} ${VERSION} — datos locales, sin red._`);
  return `${lines.join('\n')}\n`;
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function buildInstructions() {
  const config = loadConfig();
  return [
    'Payment Reconciler: cruza pedidos contra pagos desde CSV/JSON locales para WENDIGO.',
    '',
    `Modo: ${READ_ONLY ? 'read-only' : 'normal'} · config: ${CONFIG_FILE}`,
    `allowedPaths: ${config.allowedPaths.length ? config.allowedPaths.join('; ') : 'sin restricción (cualquier ruta local)'}`,
    '',
    'Herramientas: status, load_orders, load_payments, reconcile, report.',
    '',
    'Reglas:',
    '- Todo es local: no hay red ni credenciales; no inventes pedidos ni pagos.',
    '- Carga pedidos y pagos antes de conciliar; el estado vive en memoria del servidor.',
    '- reconcile solo analiza (permitido en read-only); no escribe archivos.',
    '- report es la única escritura: requiere confirm:true, ruta dentro de allowedPaths y nunca sobrescribe.',
    '- Reporta cifras reales: coincidencias, faltantes, duplicados, diferencias y totales por moneda.',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer(
    { name: 'dsh-plugin-payment-reconciler', version: VERSION },
    { capabilities: { tools: {} }, instructions: buildInstructions() },
  );

  server.registerTool(
    'status',
    {
      title: 'Estado de Payment Reconciler',
      description: 'Modo, rutas permitidas, archivos cargados en memoria y última conciliación.',
      inputSchema: z.object({}),
    },
    async () => {
      rateLimit();
      const config = loadConfig();
      let auditCount = 0;
      try { auditCount = readFileSync(AUDIT_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean).length; } catch { /* sin auditoría */ }
      const last = state.lastReconcile;
      const lines = [
        `Payment Reconciler ${VERSION} (MCP: ${SERVER_NAME})`,
        `Modo: ${READ_ONLY ? 'read-only' : 'normal'}`,
        `DSH_HOME: ${DSH_HOME}`,
        `Config: ${CONFIG_FILE}`,
        `allowedPaths: ${config.allowedPaths.length ? config.allowedPaths.join('; ') : 'sin restricción'}`,
        `Tolerancias por defecto: monto ±${config.amountTolerance} · fecha ±${config.dateToleranceDays} día(s)`,
        `Pedidos en memoria: ${state.orders ? `${state.orders.records.length} (${state.orders.resolved})` : 'no cargados'}`,
        `Pagos en memoria: ${state.payments ? `${state.payments.records.length} (${state.payments.resolved})` : 'no cargados'}`,
        `Última conciliación: ${last ? `${last.generatedAt} · ${last.counts.matched} coincidencias / ${last.counts.orders} pedidos` : 'ninguna'}`,
        `Auditoría: ${auditCount} entradas en ${AUDIT_FILE}`,
      ];
      audit({ tool: 'status', ok: true });
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'load_orders',
    {
      title: 'Cargar pedidos',
      description: 'Carga pedidos desde un archivo CSV o JSON local (solo lectura). Reemplaza lo cargado antes.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Ruta absoluta (o relativa al cwd) del archivo CSV/JSON de pedidos.'),
        format: z.enum(['auto', 'csv', 'json']).optional().describe('Forzar el formato; auto detecta por extensión/contenido.'),
      }),
    },
    async (args) => {
      rateLimit();
      try {
        const loaded = loadFile(args.path, args.format);
        state.orders = { ...loaded, loadedAt: new Date().toISOString() };
        if (state.lastReconcile) state.lastReconcile = null;
        audit({ tool: 'load_orders', ok: true, path: loaded.resolved, format: loaded.format, count: loaded.records.length, skipped: loaded.skipped.length });
        return textResult(describeLoad('orders', loaded));
      } catch (error) {
        audit({ tool: 'load_orders', ok: false, path: String(args.path || ''), error: error.message });
        throw error;
      }
    },
  );

  server.registerTool(
    'load_payments',
    {
      title: 'Cargar pagos',
      description: 'Carga pagos desde un archivo CSV o JSON local (solo lectura). Reemplaza lo cargado antes.',
      inputSchema: z.object({
        path: z.string().min(1).describe('Ruta absoluta (o relativa al cwd) del archivo CSV/JSON de pagos.'),
        format: z.enum(['auto', 'csv', 'json']).optional().describe('Forzar el formato; auto detecta por extensión/contenido.'),
      }),
    },
    async (args) => {
      rateLimit();
      try {
        const loaded = loadFile(args.path, args.format);
        state.payments = { ...loaded, loadedAt: new Date().toISOString() };
        if (state.lastReconcile) state.lastReconcile = null;
        audit({ tool: 'load_payments', ok: true, path: loaded.resolved, format: loaded.format, count: loaded.records.length, skipped: loaded.skipped.length });
        return textResult(describeLoad('payments', loaded));
      } catch (error) {
        audit({ tool: 'load_payments', ok: false, path: String(args.path || ''), error: error.message });
        throw error;
      }
    },
  );

  server.registerTool(
    'reconcile',
    {
      title: 'Conciliar pedidos vs pagos',
      description: 'Cruza lo cargado: coincidencias por id/monto/fecha, faltantes, duplicados, diferencias y totales por moneda. Solo analiza.',
      inputSchema: z.object({
        amountTolerance: z.number().min(0).max(1_000_000).optional().describe('Tolerancia de monto (default config.amountTolerance).'),
        dateToleranceDays: z.number().min(0).max(3660).optional().describe('Días de tolerancia entre fecha de pedido y pago.'),
        limit: z.number().int().min(1).max(200).optional().describe('Máximo de filas mostradas por sección (default 20).'),
      }),
    },
    async (args) => {
      rateLimit();
      try {
        const result = reconcileData(args);
        audit({
          tool: 'reconcile', ok: true,
          orders: result.counts.orders, payments: result.counts.payments,
          matched: result.counts.matched, missingPayment: result.counts.missingPayment,
          duplicateOrders: result.counts.duplicateOrders, amountMismatch: result.counts.amountMismatch,
          dateMismatch: result.counts.dateMismatch, currencyMismatch: result.counts.currencyMismatch,
          missingOrder: result.counts.missingOrder, incomplete: result.counts.incomplete,
        });
        return textResult(summarizeReconcile(result));
      } catch (error) {
        audit({ tool: 'reconcile', ok: false, error: error.message });
        throw error;
      }
    },
  );

  server.registerTool(
    'report',
    {
      title: 'Generar reporte',
      description: 'Escribe la conciliación actual en Markdown o JSON. Única escritura del plugin: requiere confirm:true y no sobrescribe.',
      inputSchema: z.object({
        path: z.string().optional().describe('Ruta de salida dentro de allowedPaths. Omitida = <DSH_HOME>/cache/payment-reconciler/.'),
        format: z.enum(['md', 'json']).optional().describe('Formato del reporte (default md).'),
        amountTolerance: z.number().min(0).max(1_000_000).optional(),
        dateToleranceDays: z.number().min(0).max(3660).optional(),
        confirm: z.boolean().optional().describe('true solo si el usuario pidió y confirmó escribir el archivo.'),
      }),
    },
    async (args) => {
      rateLimit('report', 10);
      if (READ_ONLY) { audit({ tool: 'report', ok: false, error: 'modo read-only' }); throw new Error('modo read-only: report deshabilitado'); }
      if (args.confirm !== true) { audit({ tool: 'report', ok: false, error: 'sin confirm' }); throw new Error('report requiere confirm:true y confirmación explícita del usuario'); }
      try {
        const result = reconcileData(args);
        const format = args.format || 'md';
        const stamp = result.generatedAt.replace(/[:.]/g, '-');
        let target;
        if (args.path && String(args.path).trim()) target = resolveWritable(args.path);
        else target = path.join(CACHE_DIR, `report-${stamp}.${format}`);
        if (existsSync(target)) throw new Error(`el archivo ya existe (no se sobrescribe): ${target}`);
        const content = buildReport(result, format);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
        audit({ tool: 'report', ok: true, path: target, format, bytes: Buffer.byteLength(content), matched: result.counts.matched, issues: result.counts.missingPayment + result.counts.amountMismatch + result.counts.duplicateOrders + result.counts.missingOrder });
        const summary = `Reporte escrito: ${target} (${Buffer.byteLength(content)} bytes, ${format}).\n` +
          `Coinciden: ${result.counts.matched} · faltan pagos: ${result.counts.missingPayment} · duplicados: ${result.counts.duplicateOrders} · diferencias de monto: ${result.counts.amountMismatch} · pagos sin pedido: ${result.counts.missingOrder}.`;
        return textResult(summary);
      } catch (error) {
        audit({ tool: 'report', ok: false, error: error.message });
        throw error;
      }
    },
  );

  return server;
}

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    saveConfig(defaultConfig());
  }
} catch (error) {
  log(`init: ${error.message}`);
}
log(`modo ${READ_ONLY ? 'read-only' : 'normal'} · config: ${CONFIG_FILE}`);
serveStdio(buildServer, { onerror: (error) => log(`serveStdio: ${error.message}`) });
process.on('uncaughtException', (error) => log(`excepción: ${error.message}`));
process.on('unhandledRejection', (error) => log(`rechazo: ${error && error.message ? error.message : String(error)}`));
