// Auditoría X-018: fuera del estado legacy, ningún flujo INTERNO debe escribir facturas o cobros del sistema anterior.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

async function levantarCon(entorno) {
  const previo = {};
  for (const [k, v] of Object.entries(entorno)) { previo[k] = process.env[k]; process.env[k] = v; }
  try { return await levantar(); } finally { for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
async function preparar(servidor) {
  const api = cliente(servidor.base);
  const db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 4 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  return { api, db, hoy: (await db`SELECT (now() AT TIME ZONE 'America/Panama')::date::text AS d`)[0].d };
}

let N; let L;
before(async () => {
  const sN = await levantarCon({ LEGACY_BILLING_GENERATION: 'off', NEW_BILLING_GENERATION: 'on' });
  const sL = await levantar();
  N = { servidor: sN, ...(await preparar(sN)) }; L = { servidor: sL, ...(await preparar(sL)) };
}, { timeout: 120_000 });
after(async () => { for (const x of [N, L]) { await x?.db?.end({ timeout: 1 }).catch(() => {}); await x?.servidor?.parar(); } });

// Cancela una clase a crédito y la edita como "cobrable"; devuelve el importe de la factura VIEJA de crédito.
async function cancelarCredito(S, nombre) {
  const { api, db, hoy } = S;
  const c = await api.post('/api/clients', { fullName: nombre, billingModel: 'monthly', standardPrice: 275, monthlySessionTarget: 12, creditSessionPrice: 25, cutoffDay: 31, paymentMode: 'no_anticipado' });
  assert.equal(c.estado, 201, JSON.stringify(c.datos));
  const [factura] = await db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status) VALUES (${c.datos.id}, ${c.datos.id}, 'Mensualidad', 0, ${hoy}, 'pending') RETURNING id`;
  const lote = await api.post('/api/sessions/batch', { clientId: c.datos.id, startsAt: [new Date(Date.now() - 20 * 60_000).toISOString()], durationMinutes: 30, mode: 'Presencial' });
  const cancelada = await api.delete(`/api/sessions/${lote.datos.sesiones[0].id}?rescheduled=false`);
  assert.equal(cancelada.estado, 200);
  const editada = await api.patch(`/api/sessions/${lote.datos.sesiones[0].id}/cancellation`, { cancelledBy: 'client', rescheduled: false, resolution: 'none', creditCharge: true });
  assert.equal(editada.estado, 200, JSON.stringify(editada.datos));
  return Number((await db`SELECT amount FROM invoices WHERE id = ${factura.id}`)[0].amount);
}

test('cancelar o editar una clase a crédito: en legacy recalcula la factura vieja ($25) y en estado new NO la toca ($0)', async () => {
  assert.equal(await cancelarCredito(L, 'Julio en legacy'), 25, 'contraste: el sistema anterior sigue reescribiendo mientras esté activo');
  assert.equal(await cancelarCredito(N, 'Julio en new'), 0, 'X-018: la factura heredada queda intacta');
});

test('alta de cliente con plan de paquete y asignación de plan: en new NO crean factura heredada (en legacy sí)', async () => {
  const caso = async S => {
    const plan = await S.api.post('/api/plans', { name: `Paquete ${Math.random()}`, billingModel: 'package', price: 280, sessionsIncluded: 8 });
    assert.equal(plan.estado, 201, JSON.stringify(plan.datos));
    const alta = await S.api.post('/api/clients', { fullName: `Con paquete ${Math.random()}`, planId: plan.datos.id, cutoffDay: 15 });
    assert.equal(alta.estado, 201, JSON.stringify(alta.datos));
    const suelto = await S.api.post('/api/clients', { fullName: `Sin plan ${Math.random()}`, cutoffDay: 15 });
    const asignado = await S.api.patch(`/api/clients/${suelto.datos.id}/plan`, { planId: plan.datos.id, cutoffDay: 15 });
    assert.equal(asignado.estado, 200, JSON.stringify(asignado.datos));
    return (await S.db`SELECT count(*)::int AS n FROM invoices WHERE client_id IN (${alta.datos.id}, ${suelto.datos.id})`)[0].n;
  };
  assert.equal(await caso(L), 2, 'contraste: en legacy cada paquete trae su factura vieja');
  assert.equal(await caso(N), 0, 'en new no se crea ninguna');
});

test('POST /api/packages y /api/packages/:id/renew responden 410 en estado new; reprogramar y consultar siguen', async () => {
  const c = (await N.api.post('/api/clients', { fullName: 'Paquetes', cutoffDay: 15 })).datos.id;
  const antes = await N.db`SELECT (SELECT count(*)::int FROM invoices) AS facturas, (SELECT count(*)::int FROM session_packages) AS paquetes, (SELECT count(*)::int FROM invoice_payments) AS cobros`;
  const a = await N.api.post('/api/packages', { clientId: c, kind: 'package', label: 'x', totalSessions: 4, amount: 100 });
  assert.equal(a.estado, 410); assert.match(a.datos.error, /Retirado/);
  assert.equal((await N.api.post('/api/packages/00000000-0000-4000-8000-000000000000/renew', {})).estado, 410);
  assert.equal((await N.api.get('/api/packages')).estado, 200);
  assert.deepEqual(await N.db`SELECT (SELECT count(*)::int FROM invoices) AS facturas, (SELECT count(*)::int FROM session_packages) AS paquetes, (SELECT count(*)::int FROM invoice_payments) AS cobros`, antes, 'ninguna escritura heredada');
});
