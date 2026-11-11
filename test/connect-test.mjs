// Test end-to-end de payment-reconciler: 100% local, sin red ni credenciales.
// Carga CSV/JSON temporales, concilia y verifica reporte con confirm:true y modo read-only.
import path from 'node:path';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
const dataDir = path.join(tmpDir, 'data');
const dshHome = path.join(tmpDir, 'dsh-home');
mkdirSync(dataDir, { recursive: true });
mkdirSync(path.join(dshHome, 'payment-reconciler'), { recursive: true });

writeFileSync(path.join(dshHome, 'payment-reconciler', 'config.json'), JSON.stringify({
  allowedPaths: [dataDir],
  amountTolerance: 0.01,
  dateToleranceDays: 1,
}, null, 2), 'utf8');

const ordersCsv = [
  'order_id,amount,date,currency',
  'O-1001,150.00,2026-01-10,MXN',
  'O-1002,89.90,2026-01-11,MXN',
  'O-1003,200.00,2026-01-12,MXN',
  'O-1004,300.00,2026-01-13,MXN',
  'O-1005,50.00,2026-01-14,MXN',
  'O-1006,120.00,2026-01-15,USD',
  'O-1007,75.00,2026-01-16,MXN',
  'O-1008,45.00,2026-01-17,MXN',
].join('\n') + '\n';
const paymentsJson = {
  payments: [
    { order_id: 'O-1001', payment_id: 'P-1', amount: 150.0, date: '2026-01-10', currency: 'MXN' },
    { order_id: 'O-1002', payment_id: 'P-2', amount: '89.90', date: '2026-01-12', currency: 'MXN' },
    { order_id: 'O-1003', payment_id: 'P-3', amount: 199.0, date: '2026-01-12', currency: 'MXN' },
    { order_id: 'O-1005', payment_id: 'P-4', amount: 50.0, date: '2026-01-14', currency: 'MXN' },
    { order_id: 'O-1005', payment_id: 'P-5', amount: 50.0, date: '2026-01-14', currency: 'MXN' },
    { order_id: 'O-1006', payment_id: 'P-6', amount: 120.0, date: '2026-01-15', currency: 'MXN' },
    { order_id: 'O-1007', payment_id: 'P-7', amount: 75.0, date: '2026-01-26', currency: 'MXN' },
    { order_id: 'O-1008', payment_id: 'P-8', date: '2026-01-17', currency: 'MXN' },
    { order_id: 'O-9999', payment_id: 'P-9', amount: 10.0, date: '2026-01-18', currency: 'MXN' },
  ],
};
const ordersFile = path.join(dataDir, 'orders.csv');
const paymentsFile = path.join(dataDir, 'payments.json');
const secretFile = path.join(tmpDir, 'fuera-de-allowlist.csv');
writeFileSync(ordersFile, ordersCsv, 'utf8');
writeFileSync(paymentsFile, JSON.stringify(paymentsJson, null, 2), 'utf8');
writeFileSync(secretFile, 'order_id,amount\nO-1,10\n', 'utf8');

function makeClient(extraEnv = {}) {
  const serverEntry = process.env.PAYMENTS_SERVER ? path.resolve(process.env.PAYMENTS_SERVER) : path.join(packageDir, 'server.mjs');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      PATH: process.env.PATH,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME || process.env.USERPROFILE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      DSH_HOME: dshHome,
      ...extraEnv,
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  const client = new Client({ name: 'payments-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  return client.connect(transport).then(() => ({ client, transport }));
}
const textOf = (result) => (result.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');

const { client, transport } = await makeClient();

const tools = await client.listTools();
const toolNames = tools.tools.map((tool) => tool.name);
console.log('tools:', toolNames.join(', '));
assert.deepEqual(toolNames.sort(), ['load_orders', 'load_payments', 'reconcile', 'report', 'status']);

const status = textOf(await client.callTool({ name: 'status', arguments: {} }));
console.log('--- status ---'); console.log(status);
assert.match(status, /Modo: normal/);
assert.match(status, /allowedPaths: .*data/);

const loadedOrders = textOf(await client.callTool({ name: 'load_orders', arguments: { path: ordersFile } }));
console.log('--- load_orders ---'); console.log(loadedOrders);
assert.match(loadedOrders, /Pedidos cargados: 8/);
assert.match(loadedOrders, /Formato: csv/);

const loadedPayments = textOf(await client.callTool({ name: 'load_payments', arguments: { path: paymentsFile } }));
console.log('--- load_payments ---'); console.log(loadedPayments);
assert.match(loadedPayments, /Pagos cargados: 9/);
assert.match(loadedPayments, /Formato: json/);

const reconciled = textOf(await client.callTool({ name: 'reconcile', arguments: {} }));
console.log('--- reconcile ---'); console.log(reconciled);
assert.match(reconciled, /Coinciden: 2/);
assert.match(reconciled, /Faltan pagos: 1/);
assert.match(reconciled, /Pagos duplicados: 1/);
assert.match(reconciled, /Diferencias de monto: 1/);
assert.match(reconciled, /Diferencias de fecha: 1/);
assert.match(reconciled, /Moneda distinta: 1/);
assert.match(reconciled, /Sin monto \(no verificables\): 1/);
assert.match(reconciled, /Pagos sin pedido: 1/);
assert.match(reconciled, /Ids de pedido repetidos: 0/);
assert.match(reconciled, /Pedidos sin pago[\s\S]*O-1004/);
assert.match(reconciled, /Pagos sin pedido[\s\S]*P-9/);
assert.match(reconciled, /MXN/);

const strictDates = textOf(await client.callTool({ name: 'reconcile', arguments: { dateToleranceDays: 0 } }));
console.log('--- reconcile tolerancia fecha 0 ---'); console.log(strictDates.split('\n').slice(0, 3).join('\n'));
assert.match(strictDates, /Diferencias de fecha: 2/);
assert.match(strictDates, /Coinciden: 1/);

const blockedLoad = await client.callTool({ name: 'load_orders', arguments: { path: secretFile } });
console.log('load fuera de allowedPaths isError:', blockedLoad.isError === true, '|', textOf(blockedLoad).slice(0, 120));
assert.equal(blockedLoad.isError, true);
assert.match(textOf(blockedLoad), /allowedPaths/);

const noConfirm = await client.callTool({ name: 'report', arguments: { path: path.join(dataDir, 'reporte.md') } });
console.log('report sin confirm isError:', noConfirm.isError === true, '|', textOf(noConfirm).slice(0, 100));
assert.equal(noConfirm.isError, true);

const outsideReport = await client.callTool({ name: 'report', arguments: { path: path.join(tmpDir, 'reporte.md'), confirm: true } });
console.log('report fuera de allowedPaths isError:', outsideReport.isError === true);
assert.equal(outsideReport.isError, true);
assert.match(textOf(outsideReport), /allowedPaths/);

const mdReportPath = path.join(dataDir, 'reporte.md');
const mdReport = await client.callTool({ name: 'report', arguments: { path: mdReportPath, format: 'md', confirm: true } });
console.log('--- report md ---'); console.log(textOf(mdReport));
assert.notEqual(mdReport.isError, true);
assert.equal(existsSync(mdReportPath), true);
const mdContent = readFileSync(mdReportPath, 'utf8');
assert.match(mdContent, /# Conciliación de pedidos y pagos/);
assert.match(mdContent, /O-1004/);
assert.match(mdContent, /\| Coinciden \| 2 \|/);
console.log('reporte md contiene', mdContent.split('\n').length, 'líneas');

const jsonReportPath = path.join(dataDir, 'reporte.json');
const jsonReport = await client.callTool({ name: 'report', arguments: { path: jsonReportPath, format: 'json', confirm: true } });
console.log('--- report json ---'); console.log(textOf(jsonReport));
assert.notEqual(jsonReport.isError, true);
const parsed = JSON.parse(readFileSync(jsonReportPath, 'utf8'));
assert.equal(parsed.counts.matched, 2);
assert.equal(parsed.counts.missingPayment, 1);
assert.equal(parsed.counts.duplicateOrders, 1);
assert.equal(parsed.counts.missingOrder, 1);
console.log('reporte json counts:', JSON.stringify(parsed.counts));

const overwrite = await client.callTool({ name: 'report', arguments: { path: mdReportPath, confirm: true } });
console.log('report sobre archivo existente isError:', overwrite.isError === true);
assert.equal(overwrite.isError, true);
assert.match(textOf(overwrite), /ya existe/);

await client.close(); try { await transport.close?.(); } catch { /* ya cerrado */ }

const { client: roClient, transport: roTransport } = await makeClient({ DSH_PAYMENTS_MODE: 'read-only' });
const roReconcileBefore = await roClient.callTool({ name: 'reconcile', arguments: {} });
console.log('read-only reconcile sin datos isError:', roReconcileBefore.isError === true);
assert.equal(roReconcileBefore.isError, true);
assert.match(textOf(roReconcileBefore), /load_orders/);
const roLoad = await roClient.callTool({ name: 'load_orders', arguments: { path: ordersFile } });
assert.notEqual(roLoad.isError, true);
const roLoadPayments = await roClient.callTool({ name: 'load_payments', arguments: { path: paymentsFile } });
assert.notEqual(roLoadPayments.isError, true);
const roReconcile = await roClient.callTool({ name: 'reconcile', arguments: {} });
console.log('read-only reconcile permitido:', roReconcile.isError !== true);
assert.notEqual(roReconcile.isError, true);
const roReport = await roClient.callTool({ name: 'report', arguments: { path: path.join(dataDir, 'ro.md'), confirm: true } });
console.log('read-only report isError:', roReport.isError === true, '|', textOf(roReport).slice(0, 100));
assert.equal(roReport.isError, true);
assert.match(textOf(roReport), /read-only/);
await roClient.close(); try { await roTransport.close?.(); } catch { /* ya cerrado */ }

console.log('OK');
