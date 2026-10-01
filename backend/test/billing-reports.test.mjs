// Etapa 1B-5: estado de cuenta, reportes, morosidad, bitácora y portal con la fuente nueva.
// Fechas literales (vencidas = 2020, futuras = 2099): nada depende del reloj ni del mes en curso.
import test, { after, before, describe } from 'node:test';
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
  const [{ id: ownerId }] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  const id = {};
  for (const nombre of ['Riccardo', 'Iraida', 'Ernesto', 'Sola']) {
    const r = await api.post('/api/clients', { fullName: nombre, cutoffDay: 15, email: `${nombre.toLowerCase()}@prueba.test` });
    id[nombre] = r.datos.id;
  }
  const factura = async (payer, kind, cycleStart, cycleEnd, dueOn, lines) => {
    const r = await api.post('/api/billing/invoices', { payerClientId: payer, kind, cycleStart, cycleEnd, issuedOn: cycleStart, dueOn,
      lines: lines.map(([beneficiaryClientId, unitAmount, description]) => ({ beneficiaryClientId, unitAmount, description })) });
    assert.equal(r.estado, 201, JSON.stringify(r.datos));
    return r.datos;
  };
  const cobro = async (payer, amount, method, paidOn, applications = []) => {
    const r = await api.post('/api/billing/payments', { payerClientId: payer, amount, method, paidOn, applications });
    assert.equal(r.estado, 201, JSON.stringify(r.datos));
    return r.datos;
  };
  const portalDe = async clientId => {
    const enlace = await api.post(`/api/clients/${clientId}/access-link`, {});
    const acceso = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
    assert.equal(acceso.estado, 200);
    const portal = cliente(servidor.base); portal.usarToken(acceso.datos.token); return portal;
  };
  // Datos comunes: familia de Riccardo vencida en 2020 con $400 pagados; Ernesto con su factura propia que vence en 2099
  const familia = await factura(id.Riccardo, 'mensual', '2020-01-15', '2020-02-15', '2020-01-15', [[id.Riccardo, 450, 'Riccardo'], [id.Iraida, 300, 'Iraida'], [id.Ernesto, 150, 'Ernesto']]);
  const propia = await factura(id.Ernesto, 'mensual', '2099-01-15', '2099-02-15', '2099-01-15', [[id.Ernesto, 120, '4 sesiones propias']]);
  const pagoFamilia = await cobro(id.Riccardo, 400, 'Yappy', '2026-09-16', [{ invoiceId: familia.id, amount: 400 }]);
  await cobro(id.Ernesto, 120, 'Efectivo', '2026-10-17', [{ invoiceId: propia.id, amount: 120 }]);
  const anulado = await cobro(id.Sola, 77, 'Tarjeta', '2026-10-20');
  await api.post(`/api/billing/payments/${anulado.id}/void`, { reason: 'Registrado por error' });
  for (const [beneficiary, payer, price] of [['Riccardo', 'Riccardo', 450], ['Iraida', 'Riccardo', 300], ['Ernesto', 'Riccardo', 150], ['Ernesto', 'Ernesto', 120]]) {
    const r = await api.post(`/api/clients/${id[beneficiary]}/billing-subscriptions`, { beneficiaryClientId: id[beneficiary], payerClientId: id[payer], kind: 'monthly', price, startsOn: '2026-09-01' });
    assert.equal(r.estado, 201);
  }
  return { api, db, ownerId, id, factura, cobro, portalDe, familia, propia, pagoFamilia };
}

let A; let B; let servidorA; let servidorB;
before(async () => {
  servidorA = await levantar();
  servidorB = await levantarCon({ LEGACY_BILLING_GENERATION: 'off', NEW_BILLING_GENERATION: 'on' });
  A = await preparar(servidorA); B = await preparar(servidorB);
}, { timeout: 180_000 });
after(async () => {
  await A?.db.end({ timeout: 1 }).catch(() => {}); await B?.db.end({ timeout: 1 }).catch(() => {});
  await servidorA?.parar(); await servidorB?.parar();
});

describe('reportes del módulo nuevo (generador viejo activo: no cambian lo que ve el cliente)', () => {
  test('estado de cuenta del pagador: facturas, cobros, saldo y totales', async () => {
    const r = await A.api.get(`/api/billing/accounts/${A.id.Riccardo}/statement?from=2019-01-01&to=2099-12-31`);
    assert.equal(r.estado, 200);
    assert.equal(r.datos.rows.length, 1);
    assert.deepEqual([r.datos.rows[0].invoice_number, r.datos.rows[0].amount, r.datos.rows[0].paid_amount, r.datos.rows[0].balance_amount], ['FAC-0001', 900, 400, 500]);
    assert.deepEqual([r.datos.totals.invoiced, r.datos.totals.paid, r.datos.totals.balance, r.datos.totals.received], [900, 400, 500, 400]);
    assert.equal(r.datos.payments.length, 1);
    assert.equal(r.datos.payments[0].method, 'Yappy');
    assert.equal((await A.api.get(`/api/billing/accounts/${A.id.Riccardo}/statement?from=2021-01-01&to=2021-12-31`)).datos.rows.length, 0, 'el rango filtra');
  });

  test('estado de cuenta en PDF y CSV', async () => {
    const pdf = await A.api.get(`/api/billing/accounts/${A.id.Riccardo}/statement?from=2019-01-01&to=2099-12-31&format=pdf`);
    assert.equal(pdf.estado, 200);
    assert.match(pdf.cabeceras.get('content-type'), /application\/pdf/);
    assert.ok(String(pdf.datos).startsWith('%PDF'));
    const csv = await A.api.get(`/api/billing/accounts/${A.id.Riccardo}/statement?from=2019-01-01&to=2099-12-31&format=csv`);
    assert.match(csv.cabeceras.get('content-type'), /text\/csv/);
    assert.ok(String(csv.datos).includes('FAC-0001') && String(csv.datos).includes('Yappy'));
  });

  test('cuentas por cobrar con antigüedad: vencida 31+ y al día, con totales por tramo y CSV', async () => {
    const r = await A.api.get('/api/billing/reports/receivables?asOf=2026-10-01');
    assert.equal(r.estado, 200);
    const fam = r.datos.rows.find(x => x.code === 'FAC-0001');
    assert.deepEqual([fam.balance, fam.bucket, fam.payer], [500, '31+', 'Riccardo']);
    assert.ok(fam.daysOverdue > 2000);
    assert.ok(!r.datos.rows.some(x => x.code === 'FAC-0002'), 'la de Ernesto ya está pagada');
    assert.deepEqual(r.datos.buckets.map(b => b.bucket), ['al_dia', '1-7', '8-30', '31+']);
    assert.equal(r.datos.buckets.find(b => b.bucket === '31+').balance, 500);
    assert.equal(r.datos.total, 500);
    const csv = await A.api.get('/api/billing/reports/receivables?asOf=2026-10-01&format=csv');
    assert.ok(String(csv.datos).includes('FAC-0001') && String(csv.datos).includes('31+'));
  });

  test('cobrado por mes y método: lo anulado no cuenta', async () => {
    const r = await A.api.get('/api/billing/reports/collections?year=2026');
    assert.equal(r.estado, 200);
    assert.deepEqual(r.datos.months.map(m => [m.month, m.total, m.count]), [['2026-09', 400, 1], ['2026-10', 120, 1]]);
    assert.deepEqual(r.datos.months[1].methods, { Efectivo: 120 });
    assert.equal(r.datos.total, 520, 'los $77 anulados no suman');
    const csv = await A.api.get('/api/billing/reports/collections?year=2026&format=csv');
    assert.ok(String(csv.datos).includes('2026-09') && !String(csv.datos).includes('Tarjeta'));
  });

  test('morosidad: el pagador con facturas vencidas y los beneficiarios que ese atraso toca', async () => {
    const r = await A.api.get('/api/billing/reports/delinquency');
    assert.equal(r.estado, 200);
    assert.equal(r.datos.payers.length, 1);
    const m = r.datos.payers[0];
    assert.deepEqual([m.payer, m.balance, m.invoices[0].code], ['Riccardo', 500, 'FAC-0001']);
    assert.deepEqual(m.beneficiaries, ['Ernesto', 'Iraida'], 'sin el pagador, solo quienes cubre');
    assert.equal(r.datos.total, 500);
  });

  test('bitácora: quién hizo qué, con el usuario o "automático"', async () => {
    const r = await A.api.get('/api/billing/audit?limit=50');
    assert.equal(r.estado, 200);
    const acciones = new Set(r.datos.entries.map(e => e.action));
    for (const accion of ['CREATE_INVOICE', 'CREATE_PAYMENT', 'APPLY_PAYMENT', 'VOID_PAYMENT']) assert.ok(acciones.has(accion), accion);
    assert.ok(r.datos.entries.some(e => e.user === CREDENCIALES.email));
  });

  test('exige sesión y no mezcla dueños', async () => {
    assert.equal((await cliente(servidorA.base).get('/api/billing/reports/delinquency')).estado, 401);
    assert.equal((await cliente(servidorA.base).get(`/api/billing/accounts/${A.id.Riccardo}/statement`)).estado, 401);
    assert.equal((await A.api.get('/api/billing/accounts/00000000-0000-0000-0000-000000000000/statement')).estado, 404);
  });

  test('con el generador viejo activo el portal sigue leyendo el sistema anterior (sin aviso nuevo)', async () => {
    await A.api.post('/api/invoices', { clientId: A.id.Sola, concept: 'Mensualidad vieja', amount: 55, dueOn: '2026-09-15' });
    const portal = await A.portalDe(A.id.Sola);
    const r = await portal.get('/api/portal/summary');
    assert.equal(r.estado, 200);
    assert.equal(r.datos.billingNotice, null);
    assert.ok(r.datos.invoices.some(i => i.concept === 'Mensualidad vieja'));
    assert.ok(!r.datos.invoices.some(i => String(i.invoice_number ?? '').startsWith('FAC-')));
  });
});

describe('tras el corte (estado new): portal, facturas y finanzas leen la fuente nueva', () => {
  test('el estado operativo es `new`', async () => {
    const r = await B.api.get('/api/billing/engine-status');
    assert.deepEqual([r.datos.state, r.datos.legacyWrites, r.datos.newWrites], ['new', false, true]);
  });

  test('el PAGADOR ve sus facturas nuevas con la forma de siempre: número FAC, saldo, líneas y sin saldos de clases', async () => {
    const portal = await B.portalDe(B.id.Riccardo);
    const r = await portal.get('/api/portal/summary');
    assert.equal(r.estado, 200);
    assert.equal(r.datos.invoices.length, 1);
    const f = r.datos.invoices[0];
    assert.deepEqual([f.invoice_number, f.amount, f.balance, f.status, f.payment_method], ['FAC-0001', 900, 500, 'pending', 'Yappy']);
    assert.equal(f.line_items.length, 3);
    assert.deepEqual(r.datos.packages, []);
    assert.equal(r.datos.billingNotice, null, 'quien solo paga no recibe el aviso de beneficiario');
    const pdf = await portal.get('/api/portal/reports/account-statement.pdf?from=2019-01-01&to=2099-12-31');
    assert.equal(pdf.estado, 200);
    assert.match(pdf.cabeceras.get('content-type'), /application\/pdf/);
  });

  test('el BENEFICIARIO ve solo un aviso: "pago pendiente" si la factura que lo cubre está vencida; sin montos ni nombre del pagador', async () => {
    const portal = await B.portalDe(B.id.Iraida);
    const r = await portal.get('/api/portal/summary');
    assert.equal(r.estado, 200);
    assert.deepEqual(r.datos.billingNotice, { kind: 'pago_pendiente', message: 'La cuenta de quien paga tu plan tiene un pago pendiente.' });
    assert.deepEqual(r.datos.invoices, [], 'no ve facturas de otro');
    const texto = JSON.stringify(r.datos.billingNotice);
    assert.ok(!/Riccardo|\$|\d{3}/.test(texto), 'ni nombre, ni montos');
  });

  test('al pagarse el saldo del pagador, el aviso del beneficiario pasa a "cubierta"', async () => {
    const abierta = (await B.api.get(`/api/billing/invoices?payerId=${B.id.Riccardo}&status=abierta`)).datos.invoices[0];
    await B.cobro(B.id.Riccardo, 500, 'Transferencia bancaria', '2026-10-18', [{ invoiceId: abierta.id, amount: 500 }]);
    const portal = await B.portalDe(B.id.Iraida);
    assert.deepEqual((await portal.get('/api/portal/summary')).datos.billingNotice, { kind: 'cubierta', message: 'Tu mensualidad está cubierta.' });
  });

  test('Ernesto: su factura propia vencida NO activa el aviso de beneficiario (la que lo cubre es la de Riccardo)', async () => {
    await B.db`UPDATE billing_invoices SET status = 'pendiente' WHERE id = ${B.propia.id}`;   // simula su factura propia sin pagar
    await B.db`UPDATE billing_invoices SET due_on = due_on WHERE id = ${B.propia.id}`;
    const portal = await B.portalDe(B.id.Ernesto);
    assert.equal((await portal.get('/api/portal/summary')).datos.billingNotice.kind, 'cubierta');
  });

  test('quien no está cubierto por nadie no recibe aviso', async () => {
    const portal = await B.portalDe(B.id.Sola);
    assert.equal((await portal.get('/api/portal/summary')).datos.billingNotice, null);
  });

  test('el listado de facturas del staff mezcla la historia anterior a septiembre con las nuevas y deja fuera lo viejo de septiembre', async () => {
    await B.db`INSERT INTO invoices (client_id, concept, amount, due_on, status, issued_on, source_system) VALUES
      (${B.id.Sola}, 'Agosto (archivo)', 100, '2026-08-15', 'confirmed', '2026-08-15', 'zoho_invoice'),
      (${B.id.Sola}, 'Septiembre viejo', 100, '2026-09-15', 'confirmed', '2026-09-15', NULL)`;
    const r = await B.api.get('/api/invoices');
    assert.equal(r.estado, 200);
    const conceptos = r.datos.map(i => i.concept);
    assert.ok(conceptos.includes('Agosto (archivo)'), 'la historia anterior se conserva');
    assert.ok(!conceptos.includes('Septiembre viejo'), 'lo viejo de septiembre en adelante no se duplica');
    const nueva = r.datos.find(i => i.invoice_number === 'FAC-0001');
    assert.deepEqual([nueva.source_system, nueva.amount, nueva.client_id, nueva.full_name], ['billing_new', 900, B.id.Riccardo, 'Riccardo']);
  });

  test('finanzas: septiembre en adelante cuenta los cobros nuevos y no los viejos; antes de septiembre, los viejos', async () => {
    await B.db`INSERT INTO invoice_payments (client_id, amount, paid_on, method, source_system, external_id) VALUES
      (${B.id.Sola}, 1000, '2026-08-20', 'Yappy', 'eileen', 'viejo-ago'), (${B.id.Sola}, 5000, '2026-09-20', 'Yappy', 'eileen', 'viejo-sep')`;
    const ago = (await B.api.get('/api/finance/monthly?month=2026-08')).datos;
    assert.equal(ago.resumen.ingresos, 1000);
    const sep = (await B.api.get('/api/finance/monthly?month=2026-09')).datos;
    assert.equal(sep.resumen.ingresos, 400, 'solo el cobro nuevo del 16-09; el viejo de $5.000 no duplica');
    assert.deepEqual(sep.cobros.map(c => c.metodo), ['Yappy']);
    assert.match(sep.cobros[0].concepto, /FAC-0001/);
  });

  test('la ficha del cliente muestra su deuda pendiente desde la fuente nueva (parte proporcional del saldo de la familia)', async () => {
    // FAC-0001: $900 con $400 pagados -> falta 500/900 de cada línea; el saldo se pagó después en una prueba anterior, así que se reabre
    const [abierta] = await B.db`SELECT id FROM billing_invoices WHERE number = 1`;
    await B.db`UPDATE billing_payment_applications SET reversed_at = now(), reversal_reason = 'prueba' WHERE invoice_id = ${abierta.id} AND amount = 500`;
    await B.db`UPDATE billing_invoices SET status = 'parcial' WHERE id = ${abierta.id}`;
    const r = await B.api.get('/api/clients');
    const deuda = nombre => Number(r.datos.find(c => c.full_name === nombre).deuda_pendiente);
    assert.equal(Math.round(deuda('Riccardo') * 100) / 100, 250);
    assert.equal(Math.round(deuda('Iraida') * 100) / 100, 166.67);
    assert.equal(Math.round(deuda('Ernesto') * 100) / 100, 83.33, 'su factura propia está pagada: solo cuenta su parte de la familia');
    assert.equal(deuda('Sola'), 0);
  });

  test('las notificaciones avisan de los pagos atrasados NUEVOS y no de los pendientes viejos congelados', async () => {
    await B.db`INSERT INTO invoices (client_id, concept, amount, due_on, status, source_system) VALUES (${B.id.Sola}, 'Pendiente viejo congelado', 40, '2020-01-01', 'pending', NULL)`;
    const staff = await B.api.get('/api/notifications');
    assert.equal(staff.estado, 200);
    const pagos = staff.datos.filter(n => n.type === 'overdue' || n.type === 'payment');
    assert.ok(pagos.some(n => /Riccardo/.test(n.title) && /FAC-0001/.test(n.body)), 'avisa de FAC-0001');
    assert.ok(!pagos.some(n => /congelado/.test(n.body)), 'no avisa de la factura vieja');
    const portal = await B.portalDe(B.id.Riccardo);
    const cliente = await portal.get('/api/notifications');
    assert.ok(cliente.datos.some(n => n.type === 'payment' && /FAC-0001/.test(n.body)));
  });
});
