// Corregir el REPARTO por persona de una factura ya emitida (y pagada) sin cambiar su total.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; const id = {}; let factura;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 4 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  for (const n of ['Riccardo', 'Iraida', 'Ernesto', 'Otro']) id[n] = (await api.post('/api/clients', { fullName: n, cutoffDay: 15 })).datos.id;
  const f = await api.post('/api/billing/invoices', { payerClientId: id.Riccardo, kind: 'mensual', cycleStart: '2026-09-15', cycleEnd: '2026-10-15', issuedOn: '2026-09-15', dueOn: '2026-09-15',
    lines: [[id.Riccardo, 450], [id.Iraida, 300], [id.Ernesto, 150]].map(([beneficiaryClientId, unitAmount]) => ({ beneficiaryClientId, unitAmount, description: 'Mensualidad', sessionsReference: 4 })) });
  assert.equal(f.estado, 201, JSON.stringify(f.datos));
  factura = f.datos;
  const c = await api.post('/api/billing/payments', { payerClientId: id.Riccardo, amount: 900, method: 'Yappy', paidOn: '2026-09-16', applications: [{ invoiceId: factura.id, amount: 900 }] });
  assert.equal(c.estado, 201, JSON.stringify(c.datos));
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

const redistribuir = (facturaId, lines, reason = 'Reparto corregido por Joel') => api.post(`/api/billing/invoices/${facturaId}/redistribute`, { reason, lines });

test('un reparto que cambia el total se rechaza y no toca nada', async () => {
  const r = await redistribuir(factura.id, [[id.Riccardo, 460], [id.Iraida, 320], [id.Ernesto, 130]].map(([beneficiaryClientId, amount]) => ({ beneficiaryClientId, amount })));
  assert.equal(r.estado, 400);
  assert.match(r.datos.error, /debe seguir sumando \$900/);
  const [{ n }] = await db`SELECT count(*)::int AS n FROM billing_invoices`; assert.equal(n, 1);
  assert.equal((await redistribuir(factura.id, [{ beneficiaryClientId: id.Riccardo, amount: 900 }, { beneficiaryClientId: id.Riccardo, amount: 0.01 }])).estado, 400);
  assert.equal((await redistribuir(factura.id, [{ beneficiaryClientId: id.Riccardo, amount: 900 }], 'x')).estado, 400, 'el motivo es obligatorio (mínimo 3 letras)');
});

test('corrige el reparto 450/300/150 -> 460/320/120 de una factura PAGADA: anula la vieja, emite la nueva y reaplica el cobro', async () => {
  const r = await redistribuir(factura.id, [[id.Riccardo, 460], [id.Iraida, 320], [id.Ernesto, 120]].map(([beneficiaryClientId, amount]) => ({ beneficiaryClientId, amount })));
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  assert.deepEqual([r.datos.oldCode, r.datos.newCode, r.datos.total, r.datos.reappliedPayments], ['FAC-0001', 'FAC-0002', 900, 1]);

  const vieja = (await api.get(`/api/billing/invoices/${factura.id}`)).datos;
  assert.equal(vieja.status, 'anulada');
  assert.match(vieja.voidReason, /Reparto corregido.*Reparto corregido por Joel/);
  const nueva = (await api.get(`/api/billing/invoices/${r.datos.newId}`)).datos;
  assert.deepEqual([nueva.status, nueva.total, nueva.cycleStart, nueva.cycleEnd, nueva.issuedOn, nueva.dueOn, nueva.payerClientId], ['pagada', 900, '2026-09-15', '2026-10-15', '2026-09-15', '2026-09-15', id.Riccardo]);
  assert.deepEqual(nueva.lines.map(l => [l.beneficiaryName, l.amount]).sort(), [['Ernesto', 120], ['Iraida', 320], ['Riccardo', 460]]);
  assert.ok(nueva.lines.every(l => l.sessionsReference === 4 && l.description === 'Mensualidad'), 'conserva descripción y clases de referencia');
  assert.match(nueva.notes, /Reemplaza a FAC-0001/);

  const apps = await db`SELECT i.number, a.amount::float AS amount, a.reversed_at IS NOT NULL AS revertida, a.reversal_reason FROM billing_payment_applications a JOIN billing_invoices i ON i.id = a.invoice_id ORDER BY a.created_at`;
  assert.deepEqual(apps.map(a => [a.number, a.amount, a.revertida]), [[1, 900, true], [2, 900, false]]);
  assert.match(apps[0].reversal_reason, /Reparto corregido/);
  const [pago] = (await api.get('/api/billing/payments')).datos.payments;
  assert.deepEqual([pago.amount, pago.applied, pago.available], [900, 900, 0], 'el cobro sigue entero y aplicado a la factura nueva');
  assert.equal((await db`SELECT count(*)::int AS n FROM billing_payments`)[0].n, 1, 'no se duplicó ningún cobro');
  const [auditoria] = await db`SELECT detail FROM billing_audit WHERE action = 'REDISTRIBUTE_INVOICE'`;
  assert.equal(auditoria.detail.replaced, 'FAC-0001'); assert.equal(auditoria.detail.replacement, 'FAC-0002');
});

test('la factura anulada ya no se puede corregir, y la numeración sigue sin huecos', async () => {
  const r = await redistribuir(factura.id, [{ beneficiaryClientId: id.Riccardo, amount: 900 }]);
  assert.equal(r.estado, 409);
  const numeros = (await db`SELECT number FROM billing_invoices ORDER BY number`).map(x => x.number);
  assert.deepEqual(numeros, [1, 2]);
});

test('una factura pendiente (sin cobro) también se corrige; si falla algo, no queda nada a medias', async () => {
  const f = await api.post('/api/billing/invoices', { payerClientId: id.Riccardo, kind: 'mensual', cycleStart: '2026-10-15', cycleEnd: '2026-11-15', issuedOn: '2026-10-15',
    lines: [[id.Riccardo, 450], [id.Iraida, 300]].map(([beneficiaryClientId, unitAmount]) => ({ beneficiaryClientId, unitAmount })) });
  const mal = await redistribuir(f.datos.id, [{ beneficiaryClientId: '00000000-0000-4000-8000-000000000000', amount: 750 }]);
  assert.equal(mal.estado, 404);
  assert.equal((await api.get(`/api/billing/invoices/${f.datos.id}`)).datos.status, 'pendiente', 'sigue viva e intacta');
  const ok = await redistribuir(f.datos.id, [{ beneficiaryClientId: id.Riccardo, amount: 460 }, { beneficiaryClientId: id.Iraida, amount: 290 }]);
  assert.equal(ok.estado, 201, JSON.stringify(ok.datos));
  assert.equal(ok.datos.reappliedPayments, 0);
  assert.equal((await api.get(`/api/billing/invoices/${ok.datos.newId}`)).datos.status, 'pendiente');
});

test('exige sesión y solo corrige mensualidades y paquetes', async () => {
  assert.equal((await cliente(servidor.base).post(`/api/billing/invoices/${factura.id}/redistribute`, { reason: 'abc', lines: [] })).estado, 401);
  const suelta = await api.post('/api/billing/invoices', { payerClientId: id.Otro, kind: 'clase_suelta', issuedOn: '2026-09-20', lines: [{ beneficiaryClientId: id.Otro, unitAmount: 30 }] });
  const r = await redistribuir(suelta.datos.id, [{ beneficiaryClientId: id.Otro, amount: 30 }]);
  assert.equal(r.estado, 409);
});
