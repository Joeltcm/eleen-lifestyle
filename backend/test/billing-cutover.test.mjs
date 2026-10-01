// Etapa 1B-6: planes de facturación propuestos para el corte (se revisan y se crean en bloque).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; const id = {};

const nuevo = async (nombre, corte, campos = {}) => {
  const r = await api.post('/api/clients', { fullName: nombre, cutoffDay: corte });
  assert.equal(r.estado, 201);
  id[nombre] = r.datos.id;
  const { billing_model = 'monthly', standard_price = 0, responsible = null, payment_mode = 'anticipado', credit = null, status = 'active', target = null } = campos;
  await db`UPDATE clients SET billing_model = ${billing_model}, standard_price = ${standard_price}, billing_responsible_client_id = ${responsible}, payment_mode = ${payment_mode},
    credit_session_price = ${credit}, status = ${status}, monthly_session_target = ${target} WHERE id = ${r.datos.id}`;
};

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 4 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  await nuevo('Riccardo', 15, { standard_price: 450, target: 12 });
  await nuevo('Iraida', 15, { standard_price: 300, responsible: id.Riccardo, target: 8 });
  await nuevo('Ernesto', 15, { standard_price: 150, responsible: id.Riccardo, target: 4 });
  await nuevo('Julio', 31, { payment_mode: 'no_anticipado', credit: 25, standard_price: 0 });
  await nuevo('Sara', 1, { billing_model: 'package', standard_price: 420 });
  await nuevo('Gratis', 1, { standard_price: 0 });                       // sin cobro: no se propone
  await nuevo('Inactivo', 1, { standard_price: 100, status: 'inactive' });  // inactivo: no se propone
  await nuevo('Suelta', 1, { billing_model: 'single', standard_price: 35 }); // clase suelta: no se propone
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('propone un plan por cada cliente activo con cobro, con su pagador y su precio; ignora gratis, inactivos y clases sueltas', async () => {
  const r = await api.get('/api/billing/cutover/proposed-lines');
  assert.equal(r.estado, 200);
  const por = nombre => r.datos.lines.find(l => l.beneficiaryName === nombre);
  assert.deepEqual(r.datos.lines.map(l => l.beneficiaryName).sort(), ['Ernesto', 'Iraida', 'Julio', 'Riccardo', 'Sara']);
  assert.deepEqual([por('Ernesto').payerName, por('Ernesto').price, por('Ernesto').kind, por('Ernesto').sessionsReference], ['Riccardo', 150, 'monthly', 4]);
  assert.deepEqual([por('Iraida').payerName, por('Iraida').price], ['Riccardo', 300]);
  assert.deepEqual([por('Riccardo').payerName, por('Riccardo').price, por('Riccardo').sessionsReference], ['Riccardo', 450, 12]);
  assert.deepEqual([por('Julio').kind, por('Julio').price, por('Julio').cycleDays], ['credit', 25, null]);
  assert.deepEqual([por('Sara').kind, por('Sara').cycleDays, por('Sara').price], ['package', 35, 420]);
  assert.ok(r.datos.lines.every(l => /^\d{4}-\d{2}-\d{2}$/.test(l.startsOn)));
});

test('proponer no escribe; crear exige confirmación explícita, crea los planes y es idempotente', async () => {
  assert.equal((await db`SELECT count(*)::int AS n FROM billing_subscriptions`)[0].n, 0);
  assert.equal((await api.post('/api/billing/cutover/proposed-lines/apply', {})).estado, 400);
  assert.equal((await api.post('/api/billing/cutover/proposed-lines/apply', { confirm: false })).estado, 400);
  const r = await api.post('/api/billing/cutover/proposed-lines/apply', { confirm: true });
  assert.equal(r.estado, 201);
  assert.equal(r.datos.count, 5);
  const filas = await db`SELECT b.full_name AS beneficiario, p.full_name AS pagador, s.kind, s.price::float AS precio, s.auto_generate, s.cycle_days
    FROM billing_subscriptions s JOIN clients b ON b.id = s.beneficiary_client_id JOIN clients p ON p.id = s.payer_client_id ORDER BY b.full_name`;
  assert.deepEqual(filas.map(f => [f.beneficiario, f.pagador, f.kind, f.precio]), [
    ['Ernesto', 'Riccardo', 'monthly', 150], ['Iraida', 'Riccardo', 'monthly', 300], ['Julio', 'Julio', 'credit', 25], ['Riccardo', 'Riccardo', 'monthly', 450], ['Sara', 'Sara', 'package', 420]]);
  assert.ok(filas.every(f => f.auto_generate === true));
  assert.equal(filas.find(f => f.beneficiario === 'Sara').cycle_days, 35);
  assert.equal((await api.get('/api/billing/cutover/proposed-lines')).datos.lines.length, 0, 'ya no quedan propuestas');
  assert.equal((await api.post('/api/billing/cutover/proposed-lines/apply', { confirm: true })).datos.count, 0, 'una segunda vez no crea nada');
  const [{ n }] = await db`SELECT count(*)::int AS n FROM audit_log WHERE action = 'CREATE_BILLING_SUBSCRIPTION'`;
  assert.equal(n, 5, 'cada plan creado queda en la bitácora');
});

test('exige sesión', async () => {
  assert.equal((await cliente(servidor.base).get('/api/billing/cutover/proposed-lines')).estado, 401);
  assert.equal((await cliente(servidor.base).post('/api/billing/cutover/proposed-lines/apply', { confirm: true })).estado, 401);
});

test('quien ya tiene un plan PROPIO (Ernesto) sigue necesitando la línea de su plan familiar: se compara por pareja beneficiario+pagador', async () => {
  // Estado inicial de la prueba anterior: ya no quedan propuestas. Se borra la línea familiar de Ernesto y se declara solo su plan propio.
  await db`DELETE FROM billing_subscriptions WHERE beneficiary_client_id = ${id.Ernesto}`;
  const propio = await api.post(`/api/clients/${id.Ernesto}/billing-subscriptions`, { beneficiaryClientId: id.Ernesto, payerClientId: id.Ernesto, kind: 'monthly', price: 120, sessionsReference: 4, startsOn: '2026-09-15' });
  assert.equal(propio.estado, 201);
  const r = await api.get('/api/billing/cutover/proposed-lines');
  assert.deepEqual(r.datos.lines.map(l => [l.beneficiaryName, l.payerName, l.price]), [['Ernesto', 'Riccardo', 150]], 'sigue proponiendo su parte familiar con Riccardo de pagador');
  const lista = await api.get('/api/billing/cutover/readiness');
  const planes = lista.datos.checks.find(c => c.key === 'plans');
  assert.equal(planes.status, 'fail');
  assert.ok(planes.items.some(i => i.name === 'Ernesto'), 'la lista de comprobación también lo marca');
  const crear = await api.post('/api/billing/cutover/proposed-lines/apply', { confirm: true });
  assert.equal(crear.datos.count, 1);
  const lineas = await db`SELECT p.full_name AS pagador, s.price::float AS precio FROM billing_subscriptions s JOIN clients p ON p.id = s.payer_client_id WHERE s.beneficiary_client_id = ${id.Ernesto} ORDER BY s.price`;
  assert.deepEqual(lineas.map(l => [l.pagador, l.precio]), [['Ernesto', 120], ['Riccardo', 150]], 'queda con sus DOS planes: propio y familiar');
  assert.equal((await api.get('/api/billing/cutover/proposed-lines')).datos.lines.length, 0);
});
