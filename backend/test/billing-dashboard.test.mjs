// Panel de Facturas: filtros por mes de emisión, corte y cliente, con líneas, cobros y totales.
// Fechas literales: nada depende del reloj.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; const id = {};

const factura = async (payer, cycleStart, cycleEnd, dueOn, lines) => {
  const r = await api.post('/api/billing/invoices', { payerClientId: payer, kind: 'mensual', cycleStart, cycleEnd, issuedOn: cycleStart, dueOn,
    lines: lines.map(([beneficiaryClientId, unitAmount, description]) => ({ beneficiaryClientId, unitAmount, description })) });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  return r.datos;
};
const cobro = async (payer, amount, method, paidOn, applications) => {
  const r = await api.post('/api/billing/payments', { payerClientId: payer, amount, method, paidOn, applications });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  return r.datos;
};
const lista = async (query = '') => (await api.get(`/api/billing/invoices?details=1${query}`)).datos;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 4 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  for (const [nombre, corte] of [['Riccardo', 15], ['Iraida', 15], ['Sandy', 1], ['Eduardo', 28]]) {
    const r = await api.post('/api/clients', { fullName: nombre, cutoffDay: corte });
    id[nombre] = r.datos.id;
  }
  // Septiembre: Riccardo (familia, pagada con un cobro de $750), Sandy (pagada), Eduardo (pendiente vencida). Octubre: Sandy (pendiente futura).
  const f1 = await factura(id.Riccardo, '2026-09-15', '2026-10-15', '2026-09-15', [[id.Riccardo, 450, 'Mensualidad'], [id.Iraida, 300, 'Mensualidad']]);
  const f2 = await factura(id.Sandy, '2026-09-01', '2026-10-01', '2026-09-01', [[id.Sandy, 300, 'Mensualidad']]);
  await factura(id.Eduardo, '2026-09-28', '2026-10-28', '2026-09-28', [[id.Eduardo, 175, 'Mensualidad']]);
  await factura(id.Sandy, '2026-10-01', '2026-11-01', '2099-10-01', [[id.Sandy, 300, 'Mensualidad']]);
  await cobro(id.Riccardo, 750, 'Yappy', '2026-09-16', [{ invoiceId: f1.id, amount: 750 }]);
  await cobro(id.Sandy, 300, 'Transferencia bancaria', '2026-09-02', [{ invoiceId: f2.id, amount: 300 }]);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('sin filtros trae todas con sus líneas y cobros, los totales del panel y los meses y cortes que existen', async () => {
  const r = await lista();
  assert.equal(r.invoices.length, 4);
  const riccardo = r.invoices.find(f => f.payerName === 'Riccardo');
  assert.deepEqual(riccardo.lines.map(l => [l.beneficiaryName, l.amount]), [['Iraida', 300], ['Riccardo', 450]]);
  assert.deepEqual(riccardo.lines.map(l => l.beneficiaryClientId).sort(), [id.Iraida, id.Riccardo].sort(), 'cada línea trae el id de la persona (lo usa Corregir reparto)');
  assert.deepEqual(riccardo.payments.map(p => [p.method, p.amount, p.paidOn]), [['Yappy', 750, '2026-09-16']]);
  assert.deepEqual(r.meta, { months: ['2026-09', '2026-10'], cutDays: [1, 15, 28] });
  assert.deepEqual(
    [r.summary.count, r.summary.total, r.summary.paid, r.summary.balance, r.summary.paymentsCount, r.summary.paidCount, r.summary.pendingCount],
    [4, 1225 + 300, 1050, 475, 2, 2, 2]);
  assert.equal(r.summary.overdueCount, 1, 'solo la de Eduardo (2026) está vencida; la de octubre vence en 2099');
  assert.equal(r.summary.overdueBalance, 175);
});

test('filtra por mes de emisión', async () => {
  const sep = await lista('&month=2026-09');
  assert.deepEqual(sep.invoices.map(f => f.payerName).sort(), ['Eduardo', 'Riccardo', 'Sandy']);
  assert.deepEqual([sep.summary.count, sep.summary.total, sep.summary.balance], [3, 1225, 175]);
  const oct = await lista('&month=2026-10');
  assert.deepEqual([oct.summary.count, oct.summary.total, oct.summary.paid, oct.summary.balance], [1, 300, 0, 300]);
  assert.deepEqual(oct.meta.months, ['2026-09', '2026-10'], 'los meses disponibles no dependen del filtro');
  assert.equal((await api.get('/api/billing/invoices?month=2026-13')).estado, 400);
});

test('filtra por corte del pagador', async () => {
  assert.deepEqual((await lista('&cutDay=15')).invoices.map(f => f.payerName), ['Riccardo']);
  assert.deepEqual((await lista('&cutDay=1')).invoices.map(f => f.payerName), ['Sandy', 'Sandy']);
  assert.deepEqual((await lista('&cutDay=28')).invoices.map(f => f.payerName), ['Eduardo']);
  assert.equal((await lista('&cutDay=20')).invoices.length, 0);
});

test('filtra por cliente: el pagador O quien figura en una línea (Iraida aparece en la factura de Riccardo)', async () => {
  assert.deepEqual((await lista(`&clientId=${id.Iraida}`)).invoices.map(f => f.payerName), ['Riccardo']);
  assert.deepEqual((await lista(`&clientId=${id.Sandy}`)).invoices.length, 2);
  assert.deepEqual((await lista(`&clientId=${id.Riccardo}`)).invoices.length, 1);
});

test('los filtros se combinan (mes + cliente + estado) y los totales siguen a la selección', async () => {
  const r = await lista(`&month=2026-09&clientId=${id.Sandy}&status=pagada`);
  assert.deepEqual(r.invoices.map(f => f.code), ['FAC-0002']);
  assert.deepEqual([r.summary.total, r.summary.paid, r.summary.paymentsCount, r.summary.balance], [300, 300, 1, 0]);
  const vencidas = await lista('&status=vencida');
  assert.deepEqual(vencidas.invoices.map(f => f.payerName), ['Eduardo']);
  assert.equal(vencidas.summary.pendingCount, 1);
});

test('sin details=1 la respuesta es la de siempre (sin líneas ni meta)', async () => {
  const r = (await api.get('/api/billing/invoices')).datos;
  assert.equal(r.invoices.length, 4);
  assert.equal(r.invoices[0].lines, undefined);
  assert.equal(r.meta, undefined);
  assert.deepEqual(Object.keys(r.summary).sort(), ['balance', 'count', 'total']);
});

test('exige sesión', async () => {
  assert.equal((await cliente(servidor.base).get('/api/billing/invoices?details=1')).estado, 401);
});

test('"activa" (la vista de entrada) oculta las anuladas; "all" y "anulada" las muestran', async () => {
  const extra = await factura(id.Eduardo, '2026-10-28', '2026-11-28', '2099-10-28', [[id.Eduardo, 175, 'Mensualidad']]);
  assert.equal((await api.post(`/api/billing/invoices/${extra.id}/void`, { reason: 'prueba de anulación' })).estado, 200);
  const activas = await lista('&status=activa');
  assert.ok(activas.invoices.every(f => f.status !== 'anulada'));
  assert.equal(activas.invoices.length, 4);
  assert.equal((await lista('&status=all')).invoices.length, 5);
  assert.deepEqual((await lista('&status=anulada')).invoices.map(f => f.id), [extra.id]);
});
