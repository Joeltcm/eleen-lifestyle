// Etapa 1B-6: generador de facturas del módulo nuevo (plan, emisión, reglas de D-15) y preparación del corte.
// Todas las fechas son literales y "hoy" se inyecta: nada depende del reloj ni del mes en curso.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; let ownerId; let gen; let dbModulo;
let riccardo; let iraida; let ernesto; let julio; let sara; let sandy; let inactivo;

const nuevoCliente = async (nombre, cutoffDay = 15, extra = {}) => {
  const r = await api.post('/api/clients', { fullName: nombre, cutoffDay, ...extra });
  assert.equal(r.estado, 201, nombre);
  return r.datos.id;
};
const linea = async (beneficiary, payer, kind, price, extra = {}) => {
  const r = await api.post(`/api/clients/${beneficiary}/billing-subscriptions`, {
    beneficiaryClientId: beneficiary, payerClientId: payer, kind, price, startsOn: '2026-09-01', ...extra
  });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  return r.datos;
};
const referencia = async (payer, kind, cycleStart, cycleEnd, lines) => {
  const r = await api.post('/api/billing/invoices', { payerClientId: payer, kind, cycleStart, cycleEnd, issuedOn: kind === 'credito' ? cycleEnd : cycleStart,
    lines: lines.map(([beneficiaryClientId, unitAmount, description]) => ({ beneficiaryClientId, unitAmount, description })) });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  return r.datos;
};
const plan = async (today, horizon = 0, hora = 12) => db.begin(tx => gen.planBillingGeneration(tx, ownerId, today, horizon, hora));
const deRiccardo = p => p.filter(i => i.payerId === riccardo);

before(async () => {
  servidor = await levantar();
  process.env.DATABASE_URL = servidor.databaseUrl; process.env.JWT_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres'; process.env.SETUP_TOKEN = SETUP_TOKEN;
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 6 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  [{ id: ownerId }] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  gen = await import('../dist/billing-generator.js');
  dbModulo = await import('../dist/db.js');
  riccardo = await nuevoCliente('Riccardo'); iraida = await nuevoCliente('Iraida'); ernesto = await nuevoCliente('Ernesto');
  julio = await nuevoCliente('Julio', 31); sara = await nuevoCliente('Sara Djamous', 1); sandy = await nuevoCliente('Sandy', 1); inactivo = await nuevoCliente('Pausada');
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await dbModulo?.sql.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

describe('fechas de corte (puras)', () => {
  test('siguiente corte estrictamente posterior, con ajuste al último día del mes', () => {
    assert.equal(gen.nextCutAfter('2026-09-15', 15), '2026-10-15');
    assert.equal(gen.nextCutAfter('2026-09-14', 15), '2026-09-15');
    assert.equal(gen.nextCutAfter('2026-09-30', 31), '2026-10-31');
    assert.equal(gen.nextCutAfter('2026-10-31', 31), '2026-11-30');
    assert.equal(gen.nextCutAfter('2027-01-31', 31), '2027-02-28');
    assert.equal(gen.nextCutAfter('2028-01-31', 30), '2028-02-29');
    assert.equal(gen.nextCutAfter('2026-12-15', 15), '2027-01-15');
    assert.equal(gen.addDays('2026-09-15', 35), '2026-10-20');
    assert.equal(gen.daysBetween('2026-10-15', '2026-10-19'), 4);
  });
});

describe('mensualidad anticipada y familia', () => {
  before(async () => {
    await linea(riccardo, riccardo, 'monthly', 450, { sessionsReference: 12 });
    await linea(iraida, riccardo, 'monthly', 300, { sessionsReference: 8 });
    await linea(ernesto, riccardo, 'monthly', 150, { sessionsReference: 4 });     // su parte familiar, dentro de la factura de Riccardo
    await linea(ernesto, ernesto, 'monthly', 120, { sessionsReference: 4 });      // su plan propio: OTRA factura, pagada por él
    await referencia(riccardo, 'mensual', '2026-09-15', '2026-10-15', [[riccardo, 450, 'Riccardo'], [iraida, 300, 'Iraida'], [ernesto, 150, 'Ernesto']]);
    await referencia(ernesto, 'mensual', '2026-09-15', '2026-10-15', [[ernesto, 120, '4 sesiones propias']]);
  });

  test('antes del corte no se emite nada; el día del corte sale la factura de la familia por $900', async () => {
    assert.equal((await plan('2026-10-14')).filter(i => i.status === 'emitir').length, 0);
    const hoy = (await plan('2026-10-15')).filter(i => i.status === 'emitir');
    const r = hoy.find(i => i.payerId === riccardo);
    assert.deepEqual([r.cycleStart, r.cycleEnd, r.issuedOn, r.dueOn, r.total], ['2026-10-15', '2026-11-15', '2026-10-15', '2026-10-15', 900]);
    assert.deepEqual(r.lines.map(l => [l.beneficiaryName, l.amount]).sort(), [['Ernesto', 150], ['Iraida', 300], ['Riccardo', 450]]);
  });

  test('Ernesto recibe DOS facturas en el mismo corte: la familiar (dentro de la de Riccardo) y la propia de $120 a su nombre', async () => {
    const hoy = (await plan('2026-10-15')).filter(i => i.status === 'emitir');
    assert.equal(hoy.length, 2);
    const propia = hoy.find(i => i.payerId === ernesto);
    assert.equal(propia.total, 120);
    assert.deepEqual(propia.lines.map(l => l.beneficiaryName), ['Ernesto']);
    assert.ok(!hoy.find(i => i.payerId === riccardo).lines.some(l => l.amount === 120), 'los $120 no se mezclan en la factura de Riccardo');
  });

  test('el plan no escribe nada', async () => {
    const [{ n }] = await db`SELECT count(*)::int AS n FROM billing_invoices`;
    await plan('2026-10-15', 60);
    assert.equal((await db`SELECT count(*)::int AS n FROM billing_invoices`)[0].n, n);
  });

  test('solo se emite el MISMO DÍA del corte: al día siguiente ya no se emite sola y se avisa que se crea a mano', async () => {
    assert.equal(deRiccardo(await plan('2026-10-14', 5)).find(i => i.cycleStart === '2026-10-15').status, 'programada', 'el día antes todavía no toca');
    assert.equal(deRiccardo(await plan('2026-10-15')).find(i => i.cycleStart === '2026-10-15').status, 'emitir');
    const tarde = deRiccardo(await plan('2026-10-16')).find(i => i.cycleStart === '2026-10-15');
    assert.equal(tarde.status, 'omitida');
    assert.match(tarde.reason, /hace 1 día: las facturas automáticas solo se emiten el mismo día del corte/);
    const mas = deRiccardo(await plan('2026-10-19')).find(i => i.cycleStart === '2026-10-15');
    assert.match(mas.reason, /hace 4 días/);
  });

  test('el horizonte muestra los próximos ciclos como programados, sin emitir', async () => {
    const p = deRiccardo(await plan('2026-10-15', 40));
    assert.deepEqual(p.map(i => [i.cycleStart, i.status]), [['2026-10-15', 'emitir'], ['2026-11-15', 'programada']]);
  });

  test('emitir crea las facturas (origin auto, vence el día de emisión, numeración seguida) y es idempotente', async () => {
    const [{ antes }] = await db`SELECT coalesce(max(number),0)::int AS antes FROM billing_invoices`;
    const r1 = await gen.runBillingGeneration(ownerId, '2026-10-15');
    assert.equal(r1.created.length, 2);
    assert.deepEqual(r1.created.map(c => c.code).sort(), [`FAC-${String(antes + 1).padStart(4, '0')}`, `FAC-${String(antes + 2).padStart(4, '0')}`]);
    const fam = (await api.get(`/api/billing/invoices?payerId=${riccardo}`)).datos.invoices.find(i => i.cycleStart === '2026-10-15');
    assert.deepEqual([fam.origin, fam.status, fam.total, fam.dueOn, fam.issuedOn], ['auto', 'pendiente', 900, '2026-10-15', '2026-10-15']);
    const r2 = await gen.runBillingGeneration(ownerId, '2026-10-15');
    assert.equal(r2.created.length, 0, 'una segunda corrida no duplica');
    const r3 = await gen.runBillingGeneration(ownerId, '2026-10-16');
    assert.equal(r3.created.length, 0);
  });

  test('si Iraida deja el plan, la factura siguiente baja a $600 (ends_on); y la casilla desmarcada la ignora', async () => {
    const lineas = (await api.get(`/api/clients/${riccardo}/billing-subscriptions`)).datos.lines;
    const lineaIraida = lineas.find(l => l.beneficiaryClientId === iraida);
    assert.equal((await api.patch(`/api/billing-subscriptions/${lineaIraida.id}`, { endsOn: '2026-11-14' })).estado, 200);
    const p = deRiccardo(await plan('2026-11-15')).find(i => i.cycleStart === '2026-11-15');
    assert.equal(p.total, 600);
    assert.deepEqual(p.lines.map(l => l.beneficiaryName).sort(), ['Ernesto', 'Riccardo']);
    const lineaErnesto = lineas.find(l => l.beneficiaryClientId === ernesto);
    assert.equal((await api.patch(`/api/billing-subscriptions/${lineaErnesto.id}`, { autoGenerate: false })).estado, 200);
    const q = deRiccardo(await plan('2026-11-15')).find(i => i.cycleStart === '2026-11-15');
    assert.equal(q.total, 450);
    assert.deepEqual(q.lines.map(l => l.beneficiaryName), ['Riccardo']);
  });
});

describe('casos especiales', () => {
  test('sin factura previa no se emite: "sin referencia" (D-15)', async () => {
    await linea(sandy, sandy, 'monthly', 300);
    const s = (await plan('2026-10-01')).find(i => i.payerId === sandy);
    assert.equal(s.status, 'sin_referencia');
    assert.equal(s.lines.length, 0);
    assert.equal((await gen.runBillingGeneration(ownerId, '2026-10-01')).created.filter(c => c.payerName === 'Sandy').length, 0);
  });

  test('una persona en pausa o inactiva no se factura', async () => {
    await linea(inactivo, inactivo, 'monthly', 99);
    await referencia(inactivo, 'mensual', '2026-09-20', '2026-10-20', [[inactivo, 99, 'Mensualidad']]);
    await db`UPDATE clients SET status = 'paused' WHERE id = ${inactivo}`;
    assert.equal((await plan('2026-10-20')).filter(i => i.payerId === inactivo).length, 0);
    await db`UPDATE clients SET status = 'active' WHERE id = ${inactivo}`;
    assert.equal((await plan('2026-10-20')).find(i => i.payerId === inactivo).status, 'emitir');
  });

  test('paquete de 35 días (Sara Djamous): el ciclo siguiente empieza donde terminó el anterior', async () => {
    await linea(sara, sara, 'package', 420, { cycleDays: 35, sessionsReference: 12 });
    await referencia(sara, 'paquete', '2026-09-15', '2026-10-20', [[sara, 420, 'Paquete 12 sesiones']]);
    const s = (await plan('2026-10-20')).find(i => i.payerId === sara);
    assert.deepEqual([s.status, s.cycleStart, s.cycleEnd, s.total], ['emitir', '2026-10-20', '2026-11-24', 420]);
    const siguiente = (await plan('2026-10-20', 40)).filter(i => i.payerId === sara);
    assert.deepEqual(siguiente.map(i => i.cycleStart), ['2026-10-20', '2026-11-24'], 'cada ciclo de 35 días, no un día fijo del mes');
  });
});

describe('crédito (Julio): postpago por clases cobrables', () => {
  before(async () => {
    await linea(julio, julio, 'credit', 25);
    await referencia(julio, 'credito', '2026-08-31', '2026-09-30', [[julio, 250, 'Sesiones a crédito']]);
    const sesion = (fecha, status = 'completed', extra = {}) => db`
      INSERT INTO sessions (client_id, starts_at, status, cancellation_kind, cancelled_by, credit_charge)
      VALUES (${julio}, ${fecha}::timestamptz, ${status}, ${extra.kind ?? null}, ${extra.by ?? null}, ${extra.cargo ?? false})`;
    await sesion('2026-09-30T10:00:00-05:00');                        // del ciclo ANTERIOR (cierra el 30-09): no cuenta
    await sesion('2026-10-02T10:00:00-05:00'); await sesion('2026-10-09T10:00:00-05:00'); await sesion('2026-10-16T10:00:00-05:00');
    await sesion('2026-10-23T10:00:00-05:00', 'cancelled', { kind: 'not_rescheduled', by: 'client', cargo: true });    // cancelación cobrable: cuenta
    await sesion('2026-10-26T10:00:00-05:00', 'cancelled', { kind: 'not_rescheduled', by: 'client', cargo: false });   // cancelación NO cobrable: no cuenta
    await sesion('2026-10-27T10:00:00-05:00', 'no_show');                                                                // no_show: no cobra
    await sesion('2026-10-31T09:00:00-05:00');                         // el día de corte pertenece al ciclo que termina: cuenta
    await sesion('2026-11-02T10:00:00-05:00');                         // del ciclo siguiente: no cuenta
  });

  test('a crédito se emite el ÚLTIMO DÍA del mes (31-10), pero solo desde las 21:00; antes está programada y al día siguiente ya no sale sola', async () => {
    assert.equal((await plan('2026-10-30', 5, 22)).find(i => i.payerId === julio).status, 'programada', 'el día antes no');
    const temprano = (await plan('2026-10-31', 0, 20)).find(i => i.payerId === julio);
    assert.equal(temprano.status, 'programada');
    assert.match(temprano.reason, /Se emite hoy desde las 21:00/);
    // Proyección: antes de la hora, con el ciclo en curso, el plan muestra lo que lleva hasta hoy (no se emite)
    assert.deepEqual([temprano.lines[0].quantity, temprano.total], [5, 125], 'proyección con lo marcado hasta hoy: 5 clases a $25');
    const mitad = (await plan('2026-10-20', 20)).find(i => i.payerId === julio);
    assert.deepEqual([mitad.status, mitad.total], ['programada', 125]);
    assert.match(mitad.reason, /Proyección con lo marcado hasta hoy: 5 clases\. El importe final se confirma el 31-10-2026 desde las 21:00/);
    assert.equal((await gen.runBillingGeneration(ownerId, '2026-10-20', 20)).created.filter(c => c.payerName === 'Julio').length, 0, 'una proyección nunca se emite');
    assert.equal((await plan('2026-10-31', 0, 21)).find(i => i.payerId === julio).status, 'emitir');
    assert.equal((await plan('2026-10-31', 0, 23)).find(i => i.payerId === julio).status, 'emitir');
    const tarde = (await plan('2026-11-01', 0, 1)).find(i => i.payerId === julio);
    assert.equal(tarde.status, 'omitida', 'a las 01:00 del 01-11 ya no sale sola');
    assert.match(tarde.reason, /hace 1 día/);
  });

  test('cobra 5 clases a $25 = $125 (3 impartidas + 1 cancelación cobrable + la del día de corte); vence al cierre del ciclo', async () => {
    const j = (await plan('2026-10-31', 0, 21)).find(i => i.payerId === julio);
    assert.deepEqual([j.cycleStart, j.cycleEnd, j.issuedOn, j.dueOn], ['2026-09-30', '2026-10-31', '2026-10-31', '2026-10-31']);
    assert.deepEqual([j.lines[0].quantity, j.lines[0].unitAmount, j.total], [5, 25, 125]);
    const antes = await gen.runBillingGeneration(ownerId, '2026-10-31', 20);
    assert.equal(antes.created.filter(c => c.payerName === 'Julio').length, 0, 'a las 20:00 todavía no');
    const r = await gen.runBillingGeneration(ownerId, '2026-10-31', 21);
    assert.equal(r.created.filter(c => c.payerName === 'Julio').length, 1);
    const fac = (await api.get(`/api/billing/invoices?payerId=${julio}`)).datos.invoices.find(i => i.cycleEnd === '2026-10-31');
    assert.deepEqual([fac.kind, fac.total, fac.origin], ['credito', 125, 'auto']);
  });

  test('el ciclo siguiente cobra su única clase ($25) y, sin clases cobrables, no se genera factura ("sin cargo")', async () => {
    const dic = (await plan('2026-11-30', 0, 21)).find(i => i.payerId === julio);
    assert.deepEqual([dic.status, dic.cycleStart, dic.cycleEnd, dic.total], ['emitir', '2026-10-31', '2026-11-30', 25], 'la clase del 02-11 es de este ciclo');
    assert.equal((await gen.runBillingGeneration(ownerId, '2026-11-30', 21)).created.filter(c => c.payerName === 'Julio').length, 1);
    const ene = (await plan('2026-12-31', 0, 21)).find(i => i.payerId === julio);
    assert.deepEqual([ene.status, ene.total], ['sin_cargo', 0]);
    assert.equal((await gen.runBillingGeneration(ownerId, '2026-12-31', 21)).created.filter(c => c.payerName === 'Julio').length, 0);
  });
});

describe('rutas y estado operativo', () => {
  test('con el generador viejo activo, el generador nuevo NO escribe (409) pero el plan se puede consultar', async () => {
    const run = await api.post('/api/billing/generation/run', {});
    assert.equal(run.estado, 409);
    assert.match(run.datos.error, /no está activo \(estado legacy\)/);
    const p = await api.get('/api/billing/generation/plan?horizon=35');
    assert.equal(p.estado, 200);
    assert.equal(p.datos.engine.state, 'legacy');
    assert.ok(Array.isArray(p.datos.plan));
    assert.ok(typeof p.datos.summary.noReference === 'number');
    assert.equal((await cliente(servidor.base).get('/api/billing/generation/plan')).estado, 401);
  });

  test('la lista de comprobación del corte marca lo que falta y lo que ya está', async () => {
    const [pend] = await db`INSERT INTO invoices (client_id, concept, amount, due_on, status, source_system) VALUES (${sandy}, 'Mensualidad', 300, '2026-10-01', 'pending', NULL) RETURNING id`;
    const solo = await nuevoCliente('Sin plan');
    await db`UPDATE clients SET billing_model = 'monthly', standard_price = 200 WHERE id = ${solo}`;
    const r = await api.get('/api/billing/cutover/readiness');
    assert.equal(r.estado, 200);
    const por = k => r.datos.checks.find(c => c.key === k);
    assert.equal(por('import').status, 'fail', 'sin carga aplicada no está listo');
    assert.equal(por('plans').status, 'fail');
    assert.ok(por('plans').items.some(i => i.name === 'Sin plan'));
    assert.equal(por('reference').status, 'fail');
    assert.ok(por('reference').items.some(i => i.payer === 'Sandy'));
    assert.equal(por('legacy-pending').status, 'warn');
    assert.ok(por('legacy-pending').items.some(i => i.client === 'Sandy' && i.amount === 300));
    assert.equal(r.datos.ready, false);
    await db`DELETE FROM invoices WHERE id = ${pend.id}`;
  });
});
