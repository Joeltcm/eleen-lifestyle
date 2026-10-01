// Tras el corte (J-067): el sistema anterior es SOLO de consulta (Archivo) y sus rutas de escritura están retiradas (410) fuera del estado legacy.
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
  const id = {};
  for (const nombre of ['Ana', 'Beto']) id[nombre] = (await api.post('/api/clients', { fullName: nombre, cutoffDay: 1 })).datos.id;
  return { api, db, id };
}

let N; let L;
before(async () => {
  const sN = await levantarCon({ LEGACY_BILLING_GENERATION: 'off', NEW_BILLING_GENERATION: 'on' });
  const sL = await levantar();
  N = { servidor: sN, ...(await preparar(sN)) }; L = { servidor: sL, ...(await preparar(sL)) };
  const { db, id } = N;
  // Historial: Zoho (agosto, pagada con cobro ligado), sistema viejo (julio, confirmada a mano), pendiente de Zoho (agosto) y una de septiembre (NO es archivo).
  const [z1] = await db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, balance, due_on, issued_on, status, source_system, external_id, invoice_number)
    VALUES (${id.Ana}, ${id.Ana}, 'Mensualidad agosto', 300, 0, '2026-08-05', '2026-08-01', 'confirmed', 'zoho_invoice', 'z-1', 'INV-000100') RETURNING id`;
  const [p1] = await db`INSERT INTO invoice_payments (client_id, amount, paid_on, method, source_system, external_id) VALUES (${id.Ana}, 300, '2026-08-03', 'Yappy', 'zoho_invoice', 'zp-1') RETURNING id`;
  await db`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${p1.id}, ${z1.id}, 300)`;
  await db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status, source_system, payment_method, confirmed_at)
    VALUES (${id.Beto}, ${id.Beto}, 'Mensualidad julio', 200, '2026-07-10', 'confirmed', 'eileen', 'Efectivo', '2026-07-09T12:00:00Z')`;
  await db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, balance, due_on, issued_on, status, source_system, external_id, invoice_number)
    VALUES (${id.Beto}, ${id.Beto}, 'Mensualidad agosto', 200, 200, '2026-08-20', '2026-08-15', 'pending', 'zoho_invoice', 'z-2', 'INV-000101')`;
  await db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status, source_system) VALUES (${id.Ana}, ${id.Ana}, 'Mensualidad septiembre', 300, '2026-09-05', 'pending', 'eileen')`;
}, { timeout: 120_000 });

after(async () => { for (const x of [N, L]) { await x?.db?.end({ timeout: 1 }).catch(() => {}); await x?.servidor?.parar(); } });

test('el archivo lista solo lo anterior a septiembre, con sus cobros, y los totales', async () => {
  const r = (await N.api.get('/api/billing/archive')).datos;
  assert.equal(r.cleanStart, '2026-09-01');
  assert.deepEqual(r.invoices.map(i => i.concept), ['Mensualidad agosto', 'Mensualidad agosto', 'Mensualidad julio']);
  const ana = r.invoices.find(i => i.client === 'Ana');
  assert.deepEqual([ana.number, ana.source, ana.status, ana.amount, ana.paid, ana.balance], ['INV-000100', 'zoho', 'pagada', 300, 300, 0]);
  assert.deepEqual(ana.payments, [{ paidOn: '2026-08-03', method: 'Yappy', amount: 300 }]);
  const julio = r.invoices.find(i => i.concept === 'Mensualidad julio');
  assert.deepEqual([julio.source, julio.status, julio.payments[0].method, julio.payments[0].paidOn], ['sistema', 'pagada', 'Efectivo', '2026-07-09']);
  assert.deepEqual(r.summary, { count: 3, total: 700, paid: 500, balance: 200 });
  assert.deepEqual(r.meta.months, ['2026-08', '2026-07']);
});

test('filtra por mes, origen, estado y cliente', async () => {
  const q = async s => (await N.api.get(`/api/billing/archive?${s}`)).datos;
  assert.equal((await q('month=2026-07')).invoices.length, 1);
  assert.equal((await q('source=zoho')).invoices.length, 2);
  assert.equal((await q('source=sistema')).invoices.length, 1);
  assert.deepEqual((await q('status=pendiente')).invoices.map(i => i.client), ['Beto']);
  assert.deepEqual((await q(`clientId=${N.id.Ana}`)).invoices.map(i => i.client), ['Ana']);
  assert.equal((await N.api.get('/api/billing/archive?month=2026-13')).estado, 400);
  assert.equal((await cliente(N.servidor.base).get('/api/billing/archive')).estado, 401);
});

test('estado new: las rutas que ESCRIBÍAN en el sistema anterior responden 410 y no cambian nada; las lecturas siguen', async () => {
  const antes = (await N.db`SELECT count(*)::int AS n FROM invoices`)[0].n;
  const intento = async (metodo, ruta, cuerpo) => (metodo === 'post' ? await N.api.post(ruta, cuerpo ?? {}) : metodo === 'patch' ? await N.api.patch(ruta, cuerpo ?? {}) : await N.api.delete(ruta));
  const [any] = await N.db`SELECT id FROM invoices LIMIT 1`;
  for (const [metodo, ruta] of [['post', '/api/invoices'], ['post', `/api/invoices/${any.id}/confirm`], ['patch', `/api/invoices/${any.id}`], ['patch', `/api/invoices/${any.id}/payment`],
    ['delete', `/api/invoices/${any.id}`], ['post', `/api/invoices/${any.id}/coverage`], ['post', '/api/maintenance/reconcile-monthly-billing']]) {
    const r = await intento(metodo, ruta, { clientId: N.id.Ana, concept: 'X', amount: 1, dueOn: '2026-10-01' });
    assert.equal(r.estado, 410, `${metodo} ${ruta}`);
    assert.match(r.datos.error, /Retirado/);
  }
  assert.equal((await N.db`SELECT count(*)::int AS n FROM invoices`)[0].n, antes);
  assert.equal((await N.api.get('/api/invoices')).estado, 200);
  assert.equal((await N.api.get('/api/billing/engine-status')).datos.state, 'new');
});

test('estado legacy (el de siempre): las rutas del sistema anterior NO se retiran (reversible con LEGACY=on / NEW=off)', async () => {
  const r = await L.api.post('/api/invoices', { clientId: L.id.Ana, concept: 'Prueba', amount: 10, dueOn: '2026-10-01' });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
});
