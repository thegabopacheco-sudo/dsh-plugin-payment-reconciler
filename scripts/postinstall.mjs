// dsh-plugin-payment-reconciler — despliega el runtime en <DSH_HOME>/plugins/payment-reconciler.
import { existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (m) => process.stdout.write(`[dsh-plugin-payment-reconciler] ${m}\n`);

function findDshHome() {
  const fromEnv = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  if (fromEnv) return fromEnv;
  let current = packageDir;
  for (let depth = 0; depth < 14; depth++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    if (path.basename(current).toLowerCase() === 'profiles') return path.dirname(current);
    current = parent;
  }
  const initCwd = process.env.INIT_CWD;
  if (initCwd && existsSync(path.join(initCwd, 'cordis.patch.yml'))) return path.dirname(initCwd);
  const fallback = path.join(homedir(), '.dsh');
  return existsSync(path.join(fallback, 'profiles')) ? fallback : null;
}

if (process.env.DSH_PAYMENT_RECONCILER_SKIP_POSTINSTALL === '1') {
  log('postinstall omitido');
  process.exit(0);
}
const dshHome = findDshHome();
if (!dshHome) { log('no se encontró DSH_HOME; no se desplegó nada.'); process.exit(0); }
const target = path.join(dshHome, 'plugins', 'payment-reconciler');
try {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const [from, to] of [
    [path.join(packageDir, 'dist', 'server.mjs'), path.join(target, 'server.mjs')],
    [path.join(packageDir, 'package.json'), path.join(target, 'package.json')],
  ]) {
    if (!existsSync(from)) { log('aviso: falta ' + path.relative(packageDir, from)); continue; }
    copyFileSync(from, to); copied++;
  }
  log(`desplegados ${copied}/2 archivos en ${target}`);
  log('listo. Reinicia DSH si las tools mcp__payments__* no aparecen.');
} catch (error) {
  log('falló el despliegue: ' + error.message);
}
