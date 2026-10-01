// Etapa 1B-3: cobros (dinero recibido) y su aplicación a facturas.
// Fechas literales: ninguna prueba depende del reloj ni del mes en curso.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; let ownerId;
let eduardo; let beatris; let julieta; let juanPadre; let riccardo; let iraida; let ernesto;

const nuevoCliente = async (nombre, cutoffDay = 15) => {
  const r = await api.post('/api/clients', { fullName: nombre, cutoffDay });
  assert.equal(r.estado, 201);
  return r.datos.id;
};
const factura = async (payer, lineas, extra = {}) => {
  const r = await api.post('/api/billing/invoices', {
    payerClientId: payer, kind: 'mensual', cycleStart: '2026-09-28', issuedOn: '2026-09-28',
    lines: lineas.map(([beneficiaryClientId, unitAmount, description]) => ({ beneficiaryClientId, unitAmount, description })), ...extra
  });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  return r.datos;
};
const cobro = (payer, amount, extra = {}) => api.post('/api/billing/payments', {
  payerClientId: payer, amount, method: 'Transferencia bancaria', paidOn: '2026-09-28', ...extra
});
const detalleFactura = async id => (await api.get(`/api/billing/invoices/${id}`)).datos;
const detalleCobro = async id => (await api.get(`/api/billing/payments/${id}`)).datos;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 4 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  [{ id: ownerId }] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  eduardo = await nuevoCliente('Eduardo', 28); beatris = await nuevoCliente('Beatris', 28);
  julieta = await nuevoCliente('Julieta', 25); juanPadre = await nuevoCliente('Juan de Diego padre', 25);
  riccardo = await nuevoCliente('Riccardo'); iraida = await nuevoCliente('Iraida'); ernesto = await nuevoCliente('Ernesto');
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

describe('registrar un cobro', () => {
  test('Eduardo y Beatris: UN cobro de $350 paga una factura de dos líneas de $175 (J-051)', async () => {
    const f = await factura(eduardo, [[eduardo, 175, 'Eduardo'], [beatris, 175, 'Beatris']]);
    assert.equal(f.total, 350);
    const c = await cobro(eduardo, 350, { applications: [{ invoiceId: f.id, amount: 350 }] });
    assert.equal(c.estado, 201);
    assert.equal(c.datos.available, 0);
    const d = await detalleFactura(f.id);
    assert.equal(d.status, 'pagada');
    assert.equal(d.paid, 350);
    assert.equal(d.balance, 0);
    assert.equal(d.applications.length, 1);
    const p = await detalleCobro(c.datos.id);
    assert.equal(p.status, 'aplicado');
    assert.deepEqual(p.audit.map(a => a.action), ['CREATE_PAYMENT', 'APPLY_PAYMENT']);
  });

  test('Julieta pagó un día tarde: el cobro del 26-09 se aplica al ciclo que empezó el 25-09', async () => {
    const f = await factura(julieta, [[julieta, 150, 'Julieta'], [juanPadre, 150, 'Juan de Diego padre']], { cycleStart: '2026-09-25', issuedOn: '2026-09-25' });
    const c = await cobro(julieta, 300, { method: 'Yappy', paidOn: '2026-09-26', applications: [{ invoiceId: f.id, amount: 300 }] });
    assert.equal(c.estado, 201);
    const d = await detalleFactura(f.id);
    assert.equal(d.cycleStart, '2026-09-25');
    assert.equal(d.status, 'pagada');
    assert.equal(d.applications[0].paidOn, '2026-09-26');
  });

  test('sin aplicar: queda como saldo a favor del pagador', async () => {
    const c = await cobro(riccardo, 100, { paidOn: '2026-09-16' });
    assert.equal(c.estado, 201);
    assert.equal(c.datos.available, 100);
    const p = await detalleCobro(c.datos.id);
    assert.equal(p.status, 'sin_aplicar');
    assert.equal(p.available, 100);
    const lista = (await api.get('/api/billing/payments?status=available')).datos;
    assert.ok(lista.payments.some(x => x.id === c.datos.id));
    assert.ok(lista.summary.available >= 100);
  });

  test('pago parcial: la factura queda en parcial y luego en pagada', async () => {
    const f = await factura(riccardo, [[riccardo, 450], [iraida, 300], [ernesto, 150]], { cycleStart: '2026-09-15', issuedOn: '2026-09-15' });
    const a = await cobro(riccardo, 400, { paidOn: '2026-09-16', applications: [{ invoiceId: f.id, amount: 400 }] });
    assert.equal(a.estado, 201);
    let d = await detalleFactura(f.id);
    assert.deepEqual([d.status, d.paid, d.balance], ['parcial', 400, 500]);
    const b = await cobro(riccardo, 500, { paidOn: '2026-09-20', applications: [{ invoiceId: f.id, amount: 500 }] });
    assert.equal(b.estado, 201);
    d = await detalleFactura(f.id);
    assert.deepEqual([d.status, d.paid, d.balance], ['pagada', 900, 0]);
  });

  test('pago adelantado: un cobro puede aplicarse a una factura posterior', async () => {
    const f = await factura(ernesto, [[ernesto, 120, '4 sesiones propias']], { cycleStart: '2026-10-15', issuedOn: '2026-10-15' });
    const c = await cobro(ernesto, 120, { paidOn: '2026-10-01', applications: [{ invoiceId: f.id, amount: 120 }] });
    assert.equal(c.estado, 201);
    assert.equal((await detalleFactura(f.id)).status, 'pagada');
  });

  test('sobrepago: lo que sobra queda como saldo a favor y se aplica después', async () => {
    const f1 = await factura(iraida, [[iraida, 200]], { cycleStart: '2026-11-15', issuedOn: '2026-11-15' });
    const f2 = await factura(iraida, [[iraida, 200]], { cycleStart: '2026-12-15', issuedOn: '2026-12-15' });
    const c = await cobro(iraida, 300, { applications: [{ invoiceId: f1.id, amount: 200 }] });
    assert.equal(c.datos.available, 100);
    const r = await api.post(`/api/billing/payments/${c.datos.id}/applications`, { applications: [{ invoiceId: f2.id, amount: 100 }] });
    assert.equal(r.estado, 201);
    assert.equal(r.datos.available, 0);
    assert.equal((await detalleFactura(f2.id)).status, 'parcial');
    assert.equal((await detalleCobro(c.datos.id)).status, 'aplicado');
  });
});

describe('reglas: lo que se rechaza con un mensaje claro', () => {
  test('no supera el saldo de la factura ni lo disponible del cobro', async () => {
    const f = await factura(julieta, [[julieta, 100]], { cycleStart: '2027-01-25', issuedOn: '2027-01-25' });
    const exceso = await cobro(julieta, 500, { applications: [{ invoiceId: f.id, amount: 150 }] });
    assert.equal(exceso.estado, 409);
    assert.match(exceso.datos.error, /supera el saldo de FAC-\d{4} \(\$100\.00\)/);
    const poco = await cobro(julieta, 50, { applications: [{ invoiceId: f.id, amount: 80 }] });
    assert.equal(poco.estado, 409);
    assert.match(poco.datos.error, /supera lo disponible del cobro/);
    const lista = (await api.get(`/api/billing/payments?payerId=${julieta}`)).datos.payments;
    assert.ok(!lista.some(p => p.amount === 500 || p.amount === 50), 'si la aplicación falla, el cobro tampoco se crea');
  });

  test('un cobro solo se aplica a facturas de su pagador', async () => {
    const f = await factura(beatris, [[beatris, 60]], { cycleStart: '2027-02-28', issuedOn: '2027-02-28' });
    const r = await cobro(eduardo, 60, { applications: [{ invoiceId: f.id, amount: 60 }] });
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /otro pagador/);
  });

  test('no se aplica a una factura anulada ni dos veces la misma factura', async () => {
    const f = await factura(juanPadre, [[juanPadre, 70]], { cycleStart: '2027-03-25', issuedOn: '2027-03-25' });
    await api.post(`/api/billing/invoices/${f.id}/void`, { reason: 'Prueba' });
    const r = await cobro(juanPadre, 70, { applications: [{ invoiceId: f.id, amount: 70 }] });
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /anulada/);
    const g = await factura(juanPadre, [[juanPadre, 70]], { cycleStart: '2027-04-25', issuedOn: '2027-04-25' });
    const dup = await cobro(juanPadre, 70, { applications: [{ invoiceId: g.id, amount: 30 }, { invoiceId: g.id, amount: 40 }] });
    assert.equal(dup.estado, 400);
  });

  test('método inválido, monto no positivo, pagador ajeno y sin sesión', async () => {
    assert.equal((await cobro(eduardo, 10, { method: 'Trueque' })).estado, 400);
    assert.equal((await cobro(eduardo, 0)).estado, 400);
    assert.equal((await cobro(eduardo, -5)).estado, 400);
    const [{ id: otro }] = await db`INSERT INTO users (email, password_hash, full_name, role) VALUES ('otra@prueba.test', 'x', 'Otra', 'trainer') RETURNING id`;
    const [{ id: ajeno }] = await db`INSERT INTO clients (owner_id, full_name) VALUES (${otro}, 'Ajeno') RETURNING id`;
    assert.equal((await cobro(ajeno, 10)).estado, 404);
    assert.equal((await cliente(servidor.base).get('/api/billing/payments')).estado, 401);
  });

  test('los decimales no acumulan error (33,33 + 33,33 + 33,34)', async () => {
    const f = await factura(iraida, [[iraida, 100]], { cycleStart: '2027-05-15', issuedOn: '2027-05-15' });
    const c = await cobro(iraida, 100);
    for (const monto of [33.33, 33.33, 33.34]) {
      assert.equal((await api.post(`/api/billing/payments/${c.datos.id}/applications`, { applications: [{ invoiceId: f.id, amount: monto }] })).estado, 201);
    }
    const d = await detalleFactura(f.id);
    assert.deepEqual([d.status, d.paid, d.balance], ['pagada', 100, 0]);
  });
});

describe('corregir: revertir aplicaciones y anular cobros', () => {
  test('revertir una aplicación devuelve la factura a pendiente y libera el cobro', async () => {
    const f = await factura(ernesto, [[ernesto, 90]], { cycleStart: '2027-06-15', issuedOn: '2027-06-15' });
    const c = await cobro(ernesto, 90, { applications: [{ invoiceId: f.id, amount: 90 }] });
    const ap = (await detalleCobro(c.datos.id)).applications[0];
    assert.equal((await api.post(`/api/billing/payment-applications/${ap.id}/reverse`, { reason: ' ' })).estado, 400);
    const r = await api.post(`/api/billing/payment-applications/${ap.id}/reverse`, { reason: 'Se aplicó a la factura equivocada' });
    assert.equal(r.estado, 200);
    assert.equal((await detalleFactura(f.id)).status, 'pendiente');
    const p = await detalleCobro(c.datos.id);
    assert.equal(p.available, 90);
    assert.equal(p.applications[0].reversalReason, 'Se aplicó a la factura equivocada');
    assert.equal((await api.post(`/api/billing/payment-applications/${ap.id}/reverse`, { reason: 'otra vez' })).estado, 409);
    // y se puede aplicar de nuevo
    assert.equal((await api.post(`/api/billing/payments/${c.datos.id}/applications`, { applications: [{ invoiceId: f.id, amount: 90 }] })).estado, 201);
    assert.equal((await detalleFactura(f.id)).status, 'pagada');
  });

  test('anular un cobro exige revertir antes sus aplicaciones y no se puede volver a aplicar', async () => {
    const f = await factura(eduardo, [[eduardo, 40]], { cycleStart: '2027-07-28', issuedOn: '2027-07-28' });
    const c = await cobro(eduardo, 40, { applications: [{ invoiceId: f.id, amount: 40 }] });
    const bloqueado = await api.post(`/api/billing/payments/${c.datos.id}/void`, { reason: 'Monto equivocado' });
    assert.equal(bloqueado.estado, 409);
    assert.match(bloqueado.datos.error, /revierta primero/);
    const ap = (await detalleCobro(c.datos.id)).applications[0];
    await api.post(`/api/billing/payment-applications/${ap.id}/reverse`, { reason: 'Monto equivocado' });
    assert.equal((await api.post(`/api/billing/payments/${c.datos.id}/void`, { reason: ' ' })).estado, 400);
    assert.equal((await api.post(`/api/billing/payments/${c.datos.id}/void`, { reason: 'Monto equivocado' })).estado, 200);
    const p = await detalleCobro(c.datos.id);
    assert.equal(p.status, 'anulado');
    assert.equal(p.available, 0);
    assert.equal((await api.post(`/api/billing/payments/${c.datos.id}/void`, { reason: 'otra vez' })).estado, 409);
    const otra = await api.post(`/api/billing/payments/${c.datos.id}/applications`, { applications: [{ invoiceId: f.id, amount: 40 }] });
    assert.equal(otra.estado, 409);
    assert.match(otra.datos.error, /anulado/);
    const anulados = (await api.get('/api/billing/payments?status=voided')).datos;
    assert.ok(anulados.payments.every(x => x.status === 'anulado'));
    assert.equal(anulados.summary.total, 0, 'los anulados no suman');
  });

  test('una factura con cobros aplicados sigue sin poder anularse (1B-2) hasta revertirlos', async () => {
    const f = await factura(iraida, [[iraida, 55]], { cycleStart: '2027-08-15', issuedOn: '2027-08-15' });
    const c = await cobro(iraida, 55, { applications: [{ invoiceId: f.id, amount: 55 }] });
    assert.equal((await api.post(`/api/billing/invoices/${f.id}/void`, { reason: 'Quiero anularla' })).estado, 409);
    const ap = (await detalleCobro(c.datos.id)).applications[0];
    await api.post(`/api/billing/payment-applications/${ap.id}/reverse`, { reason: 'Corrección' });
    assert.equal((await api.post(`/api/billing/invoices/${f.id}/void`, { reason: 'Quiero anularla' })).estado, 200);
  });

  test('un cobro no se edita ni se borra: lo impone la base aunque se intente por SQL', async () => {
    const c = await cobro(julieta, 12);
    await assert.rejects(db`UPDATE billing_payments SET amount = 99 WHERE id = ${c.datos.id}`, /no se edita/);
    await assert.rejects(db`DELETE FROM billing_payments WHERE id = ${c.datos.id}`, /no se borra/);
    await db`UPDATE billing_payments SET voided_at = now(), void_reason = 'Prueba directa' WHERE id = ${c.datos.id}`;
    await assert.rejects(db`UPDATE billing_payments SET voided_at = NULL, void_reason = NULL WHERE id = ${c.datos.id}`, /no se reactiva/);
  });
});

describe('listados y estado de las facturas', () => {
  test('la lista de facturas filtra las abiertas y refleja pagado y saldo', async () => {
    const abiertas = (await api.get(`/api/billing/invoices?status=abierta&payerId=${iraida}`)).datos;
    assert.ok(abiertas.invoices.every(i => i.status === 'pendiente' || i.status === 'parcial'));
    const pagadas = (await api.get('/api/billing/invoices?status=pagada')).datos;
    assert.ok(pagadas.invoices.length >= 3);
    assert.ok(pagadas.invoices.every(i => i.balance === 0 && i.paid === i.total));
  });

  test('los cobros se listan con pagador, rango y resumen; el sistema anterior no cambia', async () => {
    const [{ antes }] = await db`SELECT (SELECT count(*) FROM invoices)::int AS antes`;
    const lista = (await api.get('/api/billing/payments?from=2026-09-26&to=2026-09-26')).datos;
    assert.ok(lista.payments.some(p => p.payerName === 'Julieta' && p.amount === 300 && p.method === 'Yappy'));
    assert.ok(lista.payments.every(p => p.paidOn === '2026-09-26'));
    await cobro(eduardo, 5);
    const [{ despues }] = await db`SELECT (SELECT count(*) FROM invoices)::int AS despues`;
    assert.equal(despues, antes);
  });

  test('veinte cobros simultáneos sobre la misma factura nunca la pasan de su saldo', async () => {
    const f = await factura(ernesto, [[ernesto, 100]], { cycleStart: '2027-09-15', issuedOn: '2027-09-15' });
    const resultados = await Promise.all(Array.from({ length: 20 }, () => cobro(ernesto, 10, { applications: [{ invoiceId: f.id, amount: 10 }] })));
    const buenos = resultados.filter(r => r.estado === 201).length;
    assert.equal(buenos, 10, 'solo caben diez cobros de $10');
    assert.ok(resultados.filter(r => r.estado !== 201).every(r => r.estado === 409));
    const d = await detalleFactura(f.id);
    assert.deepEqual([d.status, d.paid, d.balance], ['pagada', 100, 0]);
  });
});
