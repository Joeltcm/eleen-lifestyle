// Resumen del Plan de facturación: el total de HOY solo cuenta lo vigente; lo que empieza después se muestra aparte como "próximo".
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; const id = {};

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 4 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  for (const n of ['Riccardo', 'Iraida', 'Ernesto']) id[n] = (await api.post('/api/clients', { fullName: n, cutoffDay: 15 })).datos.id;
  // Fechas relativas a hoy para que la prueba no dependa del calendario: la línea "vieja" empezó hace 30 días; el monto nuevo rige dentro de 14.
  const hoy = (await db`SELECT (now() AT TIME ZONE 'America/Panama')::date::text AS d`)[0].d;
  const mas = dias => (await_dias(hoy, dias));
  function await_dias(base, dias) { const d = new Date(`${base}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); }
  const mk = async (b, price, start) => (await api.post(`/api/clients/${id[b]}/billing-subscriptions`, { beneficiaryClientId: id[b], payerClientId: id.Riccardo, kind: 'monthly', price, startsOn: start })).datos;
  const r = await mk('Riccardo', 450, mas(-30)); const i = await mk('Iraida', 300, mas(-30)); await mk('Ernesto', 120, mas(-30));
  for (const [sub, price] of [[r, 460], [i, 320]]) {
    const x = await api.patch(`/api/billing-subscriptions/${sub.id}`, { price, startsOn: mas(14), endsOn: null });
    assert.equal(x.estado, 200, JSON.stringify(x.datos));
  }
  id.proximo = mas(14);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('el total de hoy es la suma de lo vigente (870), no la de las líneas viejas y las nuevas juntas (1.650); lo nuevo sale como "próximo" (900)', async () => {
  const r = (await api.get(`/api/clients/${id.Riccardo}/billing-subscriptions`)).datos;
  assert.equal(r.lines.length, 5, 'las cinco líneas existen (historial incluido)');
  assert.equal(r.summary.totalForPayer, 870);
  assert.deepEqual(r.summary.breakdown.map(b => [b.beneficiaryName, b.amount]).sort(), [['Ernesto', 120], ['Iraida', 300], ['Riccardo', 450]]);
  assert.deepEqual([r.summary.upcoming.startsOn, r.summary.upcoming.totalForPayer], [id.proximo, 900]);
  assert.deepEqual(r.summary.upcoming.breakdown.map(b => [b.beneficiaryName, b.amount]).sort(), [['Ernesto', 120], ['Iraida', 320], ['Riccardo', 460]]);
});

test('quien no es pagador no muestra un total de $0: dice quién le factura', async () => {
  const r = (await api.get(`/api/clients/${id.Iraida}/billing-subscriptions`)).datos;
  assert.equal(r.summary.totalForPayer, 0);
  assert.deepEqual(r.summary.breakdown, []);
  assert.deepEqual(r.summary.paidBy, ['Riccardo']);
  assert.equal(r.summary.upcoming, null, 'Iraida no es pagadora: su cambio de monto se ve en el resumen de su pagador');
});
