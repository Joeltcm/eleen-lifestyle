// Etapa 1B-2: facturas del módulo nuevo (crear, listar, ver, anular, PDF).
//
// Todas las fechas son literales: no dependen del reloj ni del mes en curso.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor;
let api;
let db;
let ownerId;
let riccardo;
let iraida;
let ernesto;
let ajeno;

const nuevoCliente = async (nombre, cutoffDay = 15) => {
  const r = await api.post('/api/clients', { fullName: nombre, cutoffDay });
  assert.equal(r.estado, 201, `crear ${nombre}`);
  return r.datos.id;
};
const factura = (extra = {}) => api.post('/api/billing/invoices', {
  payerClientId: riccardo, kind: 'mensual', cycleStart: '2026-09-15', issuedOn: '2026-09-15',
  lines: [{ beneficiaryClientId: riccardo, description: 'Mensualidad', unitAmount: 450 }], ...extra
});

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 4 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  [{ id: ownerId }] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  riccardo = await nuevoCliente('Riccardo');
  iraida = await nuevoCliente('Iraida');
  ernesto = await nuevoCliente('Ernesto');
  const [{ id: otro }] = await db`INSERT INTO users (email, password_hash, full_name, role) VALUES ('otra@prueba.test', 'x', 'Otra', 'trainer') RETURNING id`;
  [{ id: ajeno }] = await db`INSERT INTO clients (owner_id, full_name) VALUES (${otro}, 'Cliente ajeno') RETURNING id`;
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

describe('crear facturas', () => {
  test('crea la primera factura con número FAC-0001 y calcula el total en el servidor', async () => {
    const r = await factura();
    assert.equal(r.estado, 201);
    assert.equal(r.datos.code, 'FAC-0001');
    assert.equal(r.datos.total, 450);
    const detalle = await api.get(`/api/billing/invoices/${r.datos.id}`);
    assert.equal(detalle.estado, 200);
    assert.equal(detalle.datos.status, 'pendiente');
    assert.equal(detalle.datos.origin, 'manual');
    assert.equal(detalle.datos.balance, 450);
    assert.equal(detalle.datos.lines.length, 1);
    assert.equal(detalle.datos.audit[0].action, 'CREATE_INVOICE');
  });

  test('el fin del ciclo por defecto es el siguiente corte y el vencimiento es el día de emisión', async () => {
    const r = await factura({ cycleStart: '2026-10-15', issuedOn: '2026-10-15' });
    const d = (await api.get(`/api/billing/invoices/${r.datos.id}`)).datos;
    assert.equal(d.cycleStart, '2026-10-15');
    assert.equal(d.cycleEnd, '2026-11-15');
    assert.equal(d.dueOn, '2026-10-15');
    assert.equal(d.cutDay, 15);
  });

  test('un corte de fin de mes se ajusta al último día', async () => {
    const treinta = await nuevoCliente('Corte treinta y uno', 31);
    const r = await factura({ payerClientId: treinta, cycleStart: '2026-08-31', issuedOn: '2026-08-31',
      lines: [{ beneficiaryClientId: treinta, unitAmount: 100 }] });
    assert.equal((await api.get(`/api/billing/invoices/${r.datos.id}`)).datos.cycleEnd, '2026-09-30');
  });

  test('una familia: una cabecera, una línea por persona, total = suma ($900)', async () => {
    const r = await factura({
      cycleStart: '2026-11-15', issuedOn: '2026-11-15',
      lines: [
        { beneficiaryClientId: riccardo, description: 'Riccardo', unitAmount: 450, sessionsReference: 12 },
        { beneficiaryClientId: iraida, description: 'Iraida', unitAmount: 300, sessionsReference: 8 },
        { beneficiaryClientId: ernesto, description: 'Ernesto (4 clases, plan familiar)', unitAmount: 150, sessionsReference: 4 }
      ]
    });
    assert.equal(r.estado, 201);
    assert.equal(r.datos.total, 900);
    const d = (await api.get(`/api/billing/invoices/${r.datos.id}`)).datos;
    assert.deepEqual(d.lines.map(l => l.amount).sort((a, b) => a - b), [150, 300, 450]);
  });

  test('cantidad por importe unitario, sin errores de decimales', async () => {
    const r = await factura({ cycleStart: '2026-12-15', issuedOn: '2026-12-15',
      lines: [{ beneficiaryClientId: ernesto, description: '3 clases', quantity: 3, unitAmount: 33.33 }] });
    assert.equal(r.datos.total, 99.99);
  });

  test('rechaza un segundo ciclo igual del mismo pagador y tipo con un mensaje claro', async () => {
    const r = await factura();
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /Ya existe una factura de este tipo/);
    assert.match(r.datos.error, /15-09-2026/);
  });

  test('las clases sueltas no se limitan por ciclo', async () => {
    const a = await factura({ kind: 'clase_suelta', cycleStart: '2026-09-20', issuedOn: '2026-09-20', lines: [{ beneficiaryClientId: ernesto, description: 'Sesión', unitAmount: 35 }] });
    const b = await factura({ kind: 'clase_suelta', cycleStart: '2026-09-20', issuedOn: '2026-09-20', lines: [{ beneficiaryClientId: ernesto, description: 'Sesión', unitAmount: 35 }] });
    assert.equal(a.estado, 201);
    assert.equal(b.estado, 201);
    const d = (await api.get(`/api/billing/invoices/${a.datos.id}`)).datos;
    assert.equal(d.cycleStart, d.cycleEnd);
  });

  test('un paquete de 35 días cierra el ciclo 35 días después', async () => {
    const sara = await nuevoCliente('Sara', 1);
    const r = await factura({ payerClientId: sara, kind: 'paquete', cycleDays: 35, cycleStart: '2026-09-15', issuedOn: '2026-09-17',
      lines: [{ beneficiaryClientId: sara, description: 'Paquete 12 sesiones', unitAmount: 420, sessionsReference: 12 }] });
    assert.equal(r.estado, 201);
    assert.equal((await api.get(`/api/billing/invoices/${r.datos.id}`)).datos.cycleEnd, '2026-10-20');
    const sinDias = await factura({ payerClientId: sara, kind: 'paquete', cycleStart: '2027-01-01', lines: [{ beneficiaryClientId: sara, unitAmount: 420 }] });
    assert.equal(sinDias.estado, 400);
  });

  test('una persona no puede repetirse en la misma factura', async () => {
    const r = await factura({ cycleStart: '2027-02-15', issuedOn: '2027-02-15',
      lines: [{ beneficiaryClientId: riccardo, unitAmount: 100 }, { beneficiaryClientId: riccardo, unitAmount: 50 }] });
    assert.equal(r.estado, 400);
    assert.match(r.datos.error, /solo puede aparecer una vez/);
  });

  test('importes negativos solo en ajustes; el total no puede ser negativo', async () => {
    const malo = await factura({ cycleStart: '2027-03-15', issuedOn: '2027-03-15', lines: [{ beneficiaryClientId: riccardo, unitAmount: -10 }] });
    assert.equal(malo.estado, 400);
    const ajuste = await factura({ cycleStart: '2027-03-15', issuedOn: '2027-03-15', lines: [
      { beneficiaryClientId: riccardo, unitAmount: 100 },
      { beneficiaryClientId: iraida, lineType: 'ajuste', description: 'Crédito', unitAmount: -20 }] });
    assert.equal(ajuste.estado, 201);
    assert.equal(ajuste.datos.total, 80);
    const negativo = await factura({ cycleStart: '2027-04-15', issuedOn: '2027-04-15', lines: [
      { beneficiaryClientId: riccardo, lineType: 'ajuste', unitAmount: -5 }] });
    assert.equal(negativo.estado, 400);
  });

  test('un cliente de otro dueño se trata como inexistente', async () => {
    const r = await factura({ payerClientId: ajeno, cycleStart: '2027-05-15', lines: [{ beneficiaryClientId: ajeno, unitAmount: 10 }] });
    assert.equal(r.estado, 404);
    const r2 = await factura({ cycleStart: '2027-05-15', lines: [{ beneficiaryClientId: ajeno, unitAmount: 10 }] });
    assert.equal(r2.estado, 404);
  });

  test('exige autenticación y una factura sin líneas se rechaza', async () => {
    const anonimo = cliente(servidor.base);
    assert.equal((await anonimo.get('/api/billing/invoices')).estado, 401);
    const vacia = await factura({ cycleStart: '2027-06-15', lines: [] });
    assert.equal(vacia.estado, 400);
  });

  test('veinte altas simultáneas dan números distintos y consecutivos', async () => {
    const antes = (await api.get('/api/billing/invoices')).datos.invoices.reduce((m, i) => Math.max(m, i.number), 0);
    const resultados = await Promise.all(Array.from({ length: 20 }, (_, i) => factura({
      cycleStart: `2028-${String((i % 12) + 1).padStart(2, '0')}-${i < 12 ? '15' : '16'}`, kind: i < 12 ? 'mensual' : 'manual',
      issuedOn: '2028-01-01', lines: [{ beneficiaryClientId: iraida, unitAmount: 10 }]
    })));
    assert.ok(resultados.every(r => r.estado === 201));
    const numeros = resultados.map(r => r.datos.number).sort((a, b) => a - b);
    assert.deepEqual(numeros, Array.from({ length: 20 }, (_, i) => antes + 1 + i));
  });

  test('crear una factura nueva no toca el sistema anterior ni el precio de nadie', async () => {
    const antes = (await db`SELECT (SELECT count(*) FROM invoices)::int AS facturas, (SELECT count(*) FROM session_packages)::int AS saldos,
      (SELECT count(*) FROM memberships)::int AS membresias, (SELECT coalesce(sum(standard_price),0) FROM clients)::numeric AS precios`)[0];
    const r = await factura({ cycleStart: '2029-01-15', issuedOn: '2029-01-15', lines: [{ beneficiaryClientId: riccardo, description: 'Mensualidad', unitAmount: 999 }] });
    assert.equal(r.estado, 201);
    const despues = (await db`SELECT (SELECT count(*) FROM invoices)::int AS facturas, (SELECT count(*) FROM session_packages)::int AS saldos,
      (SELECT count(*) FROM memberships)::int AS membresias, (SELECT coalesce(sum(standard_price),0) FROM clients)::numeric AS precios`)[0];
    assert.deepEqual(despues, antes);
  });
});

describe('listar, anular y PDF', () => {
  test('filtra por estado, pagador, tipo y fechas; marca las vencidas', async () => {
    const vieja = await factura({ cycleStart: '2020-01-15', issuedOn: '2020-01-15', dueOn: '2020-01-15', lines: [{ beneficiaryClientId: ernesto, unitAmount: 120 }], payerClientId: ernesto });
    assert.equal(vieja.estado, 201);
    const lista = (await api.get('/api/billing/invoices?status=vencida')).datos;
    assert.ok(lista.invoices.some(i => i.id === vieja.datos.id && i.overdue === true));
    assert.ok(lista.invoices.every(i => i.overdue));
    const porPagador = (await api.get(`/api/billing/invoices?payerId=${ernesto}&kind=mensual`)).datos;
    assert.ok(porPagador.invoices.length >= 1 && porPagador.invoices.every(i => i.payerClientId === ernesto && i.kind === 'mensual'));
    const rango = (await api.get('/api/billing/invoices?from=2020-01-01&to=2020-12-31')).datos;
    assert.deepEqual(rango.invoices.map(i => i.id), [vieja.datos.id]);
    assert.equal(rango.summary.count, 1);
    assert.equal(rango.summary.balance, 120);
  });

  test('anular exige motivo, deja bitácora, libera el ciclo y no se repite', async () => {
    const f = await factura({ cycleStart: '2030-01-15', issuedOn: '2030-01-15' });
    const sinMotivo = await api.post(`/api/billing/invoices/${f.datos.id}/void`, { reason: ' ' });
    assert.equal(sinMotivo.estado, 400);
    const ok = await api.post(`/api/billing/invoices/${f.datos.id}/void`, { reason: 'Capturada con el monto equivocado' });
    assert.equal(ok.estado, 200);
    const d = (await api.get(`/api/billing/invoices/${f.datos.id}`)).datos;
    assert.equal(d.status, 'anulada');
    assert.equal(d.voidReason, 'Capturada con el monto equivocado');
    assert.equal(d.balance, 0);
    assert.deepEqual(d.audit.map(a => a.action), ['CREATE_INVOICE', 'VOID_INVOICE']);
    assert.equal((await api.post(`/api/billing/invoices/${f.datos.id}/void`, { reason: 'otra vez' })).estado, 409);
    const reemplazo = await factura({ cycleStart: '2030-01-15', issuedOn: '2030-01-15' });
    assert.equal(reemplazo.estado, 201);
    assert.ok(reemplazo.datos.number > f.datos.number);
    const lista = (await api.get('/api/billing/invoices?status=anulada')).datos;
    assert.ok(lista.invoices.some(i => i.id === f.datos.id));
    assert.equal(lista.summary.total, 0, 'las anuladas no suman al total');
  });

  test('una factura con cobros aplicados no se anula sin revertirlos', async () => {
    const f = await factura({ cycleStart: '2030-02-15', issuedOn: '2030-02-15' });
    const [cobro] = await db`INSERT INTO billing_payments (owner_id, payer_client_id, paid_on, amount, method) VALUES (${ownerId}, ${riccardo}, '2030-02-15', 450, 'Yappy') RETURNING id`;
    const [ap] = await db`INSERT INTO billing_payment_applications (payment_id, invoice_id, amount, applied_on) VALUES (${cobro.id}, ${f.datos.id}, 450, '2030-02-15') RETURNING id`;
    const detalle = (await api.get(`/api/billing/invoices/${f.datos.id}`)).datos;
    assert.equal(detalle.paid, 450);
    assert.equal(detalle.balance, 0);
    assert.equal(detalle.applications.length, 1);
    const r = await api.post(`/api/billing/invoices/${f.datos.id}/void`, { reason: 'Quiero anularla' });
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /revierta primero/);
    await db`UPDATE billing_payment_applications SET reversed_at = now(), reversal_reason = 'Error de captura' WHERE id = ${ap.id}`;
    assert.equal((await api.post(`/api/billing/invoices/${f.datos.id}/void`, { reason: 'Quiero anularla' })).estado, 200);
  });

  test('el PDF se genera como application/pdf con el número FAC', async () => {
    const f = await factura({ cycleStart: '2030-03-15', issuedOn: '2030-03-15',
      lines: [{ beneficiaryClientId: riccardo, description: 'Riccardo', unitAmount: 450 }, { beneficiaryClientId: iraida, description: 'Iraida', unitAmount: 300 }] });
    const r = await api.get(`/api/billing/invoices/${f.datos.id}/pdf`);
    assert.equal(r.estado, 200);
    assert.match(r.cabeceras.get('content-type'), /application\/pdf/);
    assert.match(r.cabeceras.get('content-disposition'), new RegExp(f.datos.code));
    assert.ok(String(r.datos).startsWith('%PDF'));
    assert.equal((await api.get('/api/billing/invoices/00000000-0000-0000-0000-000000000000/pdf')).estado, 404);
  });

  test('el diagnóstico del motor muestra legacy por defecto', async () => {
    const r = await api.get('/api/billing/engine-status');
    assert.equal(r.estado, 200);
    assert.equal(r.datos.state, 'legacy');
    assert.equal(r.datos.legacyWrites, true);
    assert.equal(r.datos.newWrites, false);
  });
});
