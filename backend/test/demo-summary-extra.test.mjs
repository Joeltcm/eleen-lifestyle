// "Demos nuevas este mes" no debe contar los ajustes de una demo vieja ni desfasarse por la zona horaria.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db;
const dia = n => new Date(Date.now() - 5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
before(async () => {
  servidor = await levantar(); api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const s = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN }); api.usarToken(s.datos.token);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('una demo creada el mes pasado y ajustada hoy NO cuenta como nueva este mes; y el límite del mes es el de Panamá', async () => {
  const vieja = (await api.post('/api/clients', { fullName: 'Demo del mes pasado', email: 'dmp@prueba.test', cutoffDay: 1, demo: true, demoEndsOn: dia(30) })).datos.id;
  const otra = (await api.post('/api/clients', { fullName: 'Demo de este mes', email: 'dem@prueba.test', cutoffDay: 1, demo: true, demoEndsOn: dia(30) })).datos.id;
  // Su alta fue el último día del mes anterior a las 22:00 de Panamá (ya es 1.º del mes siguiente en UTC).
  const hoy = dia(0); const primero = `${hoy.slice(0, 8)}01`;
  await db`UPDATE client_mode_events SET at = (${primero}::date - 1 + time '22:00') AT TIME ZONE 'America/Panama' WHERE client_id = ${vieja}`;
  assert.equal((await api.patch(`/api/clients/${vieja}/demo`, { demoEndsOn: dia(40) })).estado, 200, 'se ajusta hoy (evento demo -> demo)');
  const r = await api.get('/api/demo/summary');
  assert.deepEqual([r.datos.funnel.started, r.datos.funnel.newThisMonth], [2, 1], JSON.stringify(r.datos.funnel));
  assert.ok(otra);
});
