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

test('Corregir monto: cambia el importe de la línea vieja en su sitio y, si el tramo siguiente ya tiene ese mismo importe, los une (queda una sola línea)', async () => {
  const antes = (await api.get(`/api/clients/${id.Riccardo}/billing-subscriptions`)).datos;
  const vieja = antes.lines.find(l => l.beneficiaryName === 'Riccardo' && l.price === 450);
  assert.ok(vieja.endsOn, 'la línea de 450 termina un día antes del tramo nuevo');
  assert.equal((await api.post(`/api/billing-subscriptions/${vieja.id}/correct-price`, { price: 460, reason: 'x' })).estado, 400, 'motivo mínimo de 3 letras');
  assert.equal((await api.post(`/api/billing-subscriptions/${vieja.id}/correct-price`, { price: 450, reason: 'mismo monto' })).estado, 409);
  const r = await api.post(`/api/billing-subscriptions/${vieja.id}/correct-price`, { price: 460, reason: 'El reparto correcto era 460' });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.merged, true);
  assert.deepEqual([r.datos.line.price, r.datos.line.startsOn, r.datos.line.endsOn], [460, vieja.startsOn, null]);
  const despues = (await api.get(`/api/clients/${id.Riccardo}/billing-subscriptions`)).datos;
  assert.equal(despues.lines.filter(l => l.beneficiaryName === 'Riccardo').length, 1, 'una sola línea de Riccardo');
  assert.equal(despues.summary.totalForPayer, 870 + 10, 'hoy: 460 + 300 + 120');
  const [bitacora] = await db`SELECT detail FROM audit_log WHERE action = 'CORRECT_BILLING_SUBSCRIPTION_PRICE'`;
  assert.equal(bitacora.detail.previous.price, 450); assert.equal(bitacora.detail.next.price, 460); assert.equal(bitacora.detail.next.reason, 'El reparto correcto era 460');
  assert.ok(bitacora.detail.next.mergedWith, 'la bitácora guarda el tramo que se unió');
});

test('con las dos corregidas, hoy y "desde 15-10" dan lo mismo ($900) y ya no hay "próximo"', async () => {
  const antes = (await api.get(`/api/clients/${id.Riccardo}/billing-subscriptions`)).datos;
  const iraida = antes.lines.find(l => l.beneficiaryName === 'Iraida' && l.price === 300);
  assert.equal((await api.post(`/api/billing-subscriptions/${iraida.id}/correct-price`, { price: 320, reason: 'Reparto correcto' })).estado, 200);
  const r = (await api.get(`/api/clients/${id.Riccardo}/billing-subscriptions`)).datos;
  assert.equal(r.lines.length, 3);
  assert.equal(r.summary.totalForPayer, 900);
  assert.equal(r.summary.upcoming, null);
  assert.deepEqual(r.summary.breakdown.map(b => [b.beneficiaryName, b.amount]).sort(), [['Ernesto', 120], ['Iraida', 320], ['Riccardo', 460]]);
});

test('si el tramo siguiente tiene OTRO importe no se une; y una línea inexistente da 404', async () => {
  const nueva = await api.post(`/api/clients/${id.Ernesto}/billing-subscriptions`, { beneficiaryClientId: id.Ernesto, payerClientId: id.Ernesto, kind: 'monthly', price: 100, startsOn: '2026-01-01' });
  const cambio = await api.patch(`/api/billing-subscriptions/${nueva.datos.id}`, { price: 130, startsOn: '2099-01-01', endsOn: null });
  assert.equal(cambio.estado, 200, JSON.stringify(cambio.datos));
  const r = await api.post(`/api/billing-subscriptions/${nueva.datos.id}/correct-price`, { price: 110, reason: 'Corrección sin unir' });
  assert.equal(r.estado, 200); assert.equal(r.datos.merged, false);
  assert.equal(r.datos.line.endsOn, '2098-12-31');
  assert.equal((await api.post('/api/billing-subscriptions/00000000-0000-4000-8000-000000000000/correct-price', { price: 5, reason: 'abc' })).estado, 404);
  assert.equal((await cliente(servidor.base).post(`/api/billing-subscriptions/${nueva.datos.id}/correct-price`, { price: 5, reason: 'abc' })).estado, 401);
});
