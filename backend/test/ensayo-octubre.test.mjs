// ENSAYO GENERAL con la configuración REAL de producción (planes, cortes y facturas de referencia al 01-10-2026): se simula, día por día, qué emite
// el generador desde el 01-10 hasta el 02-11 (reloj inyectado). Es el ensayo de lo que pasará el 15-10, 20-10, 25-10, 28-10, 31-10 y 01-11.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; let ownerId; let gen; let dbModulo; const id = {}; const emitidas = [];

const nuevo = async (nombre, corte) => { const r = await api.post('/api/clients', { fullName: nombre, cutoffDay: corte }); assert.equal(r.estado, 201); id[nombre] = r.datos.id; };
const linea = async (b, p, kind, price, startsOn, extra = {}) => { const r = await api.post(`/api/clients/${id[b]}/billing-subscriptions`, { beneficiaryClientId: id[b], payerClientId: id[p], kind, price, startsOn, ...extra }); assert.equal(r.estado, 201, JSON.stringify(r.datos)); };
const referencia = async (payer, kind, a, b, lines, extra = {}) => { const r = await api.post('/api/billing/invoices', { payerClientId: id[payer], kind, cycleStart: a, cycleEnd: b, issuedOn: kind === 'credito' ? b : a, ...extra, lines: lines.map(([n, unitAmount, description]) => ({ beneficiaryClientId: id[n], unitAmount, description })) }); assert.equal(r.estado, 201, JSON.stringify(r.datos)); };

before(async () => {
  servidor = await levantar();
  process.env.DATABASE_URL = servidor.databaseUrl; process.env.JWT_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres'; process.env.SETUP_TOKEN = SETUP_TOKEN;
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 6 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  [{ id: ownerId }] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  gen = await import('../dist/billing-generator.js'); dbModulo = await import('../dist/db.js');
  for (const [n, c] of [['Riccardo', 15], ['Iraida', 15], ['Ernesto', 15], ['Michelle', 15], ['Julieta', 25], ['Juan padre', 25], ['Eduardo', 28], ['Beatris', 28], ['Gila', 28], ['Milo', 28], ['Sandy', 1], ['Sally', 1], ['Sara', 1], ['Julio', 31]]) await nuevo(n, c);
  // Planes (como están hoy en producción)
  await linea('Riccardo', 'Riccardo', 'monthly', 460, '2026-09-15'); await linea('Iraida', 'Riccardo', 'monthly', 320, '2026-09-15'); await linea('Ernesto', 'Riccardo', 'monthly', 120, '2026-09-15');
  await linea('Ernesto', 'Ernesto', 'monthly', 120, '2026-09-15'); await linea('Michelle', 'Michelle', 'monthly', 280, '2026-09-15');
  await linea('Julieta', 'Julieta', 'monthly', 150, '2026-09-25'); await linea('Juan padre', 'Julieta', 'monthly', 150, '2026-09-25');
  await linea('Eduardo', 'Eduardo', 'monthly', 175, '2026-09-28'); await linea('Beatris', 'Eduardo', 'monthly', 175, '2026-09-28');
  await linea('Gila', 'Gila', 'monthly', 240, '2026-09-28'); await linea('Milo', 'Milo', 'monthly', 120, '2026-09-28');
  await linea('Sandy', 'Sandy', 'monthly', 300, '2026-09-01'); await linea('Sally', 'Sally', 'monthly', 400, '2026-09-01');
  await linea('Sara', 'Sara', 'package', 420, '2026-09-15', { cycleDays: 35 }); await linea('Julio', 'Julio', 'credit', 25, '2026-08-31');
  // Facturas de referencia (la última de cada pagador, como quedó tras la carga)
  await referencia('Riccardo', 'mensual', '2026-09-15', '2026-10-15', [['Riccardo', 460, 'Mensualidad'], ['Iraida', 320, 'Mensualidad'], ['Ernesto', 120, 'Mensualidad']]);
  await referencia('Ernesto', 'mensual', '2026-09-15', '2026-10-15', [['Ernesto', 120, 'Mensualidad']]); await referencia('Michelle', 'mensual', '2026-09-15', '2026-10-15', [['Michelle', 280, 'Mensualidad']]);
  await referencia('Julieta', 'mensual', '2026-09-25', '2026-10-25', [['Julieta', 150, 'Mensualidad'], ['Juan padre', 150, 'Mensualidad']]);
  await referencia('Eduardo', 'mensual', '2026-09-28', '2026-10-28', [['Eduardo', 175, 'Mensualidad'], ['Beatris', 175, 'Mensualidad']]);
  await referencia('Gila', 'mensual', '2026-09-28', '2026-10-28', [['Gila', 240, 'Mensualidad']]); await referencia('Milo', 'mensual', '2026-09-28', '2026-10-28', [['Milo', 120, 'Mensualidad']]);
  await referencia('Sandy', 'mensual', '2026-10-01', '2026-11-01', [['Sandy', 300, 'Mensualidad']]); await referencia('Sally', 'mensual', '2026-10-01', '2026-11-01', [['Sally', 400, 'Mensualidad']]);
  await referencia('Sara', 'paquete', '2026-09-15', '2026-10-20', [['Sara', 420, 'Paquete']], { cycleDays: 35 });
  await referencia('Julio', 'credito', '2026-08-31', '2026-09-30', [['Julio', 25, 'Sesiones a crédito']]);
  // Clases de Julio en octubre: 6 cumplidas, 1 cancelación cobrada, 1 cancelación suya NO cobrada, 1 de Eileen, 1 ausencia
  const ses = (f, status = 'completed', e = {}) => db`INSERT INTO sessions (client_id, starts_at, status, cancellation_kind, cancelled_by, credit_charge) VALUES (${id.Julio}, ${f}::timestamptz, ${status}, ${e.kind ?? null}, ${e.by ?? null}, ${e.cargo ?? false})`;
  for (const f of ['2026-10-02', '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27', '2026-10-31']) await ses(`${f}T10:00:00-05:00`);
  await ses('2026-10-16T10:00:00-05:00', 'cancelled', { kind: 'not_rescheduled', by: 'client', cargo: true });
  await ses('2026-10-22T10:00:00-05:00', 'cancelled', { kind: 'not_rescheduled', by: 'client', cargo: false });
  await ses('2026-10-24T10:00:00-05:00', 'cancelled', { kind: 'not_rescheduled', by: 'trainer', cargo: false });
  await ses('2026-10-29T10:00:00-05:00', 'no_show');
  // Se corre el generador día por día, cada hora relevante (12:00 y, el último día del mes, 20:00 y 21:00)
  const dias = []; for (let d = new Date('2026-10-01T12:00:00Z'); d <= new Date('2026-11-02T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) dias.push(d.toISOString().slice(0, 10));
  for (const dia of dias) for (const hora of dia === '2026-10-31' ? [12, 20, 21, 22] : [12]) {
    const r = await gen.runBillingGeneration(ownerId, dia, hora);
    for (const c of r.created) emitidas.push({ dia, hora, ...c });
    for (const sk of r.skipped.filter(x => x.status === 'omitida')) emitidas.push({ dia, hora, omitida: sk.payerName, razon: sk.reason });
  }
}, { timeout: 180_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await dbModulo?.sql.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('ENSAYO: el calendario de emisión de octubre con la configuración real (cada factura sale SOLO el día que toca, con su importe)', () => {
  const tabla = emitidas.filter(e => e.code).map(e => `${e.dia} ${String(e.hora).padStart(2, '0')}:00  ${e.code}  ${e.payerName.padEnd(12)} ${e.kind.padEnd(8)} ${e.cycleStart} -> ${e.cycleEnd}  $${e.total}`);
  console.log('\n' + tabla.join('\n'));
  const esperado = [
    ['2026-10-15', 'Riccardo', 900], ['2026-10-15', 'Ernesto', 120], ['2026-10-15', 'Michelle', 280],
    ['2026-10-20', 'Sara', 420], ['2026-10-25', 'Julieta', 300],
    ['2026-10-28', 'Eduardo', 350], ['2026-10-28', 'Gila', 240], ['2026-10-28', 'Milo', 120],
    ['2026-10-31', 'Julio', 175],
    ['2026-11-01', 'Sandy', 300], ['2026-11-01', 'Sally', 400]
  ];
  const obtenido = emitidas.filter(e => e.code).map(e => [e.dia, e.payerName, e.total]);
  assert.deepEqual(obtenido.sort(), esperado.sort());
  assert.equal(emitidas.filter(e => e.omitida).length, 0, 'nada se pierde: ninguna factura quedó omitida');
});

test('Julio: 6 cumplidas + 1 cancelación cobrada = 7 clases × $25 = $175; sale el 31-10 a las 21:00 (no antes) con fecha 31-10; ni la cancelación no cobrada, ni la de Eileen, ni la ausencia cuentan', () => {
  const julio = emitidas.filter(e => e.payerName === 'Julio');
  assert.equal(julio.length, 1);
  assert.deepEqual([julio[0].dia, julio[0].hora, julio[0].total, julio[0].cycleEnd], ['2026-10-31', 21, 175, '2026-10-31']);
});

test('cada pagador recibe UNA sola factura de su ciclo, con el reparto por persona correcto (Riccardo: 460 + 320 + 120; Eduardo: 175 + 175; Julieta: 150 + 150)', async () => {
  const lineas = async pagador => (await db`SELECT c.full_name AS persona, l.amount::float AS monto FROM billing_invoices i JOIN billing_invoice_lines l ON l.invoice_id = i.id JOIN clients c ON c.id = l.beneficiary_client_id
    WHERE i.payer_client_id = ${id[pagador]} AND i.origin = 'auto' AND i.kind = 'mensual' ORDER BY c.full_name`).map(r => [r.persona, r.monto]);
  assert.deepEqual(await lineas('Riccardo'), [['Ernesto', 120], ['Iraida', 320], ['Riccardo', 460]]);
  assert.deepEqual(await lineas('Eduardo'), [['Beatris', 175], ['Eduardo', 175]]);
  assert.deepEqual(await lineas('Julieta'), [['Juan padre', 150], ['Julieta', 150]]);
  const [{ n }] = await db`SELECT count(*)::int AS n FROM billing_invoices WHERE origin = 'auto'`; assert.equal(n, 11);
  const numeros = (await db`SELECT number FROM billing_invoices ORDER BY number`).map(r => r.number);
  assert.deepEqual(numeros, Array.from({ length: numeros.length }, (_, i) => i + 1), 'numeración sin huecos');
});
