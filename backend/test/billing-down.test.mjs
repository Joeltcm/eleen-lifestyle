// Reversas de migración (X-018): se niegan a destruir facturas o planes reales salvo orden expresa.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);
let servidor; let api; let db;
const down = nombre => new URL(`../migrations-down/${nombre}`, import.meta.url).pathname;
const psql = (archivo, { permitir = false } = {}) => ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, ...(permitir ? ['-c', "SET billing.allow_destructive_down = 'on'"] : []), '-f', archivo]);

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  const c = (await api.post('/api/clients', { fullName: 'Ana', cutoffDay: 1 })).datos.id;
  assert.equal((await api.post(`/api/clients/${c}/billing-subscriptions`, { beneficiaryClientId: c, payerClientId: c, kind: 'monthly', price: 100, startsOn: '2026-09-01' })).estado, 201);
  assert.equal((await api.post('/api/billing/invoices', { payerClientId: c, kind: 'mensual', cycleStart: '2026-09-01', cycleEnd: '2026-10-01', issuedOn: '2026-09-01', lines: [{ beneficiaryClientId: c, unitAmount: 100 }] })).estado, 201);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('la reversa de 051 se NIEGA a borrar facturas emitidas sin orden expresa, y no deja nada a medias', async () => {
  await assert.rejects(psql(down('051_billing_core.down.sql')), /billing_invoices tiene facturas emitidas/);
  assert.equal((await db`SELECT count(*)::int AS n FROM billing_invoices`)[0].n, 1, 'la factura sigue ahí');
  assert.equal((await db`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '051_billing_core.sql'`)[0].n, 1);
});

test('la reversa de 050 existe y se niega a borrar planes declarados sin orden expresa', async () => {
  await assert.rejects(psql(down('050_billing_subscriptions.down.sql')), /billing_subscriptions tiene planes/);
  assert.equal((await db`SELECT count(*)::int AS n FROM billing_subscriptions`)[0].n, 1);
});

test('con la orden expresa sí corren (y quitan el registro de la migración)', async () => {
  await psql(down('051_billing_core.down.sql'), { permitir: true });
  assert.equal((await db`SELECT to_regclass('billing_invoices') AS t`)[0].t, null);
  await psql(down('050_billing_subscriptions.down.sql'), { permitir: true });
  assert.equal((await db`SELECT to_regclass('billing_subscriptions') AS t`)[0].t, null);
  assert.equal((await db`SELECT count(*)::int AS n FROM schema_migrations WHERE name IN ('050_billing_subscriptions.sql', '051_billing_core.sql')`)[0].n, 0);
});
