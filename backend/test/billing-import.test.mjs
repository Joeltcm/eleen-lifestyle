// Etapa 1B-4: cargador de la carga inicial (vista previa, aprobación, aplicación, reversión).
//
// Se siembran datos "viejos" sintéticos (tablas invoices / invoice_payments / payment_allocations)
// que reproducen los casos reales del inventario C-046: Eduardo con DOS cobros viejos de $175 (UN
// cobro de $350), Riccardo con una cobertura vieja distinta de lo declarado, Julieta con periodo mal
// etiquetado, Sandy con factura de agosto, etc. Fechas literales: nada depende del reloj.
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const NOMBRES = ['Sandy Asis', 'Sally Dayan Safdi', 'Riccardo Francolini', 'Iraida de Francolini', 'Ernesto de Diego', 'Eduardo Díaz', 'Beatris Díaz',
  'Julieta Galindo', 'Juan de Diego padre', 'Gila Falic', 'Julio Alvarez', 'Michelle Behar', 'Milo Asís', 'Sara Djamous', 'Susie Asís', 'Reina Yohoros', 'Sara Hidrie'];

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
  for (const nombre of NOMBRES) id[nombre] = (await db`INSERT INTO clients (owner_id, full_name, billing_cutoff_day) VALUES (${ownerId}, ${nombre}, 15) RETURNING id`)[0].id;

  const factura = async (client, billedFor, concept, amount, dueOn, status) =>
    (await db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status, source_system) VALUES (${client}, ${billedFor}, ${concept}, ${amount}, ${dueOn}, ${status}, 'eileen') RETURNING id`)[0].id;
  const cobro = async (client, amount, paidOn, method, invoices) => {
    const [p] = await db`INSERT INTO invoice_payments (client_id, amount, paid_on, method, source_system, external_id) VALUES (${client}, ${amount}, ${paidOn}, ${method}, 'eileen', ${`t-${Math.random()}`}) RETURNING id`;
    for (const [inv, monto] of invoices) await db`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${p.id}, ${inv}, ${monto})`;
    return p.id;
  };
  const c = nombre => id[nombre];
  // Sandy y Sally: septiembre pagado, octubre pendiente
  let f = await factura(c('Sandy Asis'), c('Sandy Asis'), 'Mensualidad', 300, '2026-09-01', 'confirmed'); await cobro(c('Sandy Asis'), 300, '2026-09-01', 'Yappy', [[f, 300]]);
  await factura(c('Sandy Asis'), c('Sandy Asis'), 'Mensualidad', 300, '2026-10-01', 'pending');
  f = await factura(c('Sally Dayan Safdi'), c('Sally Dayan Safdi'), 'Mensualidad', 400, '2026-09-01', 'confirmed'); await cobro(c('Sally Dayan Safdi'), 400, '2026-09-02', 'Transferencia bancaria', [[f, 400]]);
  await factura(c('Sally Dayan Safdi'), c('Sally Dayan Safdi'), 'Mensualidad', 400, '2026-10-01', 'pending');
  // Riccardo: una factura vieja de $900 (la cobertura vieja repartía distinto; la carga usa lo declarado)
  f = await factura(c('Riccardo Francolini'), c('Riccardo Francolini'), 'Mensualidad', 900, '2026-09-15', 'confirmed'); await cobro(c('Riccardo Francolini'), 900, '2026-09-16', 'Yappy', [[f, 900]]);
  await db`INSERT INTO invoice_coverage (invoice_id, client_id, amount, billing_period) VALUES (${f}, ${c('Ernesto de Diego')}, 211.76, '2026-09-01')`;
  // Ernesto: su plan propio
  f = await factura(c('Ernesto de Diego'), c('Ernesto de Diego'), 'Mensualidad', 120, '2026-09-15', 'confirmed'); await cobro(c('Ernesto de Diego'), 120, '2026-09-17', 'Yappy', [[f, 120]]);
  // Eduardo y Beatris: DOS facturas viejas y DOS cobros viejos de $175 (el reparto interno del sistema viejo)
  const e1 = await factura(c('Eduardo Díaz'), c('Eduardo Díaz'), 'Mensualidad', 175, '2026-09-28', 'confirmed');
  const e2 = await factura(c('Eduardo Díaz'), c('Beatris Díaz'), 'Mensualidad', 175, '2026-09-28', 'confirmed');
  await cobro(c('Eduardo Díaz'), 175, '2026-09-28', 'Transferencia bancaria', [[e1, 175]]); await cobro(c('Eduardo Díaz'), 175, '2026-09-28', 'Transferencia bancaria', [[e2, 175]]);
  // Julieta: factura vieja mal etiquetada (vence 15-10) pagada un día tarde
  f = await factura(c('Julieta Galindo'), c('Julieta Galindo'), 'Mensualidad', 300, '2026-10-15', 'confirmed'); await cobro(c('Julieta Galindo'), 300, '2026-09-26', 'Yappy', [[f, 300]]);
  // Gila (J-058): el cobro NO está registrado; su factura vieja ya no figura como pendiente (confirmada sin cobro)
  await factura(c('Gila Falic'), c('Gila Falic'), 'Mensualidad', 240, '2026-09-28', 'confirmed');
  // Pendientes: Julio (crédito, monto vivo)
  await factura(c('Julio Alvarez'), c('Julio Alvarez'), 'Sesiones a crédito', 275, '2026-09-30', 'pending');
  // Clases sueltas (J-056): una factura vieja confirmada y un cobro por cada clase
  const clase = async (nombre, monto, fecha, metodo = 'Yappy') => { const inv = await factura(c(nombre), c(nombre), 'Sesión individual', monto, fecha, 'confirmed'); await cobro(c(nombre), monto, fecha, metodo, [[inv, monto]]); };
  await clase('Susie Asís', 35, '2026-09-05'); await clase('Susie Asís', 35, '2026-09-12');
  for (const [monto, fecha] of [[90, '2026-09-07'], [60, '2026-09-17'], [90, '2026-09-23'], [20, '2026-09-30']]) await clase('Reina Yohoros', monto, fecha);
  await clase('Sara Hidrie', 30, '2026-09-08', 'Efectivo'); await clase('Sara Hidrie', 30, '2026-09-15', 'Efectivo'); await clase('Sara Hidrie', 30, '2026-09-22', 'Efectivo');
  // Dos clases sueltas registradas con concepto de paquete: Joel confirmó que SON clases sueltas (J-058)
  { const inv = await factura(c('Susie Asís'), c('Susie Asís'), 'Paquete 1 clase', 30, '2026-09-13', 'confirmed'); await cobro(c('Susie Asís'), 30, '2026-09-13', 'Yappy', [[inv, 30]]); }
  { const inv = await factura(c('Sara Hidrie'), c('Sara Hidrie'), 'Paquete de clase', 40, '2026-09-14', 'confirmed'); await cobro(c('Sara Hidrie'), 40, '2026-09-14', 'Efectivo', [[inv, 40]]); }
  // Excluidos de la carga: tienen datos viejos pero no deben cargarse
  f = await factura(c('Michelle Behar'), c('Michelle Behar'), 'Mensualidad', 280, '2026-10-15', 'confirmed'); await cobro(c('Michelle Behar'), 280, '2026-09-15', 'Yappy', [[f, 280]]);
  await cobro(c('Milo Asís'), 120, '2026-08-28', 'Yappy', []);
  return { api, db, ownerId, id, factura, cobro };
}

const snapshotLegacy = async db => (await db`SELECT
  (SELECT count(*) FROM invoices)::int AS invoices, (SELECT coalesce(sum(amount),0) FROM invoices)::numeric AS invoices_total,
  (SELECT count(*) FROM invoice_payments)::int AS payments, (SELECT coalesce(sum(amount),0) FROM invoice_payments)::numeric AS payments_total,
  (SELECT count(*) FROM payment_allocations)::int AS allocations, (SELECT count(*) FROM invoice_coverage)::int AS coverage,
  (SELECT count(*) FROM session_packages)::int AS packages, (SELECT string_agg(status, ',' ORDER BY id) FROM invoices) AS statuses`)[0];

let A; let B; let C; let servidorA; let servidorB; let servidorC;

before(async () => {
  servidorA = await levantar();                                                    // generador viejo ACTIVO (por defecto)
  servidorB = await levantarCon({ LEGACY_BILLING_GENERATION: 'off' });             // generador viejo APAGADO (mantenimiento)
  servidorC = await levantarCon({ LEGACY_BILLING_GENERATION: 'off' });
  A = await preparar(servidorA); B = await preparar(servidorB); C = await preparar(servidorC);
}, { timeout: 180_000 });

after(async () => {
  await A?.db.end({ timeout: 1 }).catch(() => {}); await B?.db.end({ timeout: 1 }).catch(() => {}); await C?.db.end({ timeout: 1 }).catch(() => {});
  await servidorA?.parar(); await servidorB?.parar(); await servidorC?.parar();
});

const preview = async ctx => (await ctx.api.post('/api/billing/imports/preview', {})).datos;
const porClave = (p, key) => p.items.find(i => i.key === key);

describe('vista previa (solo lectura)', () => {
  test('con la lista aprobada propone 23 facturas por $4.475, 17 cobros por $2.860 y $1.615 pendientes', async () => {
    const antes = await snapshotLegacy(A.db);
    const r = await A.api.post('/api/billing/imports/preview', {});
    assert.equal(r.estado, 201);
    const p = r.datos;
    assert.equal(p.status, 'preview');
    assert.match(p.previewHash, /^[0-9a-f]{64}$/);
    assert.deepEqual([p.totals.invoices, p.totals.invoicesTotal, p.totals.payments, p.totals.paymentsTotal, p.totals.openBalance],
      [23, 4475, 17, 2860, 1615]);
    assert.deepEqual([p.totals.paid, p.totals.pending, p.totals.review, p.totals.excluded, p.totals.firstNumber, p.totals.lastNumber], [17, 6, 0, 1, 1, 23]);
    assert.deepEqual(await snapshotLegacy(A.db), antes, 'la vista previa no escribe en el sistema anterior');
    const [{ n }] = await A.db`SELECT (SELECT count(*) FROM billing_invoices)::int + (SELECT count(*) FROM billing_payments)::int AS n`;
    assert.equal(n, 0, 'la vista previa no crea facturas ni cobros');
  });

  test('Eduardo: dos cobros viejos de $175 se proponen como UN cobro de $350 a una factura de dos líneas', async () => {
    const e = porClave(await preview(A), 'eduardo-2026-09');
    assert.equal(e.decision, 'incluir');
    assert.deepEqual(e.data.lines.map(l => l.amount), [175, 175]);
    assert.equal(e.data.payment.amount, 350);
    assert.equal(e.sourceIds.payments.length, 2, 'los dos cobros viejos quedan como evidencia');
    assert.equal(e.data.status, 'pagada');
  });

  test('Riccardo usa lo declarado (450/300/150), no la cobertura vieja de $211,76; Julieta conserva el ciclo 25-09', async () => {
    const p = await preview(A);
    const r = porClave(p, 'riccardo-2026-09');
    assert.deepEqual(r.data.lines.map(l => [l.beneficiary, l.amount]), [['Riccardo Francolini', 450], ['Iraida de Francolini', 300], ['Ernesto de Diego', 150]]);
    assert.equal(r.data.total, 900);
    const j = porClave(p, 'julieta-2026-09');
    assert.equal(j.data.cycleStart, '2026-09-25');
    assert.equal(j.data.payment.paidOn, '2026-09-26');
  });

  test('Julio toma el monto vivo de su factura vieja pendiente ($275) para revalidarlo', async () => {
    const j = porClave(await preview(A), 'julio-2026-09');
    assert.equal(j.decision, 'incluir');
    assert.equal(j.data.total, 275);
    assert.equal(j.data.legacyAmount, 275);
    assert.equal(j.data.kind, 'credito');
  });

  test('lo excluido se lista con su motivo y no se propone (Sara Djamous)', async () => {
    const p = await preview(A);
    const excluidos = p.items.filter(i => i.decision === 'excluir');
    assert.deepEqual(excluidos.map(i => i.key).sort(), ['sara-djamous']);
    assert.ok(excluidos.every(i => i.reasons[0].length > 10));
    assert.ok(!p.items.some(i => i.decision === 'incluir' && /sara-djamous/.test(i.key)));
    // Michelle y Milo (J-061) van ABIERTAS: factura sin cobro y con la nota de que se confirma el pago
    for (const [clave, total, inicio] of [['michelle-2026-09', 280, '2026-09-15'], ['milo-2026-09', 120, '2026-09-28']]) {
      const item = p.items.find(i => i.key === clave);
      assert.deepEqual([item.decision, item.data.status, item.data.payment, item.data.total, item.data.cycleStart], ['incluir', 'pendiente', null, total, inicio], clave);
      assert.match(item.data.note, /se confirma el pago/);
    }
  });

  test('sin evidencia en el sistema anterior, una entrada pasa a "revisar" y no se carga', async () => {
    await A.db`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM invoice_payments WHERE client_id = ${A.id['Sally Dayan Safdi']})`;
    const [borrado] = await A.db`DELETE FROM invoice_payments WHERE client_id = ${A.id['Sally Dayan Safdi']} RETURNING amount, paid_on::text AS paid_on, method`;
    try {
      const p = await preview(A);
      const s = porClave(p, 'sally-2026-09');
      assert.equal(s.decision, 'revisar');
      assert.match(s.reasons[0], /No hay un cobro de Sally Dayan Safdi del 2026-09-02/);
      assert.equal(p.totals.invoices, 22);
      assert.equal(p.totals.review, 1);
      assert.equal(p.totals.lastNumber, 22, 'los números proyectados se recorren sin huecos');
    } finally {
      const [pay] = await A.db`INSERT INTO invoice_payments (client_id, amount, paid_on, method, source_system, external_id) VALUES (${A.id['Sally Dayan Safdi']}, ${borrado.amount}, ${borrado.paid_on}, ${borrado.method}, 'eileen', 'restaurado') RETURNING id`;
      const [inv] = await A.db`SELECT id FROM invoices WHERE client_id = ${A.id['Sally Dayan Safdi']} AND status = 'confirmed'`;
      await A.db`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${pay.id}, ${inv.id}, 400)`;
    }
  });

  test('un monto distinto del esperado o un cliente que no existe también pasan a "revisar"', async () => {
    const manifest = { name: 'prueba', exclusions: [], entries: [
      { key: 'mal-monto', label: 'Sandy octubre con monto distinto', payer: 'Sandy Asis', kind: 'mensual', cycleStart: '2026-10-01', cycleEnd: '2026-11-01', lines: [{ beneficiary: 'Sandy Asis', amount: 999 }] },
      { key: 'sin-cliente', label: 'Cliente inexistente', payer: 'Nadie Conocido', kind: 'mensual', cycleStart: '2026-09-28', cycleEnd: '2026-10-28', lines: [{ beneficiary: 'Nadie Conocido', amount: 10 }] }
    ] };
    const r = await A.api.post('/api/billing/imports/preview', { manifest });
    assert.equal(r.estado, 201);
    assert.match(r.datos.items[0].reasons[0], /no coincide: hay 300\.00 y se esperaban 999\.00/);
    assert.match(r.datos.items[1].reasons.join('|'), /No se encontró al cliente "Nadie Conocido"/);
    assert.equal(r.datos.totals.invoices, 0);
  });

  test('una lista inválida se rechaza (400) y exige sesión', async () => {
    assert.equal((await A.api.post('/api/billing/imports/preview', { manifest: { name: 'x', entries: [], exclusions: [] } })).estado, 400);
    assert.equal((await cliente(servidorA.base).post('/api/billing/imports/preview', {})).estado, 401);
  });

  test('el hash es estable entre dos vistas previas iguales y la lista aprobada se puede consultar', async () => {
    const x = await preview(A); const y = await preview(A);
    assert.equal(x.previewHash, y.previewHash);
    const m = await A.api.get('/api/billing/imports/default-manifest');
    assert.equal(m.estado, 200);
    assert.equal(m.datos.entries.length, 12);
  });
});

describe('nombres de clientes: coincidencia robusta y sin adivinar', () => {
  const renombrar = (nuevo) => A.db`UPDATE clients SET full_name = ${nuevo} WHERE id = ${A.id['Sally Dayan Safdi']}`;

  test('acentos, mayúsculas y espacios (incluido el espacio duro) no impiden la coincidencia', async () => {
    await renombrar('  SALLY\u00a0 Dayán   safdi ');
    try {
      const p = await preview(A);
      assert.equal(porClave(p, 'sally-2026-09').decision, 'incluir');
      assert.equal(porClave(p, 'sally-2026-10').decision, 'incluir');
      assert.equal(p.totals.invoices, 23);
    } finally { await renombrar('Sally Dayan Safdi'); }
  });

  test('un nombre parecido NO se acepta: se sugiere, una sola vez por nombre, y la entrada queda por revisar', async () => {
    await renombrar('Sally Safdie');
    try {
      const p = await preview(A);
      const s = porClave(p, 'sally-2026-09');
      assert.equal(s.decision, 'revisar');
      assert.equal(s.reasons.length, 1, 'el mismo nombre no se repite como payer y beneficiario');
      assert.match(s.reasons[0], /No se encontró al cliente "Sally Dayan Safdi"\. ¿Será "Sally Safdie"\?/);
      assert.equal(p.totals.invoices, 21);
      assert.equal(p.totals.review, 2);
    } finally { await renombrar('Sally Dayan Safdi'); }
  });

  test('dos clientes con el mismo nombre normalizado se rechazan por ambiguos', async () => {
    const [{ id: gemelo }] = await A.db`INSERT INTO clients (owner_id, full_name) VALUES (${A.ownerId}, 'GILA  falic') RETURNING id`;
    try {
      const g = porClave(await preview(A), 'gila-2026-09');
      assert.equal(g.decision, 'revisar');
      assert.match(g.reasons[0], /Hay más de un cliente llamado "Gila Falic"/);
    } finally { await A.db`DELETE FROM clients WHERE id = ${gemelo}`; }
  });
});

describe('clases sueltas de Susie, Reina y Sara Hidrie (J-056)', () => {
  test('cada clase pagada es UNA factura clase_suelta y UN cobro, con fecha, monto y método del cobro viejo', async () => {
    const p = await preview(A);
    const reina = p.items.filter(i => i.key.startsWith('reina:'));
    assert.equal(reina.length, 4);
    assert.deepEqual(reina.map(i => [i.data.payment.paidOn, i.data.total, i.data.payment.method]),
      [['2026-09-07', 90, 'Yappy'], ['2026-09-17', 60, 'Yappy'], ['2026-09-23', 90, 'Yappy'], ['2026-09-30', 20, 'Yappy']]);
    assert.ok(reina.every(i => i.decision === 'incluir' && i.data.kind === 'clase_suelta' && i.data.cycleStart === i.data.cycleEnd && i.data.status === 'pagada'));
    const susie = p.items.filter(i => i.key.startsWith('susie:'));
    assert.equal(susie.length, 3);
    assert.ok(susie.every(i => i.decision === 'incluir'), 'la de concepto paquete (13-09, $30) se acepta: Joel confirmó que es clase suelta');
    const sara = p.items.filter(i => i.key.startsWith('sara-hidrie:'));
    assert.equal(sara.length, 4);
    assert.ok(sara.every(i => i.decision === 'incluir' && i.data.payment.method === 'Efectivo'));
    assert.equal(reina.reduce((n, i) => n + i.data.total, 0), 260);
  });

  test('las que no encajan (pendiente, sin cobro, con dos cobros o de mensualidad) quedan por revisar', async () => {
    const reina = A.id['Reina Yohoros'];
    const [pendiente] = await A.db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status, source_system) VALUES (${reina}, ${reina}, 'Sesión individual', 50, '2026-09-25', 'pending', 'eileen') RETURNING id`;
    const [sinCobro] = await A.db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status, source_system) VALUES (${reina}, ${reina}, 'Sesión individual', 45, '2026-09-26', 'confirmed', 'eileen') RETURNING id`;
    const [mensual] = await A.db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status, source_system) VALUES (${reina}, ${reina}, 'Mensualidad', 80, '2026-09-27', 'confirmed', 'eileen') RETURNING id`;
    try {
      const p = await preview(A);
      const por = id => p.items.find(i => i.key === `reina:${id}`);
      assert.match(por(pendiente.id).reasons[0], /pendiente de cobro/);
      assert.match(por(sinCobro.id).reasons.join('|'), /No tiene un cobro aplicado/);
      assert.match(por(mensual.id).reasons.join('|'), /No parece una clase suelta/);
      assert.ok([pendiente, sinCobro, mensual].every(r => por(r.id).decision === 'revisar'));
      assert.equal(p.totals.invoices, 23, 'las dudosas no suman a lo que se carga');
      assert.equal(p.totals.review, 3);
    } finally { await A.db`DELETE FROM invoices WHERE id IN (${pendiente.id}, ${sinCobro.id}, ${mensual.id})`; }
  });

  test('una clase suelta registrada con concepto de paquete queda por revisar y Joel puede aceptarla por fecha y monto', async () => {
    const susie = A.id['Susie Asís'];
    const [inv] = await A.db`INSERT INTO invoices (client_id, billed_for_client_id, concept, amount, due_on, status, source_system) VALUES (${susie}, ${susie}, 'Paquete 1 clase', 33, '2026-09-18', 'confirmed', 'eileen') RETURNING id`;
    const [pay] = await A.db`INSERT INTO invoice_payments (client_id, amount, paid_on, method, source_system, external_id) VALUES (${susie}, 33, '2026-09-18', 'Yappy', 'eileen', 'susie-paquete') RETURNING id`;
    await A.db`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${pay.id}, ${inv.id}, 33)`;
    try {
      const sin = (await preview(A)).items.find(i => i.key === `susie:${inv.id}`);
      assert.equal(sin.decision, 'revisar');
      assert.match(sin.reasons[0], /No parece una clase suelta/);
      const manifest = { name: 'prueba', exclusions: [], entries: [{ key: 'sandy-oct', label: 'Sandy octubre', payer: 'Sandy Asis', kind: 'mensual', cycleStart: '2026-10-01', cycleEnd: '2026-11-01', lines: [{ beneficiary: 'Sandy Asis', amount: 300 }] }],
        singleClasses: [{ key: 'susie', label: 'Susie', client: 'Susie Asís', since: '2026-09-01', accept: [{ date: '2026-09-18', amount: 33 }] }] };
      const r = await A.api.post('/api/billing/imports/preview', { manifest });
      const aceptada = r.datos.items.find(i => i.key === `susie:${inv.id}`);
      assert.equal(aceptada.decision, 'incluir');
      assert.deepEqual([aceptada.data.kind, aceptada.data.total, aceptada.data.payment.paidOn], ['clase_suelta', 33, '2026-09-18']);
    } finally {
      await A.db`DELETE FROM payment_allocations WHERE payment_id = ${pay.id}`; await A.db`DELETE FROM invoice_payments WHERE id = ${pay.id}`; await A.db`DELETE FROM invoices WHERE id = ${inv.id}`;
    }
  });

  test('si el cliente no existe se avisa una vez y las demás personas siguen adelante', async () => {
    const manifest = { name: 'prueba', entries: [], exclusions: [], singleClasses: [{ key: 'nadie', label: 'Nadie (clases sueltas)', client: 'Persona Inexistente', since: '2026-09-01' },
      { key: 'reina', label: 'Reina (clases sueltas)', client: 'Reina Yohoros', since: '2026-09-01' }] };
    // un manifiesto sin entradas mensuales no pasa la validación (mínimo 1): se prueba con una entrada válida
    manifest.entries = [{ key: 'sandy-oct', label: 'Sandy octubre', payer: 'Sandy Asis', kind: 'mensual', cycleStart: '2026-10-01', cycleEnd: '2026-11-01', lines: [{ beneficiary: 'Sandy Asis', amount: 300 }] }];
    const r = await A.api.post('/api/billing/imports/preview', { manifest });
    assert.equal(r.estado, 201);
    const sinCliente = r.datos.items.find(i => i.key === 'nadie:cliente');
    assert.equal(sinCliente.decision, 'revisar');
    assert.match(sinCliente.reasons[0], /No se encontró al cliente "Persona Inexistente"/);
    assert.equal(r.datos.items.filter(i => i.key.startsWith('reina:') && i.decision === 'incluir').length, 4);
  });
});

describe('método y fecha del cobro: se toman del sistema anterior o se validan contra él', () => {
  // La lista aprobada ya no declara cobro de Gila (J-058); estas pruebas usan una lista propia con paidOn/method "legacy".
  const gilaConCobro = { name: 'prueba', exclusions: [], entries: [{ key: 'gila-2026-09', label: 'Gila con cobro', payer: 'Gila Falic', kind: 'mensual', cycleStart: '2026-09-28', cycleEnd: '2026-10-28',
    lines: [{ beneficiary: 'Gila Falic', amount: 240 }], payment: { paidOn: 'legacy', method: 'legacy', amount: 240 } }] };
  const verGila = async () => (await A.api.post('/api/billing/imports/preview', { manifest: gilaConCobro })).datos.items[0];
  const registrarCobroGila = async (monto = 240, fecha = '2026-10-01', metodo = 'Yappy') => {
    const gila = A.id['Gila Falic']; const [inv] = await A.db`SELECT id FROM invoices WHERE client_id = ${gila}`;
    const [pay] = await A.db`INSERT INTO invoice_payments (client_id, amount, paid_on, method, source_system, external_id) VALUES (${gila}, ${monto}, ${fecha}, ${metodo}, 'eileen', ${`g-${Math.random()}`}) RETURNING id`;
    await A.db`INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (${pay.id}, ${inv.id}, ${monto})`; return pay.id;
  };
  const limpiarGila = async () => { await A.db`DELETE FROM payment_allocations WHERE payment_id IN (SELECT id FROM invoice_payments WHERE client_id = ${A.id['Gila Falic']})`; await A.db`DELETE FROM invoice_payments WHERE client_id = ${A.id['Gila Falic']}`; };

  test('Gila en la lista aprobada: queda ABIERTA (pendiente) sin respaldo del sistema anterior, por decisión de Joel', async () => {
    const g = porClave(await preview(A), 'gila-2026-09');
    assert.equal(g.decision, 'incluir');
    assert.equal(g.data.status, 'pendiente');
    assert.equal(g.data.payment, null);
    assert.equal(g.data.total, 240);
    assert.match(g.data.note, /se confirma con Eileen/);
    assert.deepEqual([g.sourceIds.payments.length, g.sourceIds.invoices.length], [0, 0]);
  });

  test('con "paidOn legacy": se toma la fecha y el método del cobro viejo aplicado a su factura de ese ciclo', async () => {
    await registrarCobroGila();
    try {
      const g = await verGila();
      assert.equal(g.decision, 'incluir');
      assert.deepEqual([g.data.payment.paidOn, g.data.payment.method, g.data.status], ['2026-10-01', 'Yappy', 'pagada']);
    } finally { await limpiarGila(); }
  });

  test('si pagó el 30-09 se carga con el 30-09', async () => {
    await registrarCobroGila(240, '2026-09-30');
    try { assert.equal((await verGila()).data.payment.paidOn, '2026-09-30'); } finally { await limpiarGila(); }
  });

  test('si los cobros están en varias fechas, no se adivina cuál: pasa a "revisar"', async () => {
    await registrarCobroGila(140, '2026-10-01'); await registrarCobroGila(100, '2026-09-29');
    try {
      const g = await verGila();
      assert.equal(g.decision, 'revisar');
      assert.match(g.reasons.join('|'), /varias fechas \(2026-09-29, 2026-10-01\)/);
    } finally { await limpiarGila(); }
  });

  test('sin ningún cobro se da UNA sola razón clara (no "sin método" encima)', async () => {
    const g = await verGila();
    assert.equal(g.decision, 'revisar');
    assert.deepEqual(g.reasons, ['No hay un cobro de Gila Falic para ese ciclo en el sistema anterior']);
  });

  test('un cobro viejo sin método no se puede tomar como "legacy"', async () => {
    const id = await registrarCobroGila(); await A.db`UPDATE invoice_payments SET method = NULL WHERE id = ${id}`;
    try { const g = await verGila(); assert.equal(g.decision, 'revisar'); assert.match(g.reasons[0], /no trae método/); } finally { await limpiarGila(); }
  });

  test('si la lista dice un método y el sistema anterior otro, la entrada pasa a "revisar"', async () => {
    const manifest = { name: 'prueba', exclusions: [], entries: [
      { key: 'metodo-distinto', label: 'Sandy con método equivocado', payer: 'Sandy Asis', kind: 'mensual', cycleStart: '2026-09-01', cycleEnd: '2026-10-01',
        lines: [{ beneficiary: 'Sandy Asis', amount: 300 }], payment: { paidOn: '2026-09-01', method: 'Efectivo', amount: 300 } }
    ] };
    const r = await A.api.post('/api/billing/imports/preview', { manifest });
    assert.equal(r.datos.items[0].decision, 'revisar');
    assert.match(r.datos.items[0].reasons[0], /El método del cobro no coincide: la lista dice Efectivo y el sistema anterior Yappy/);
  });
});

describe('aprobar y aplicar: las puertas', () => {
  test('aprobar exige el hash exacto; un lote anterior queda reemplazado', async () => {
    const viejo = await preview(A); const nuevo = await preview(A);
    assert.equal((await A.api.get(`/api/billing/imports/${viejo.id}`)).datos.status, 'superseded');
    assert.equal((await A.api.post(`/api/billing/imports/${nuevo.id}/approve`, { previewHash: '0'.repeat(64) })).estado, 409);
    assert.equal((await A.api.post(`/api/billing/imports/${nuevo.id}/approve`, { previewHash: 'no-es-un-hash' })).estado, 400);
    assert.equal((await A.api.post(`/api/billing/imports/${viejo.id}/approve`, { previewHash: viejo.previewHash })).estado, 409);
    assert.equal((await A.api.post(`/api/billing/imports/${nuevo.id}/approve`, { previewHash: nuevo.previewHash })).estado, 200);
  });

  test('con el generador viejo ACTIVO, aplicar se rechaza y no crea nada', async () => {
    const p = await preview(A);
    await A.api.post(`/api/billing/imports/${p.id}/approve`, { previewHash: p.previewHash });
    const r = await A.api.post(`/api/billing/imports/${p.id}/apply`, {});
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /LEGACY_BILLING_GENERATION=off/);
    const [{ n }] = await A.db`SELECT count(*)::int AS n FROM billing_invoices`;
    assert.equal(n, 0);
  });

  test('un lote sin aprobar no se aplica', async () => {
    const p = await preview(B);
    const r = await B.api.post(`/api/billing/imports/${p.id}/apply`, {});
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /solo se aplica un lote aprobado/);
  });
});

describe('aplicar (generador viejo apagado)', () => {
  let lote;
  test('aplica la lista: 23 facturas numeradas 1..23, 17 cobros, estados correctos y el sistema viejo intacto', async () => {
    const antes = await snapshotLegacy(B.db);
    lote = await preview(B);
    assert.equal((await B.api.post(`/api/billing/imports/${lote.id}/approve`, { previewHash: lote.previewHash })).estado, 200);
    const r = await B.api.post(`/api/billing/imports/${lote.id}/apply`, {});
    assert.equal(r.estado, 200, JSON.stringify(r.datos));
    assert.equal(r.datos.created.length, 23);
    assert.deepEqual(r.datos.created.map(c => c.code), Array.from({ length: 23 }, (_, i) => `FAC-${String(i + 1).padStart(4, '0')}`));
    const f = await B.api.get('/api/billing/invoices?limit=50');
    assert.equal(f.datos.invoices.length, 23);
    assert.equal(f.datos.summary.total, 4475);
    assert.equal(f.datos.summary.balance, 1615);
    assert.deepEqual(f.datos.invoices.reduce((acc, i) => { acc[i.status] = (acc[i.status] ?? 0) + 1; return acc; }, {}), { pagada: 17, pendiente: 6 });
    assert.ok(f.datos.invoices.every(i => i.origin === 'carga_inicial'));
    const p = await B.api.get('/api/billing/payments?limit=50');
    assert.deepEqual([p.datos.payments.length, p.datos.summary.total, p.datos.summary.applied, p.datos.summary.available], [17, 2860, 2860, 0]);
    assert.deepEqual(await snapshotLegacy(B.db), antes, 'aplicar no modifica ninguna tabla del sistema anterior');
  });

  test('Gila quedó como factura ABIERTA de $240 con la nota de que se confirma con Eileen', async () => {
    const [g] = (await B.api.get('/api/billing/invoices?payerId=' + B.id['Gila Falic'])).datos.invoices;
    assert.deepEqual([g.status, g.total, g.paid, g.balance], ['pendiente', 240, 0, 240]);
    const d = (await B.api.get(`/api/billing/invoices/${g.id}`)).datos;
    assert.match(d.notes, /se confirma con Eileen/);
    assert.equal((await B.api.get('/api/billing/payments?payerId=' + B.id['Gila Falic'])).datos.payments.length, 0);
  });

  test('Eduardo quedó con UNA factura de dos líneas de $175 y UN cobro de $350 aplicado', async () => {
    const lista = (await B.api.get('/api/billing/invoices?payerId=' + B.id['Eduardo Díaz'])).datos.invoices;
    assert.equal(lista.length, 1);
    const d = (await B.api.get(`/api/billing/invoices/${lista[0].id}`)).datos;
    assert.deepEqual(d.lines.map(l => [l.beneficiaryName, l.amount]).sort(), [['Beatris Díaz', 175], ['Eduardo Díaz', 175]]);
    assert.equal(d.applications.length, 1);
    assert.equal(d.applications[0].amount, 350);
    assert.equal(d.status, 'pagada');
  });

  test('Sara Djamous (excluida) NO se cargó; Michelle y Milo quedaron como facturas ABIERTAS sin cobro (J-061)', async () => {
    assert.equal((await B.api.get(`/api/billing/invoices?payerId=${B.id['Sara Djamous']}`)).datos.invoices.length, 0);
    assert.equal((await B.api.get(`/api/billing/payments?payerId=${B.id['Sara Djamous']}`)).datos.payments.length, 0);
    for (const [nombre, total] of [['Michelle Behar', 280], ['Milo Asís', 120]]) {
      const [f] = (await B.api.get(`/api/billing/invoices?payerId=${B.id[nombre]}`)).datos.invoices;
      assert.deepEqual([f.status, f.total, f.paid, f.balance], ['pendiente', total, 0, total], nombre);
      assert.match((await B.api.get(`/api/billing/invoices/${f.id}`)).datos.notes, /se confirma el pago/);
      assert.equal((await B.api.get(`/api/billing/payments?payerId=${B.id[nombre]}`)).datos.payments.length, 0, nombre);
    }
  });

  test('es idempotente: una vista previa nueva marca todo como ya aplicado y aplicar crea cero filas', async () => {
    const p = await preview(B);
    assert.equal(p.totals.invoices, 0);
    assert.equal(p.totals.alreadyApplied, 23);
    assert.equal((await B.api.post(`/api/billing/imports/${p.id}/approve`, { previewHash: p.previewHash })).estado, 200);
    assert.equal((await B.api.post(`/api/billing/imports/${p.id}/apply`, {})).estado, 200);
    const [{ n, c }] = await B.db`SELECT (SELECT count(*) FROM billing_invoices)::int AS n, (SELECT last_number FROM billing_counters)::int AS c`;
    assert.deepEqual([n, c], [23, 23]);
  });

  test('un lote aplicado no se aplica otra vez', async () => {
    assert.equal((await B.api.post(`/api/billing/imports/${lote.id}/apply`, {})).estado, 409);
  });

  test('fuera de la reversión, la base sigue sin permitir borrar facturas ni cobros cargados', async () => {
    await assert.rejects(B.db`DELETE FROM billing_invoices WHERE source_system = 'legacy_import'`, /no se borra/);
    await assert.rejects(B.db`DELETE FROM billing_payments WHERE source_system = 'legacy_import'`, /no se borra/);
  });
});

describe('reversión del lote', () => {
  test('se bloquea si ya se emitió otra factura después de la carga', async () => {
    const lote = (await B.api.get('/api/billing/imports')).datos.batches.find(b => b.status === 'applied' && b.totals.invoices === 23);
    const manual = await B.api.post('/api/billing/invoices', { payerClientId: B.id['Michelle Behar'], kind: 'manual', issuedOn: '2026-10-01',
      lines: [{ beneficiaryClientId: B.id['Michelle Behar'], unitAmount: 280, description: 'Manual de Joel' }] });
    assert.equal(manual.datos.number, 24);
    const r = await B.api.post(`/api/billing/imports/${lote.id}/reverse`, { reason: 'Prueba' });
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /Ya se emitieron facturas después de la carga/);
    // se anula la manual para devolver el contador a su estado SIN reutilizar el número: sigue bloqueado
    await B.api.post(`/api/billing/invoices/${manual.datos.id}/void`, { reason: 'Prueba' });
    assert.equal((await B.api.post(`/api/billing/imports/${lote.id}/reverse`, { reason: 'Prueba' })).estado, 409);
  });
});

const aprobar = async (ctx, p) => (await ctx.api.post(`/api/billing/imports/${p.id}/approve`, { previewHash: p.previewHash })).estado;

describe('reversión y cambios de última hora (servidor aparte, generador viejo apagado)', () => {
  test('revertir un lote sin cambios posteriores borra sus filas, restaura el contador y deja el sistema viejo intacto', async () => {
    const antes = await snapshotLegacy(C.db);
    const p = await preview(C);
    assert.equal(await aprobar(C, p), 200);
    assert.equal((await C.api.post(`/api/billing/imports/${p.id}/apply`, {})).estado, 200);
    assert.equal((await C.api.post(`/api/billing/imports/${p.id}/reverse`, { reason: ' ' })).estado, 400);
    const r = await C.api.post(`/api/billing/imports/${p.id}/reverse`, { reason: 'La lista estaba desactualizada' });
    assert.equal(r.estado, 200, JSON.stringify(r.datos));
    assert.deepEqual([r.datos.invoices, r.datos.payments, r.datos.counter], [23, 17, 0]);
    const [n] = await C.db`SELECT (SELECT count(*) FROM billing_invoices)::int AS facturas, (SELECT count(*) FROM billing_invoice_lines)::int AS lineas,
      (SELECT count(*) FROM billing_payments)::int AS cobros, (SELECT count(*) FROM billing_payment_applications)::int AS aplicaciones,
      (SELECT last_number FROM billing_counters)::int AS contador`;
    assert.deepEqual(n, { facturas: 0, lineas: 0, cobros: 0, aplicaciones: 0, contador: 0 });
    assert.equal((await C.api.get(`/api/billing/imports/${p.id}`)).datos.status, 'reversed');
    assert.deepEqual(await snapshotLegacy(C.db), antes);
    const [{ acciones }] = await C.db`SELECT array_agg(action ORDER BY at) AS acciones FROM billing_audit WHERE entity = 'import_batch'`;
    assert.deepEqual(acciones, ['IMPORT_APPLY', 'IMPORT_REVERSE'], 'la bitácora conserva lo ocurrido');
    // y se puede volver a cargar con los mismos números 1..10
    const q = await preview(C);
    assert.deepEqual([q.totals.firstNumber, q.totals.lastNumber], [1, 23]);
  });

  test('si se emitió una factura después de aprobar, aplicar se rechaza: el contador ya no es el de la vista previa', async () => {
    const p = await preview(C);
    assert.equal(await aprobar(C, p), 200);
    const manual = await C.api.post('/api/billing/invoices', { payerClientId: C.id['Michelle Behar'], kind: 'manual', issuedOn: '2026-10-01',
      lines: [{ beneficiaryClientId: C.id['Michelle Behar'], unitAmount: 280, description: 'Manual de Joel' }] });
    assert.equal(manual.estado, 201);
    const r = await C.api.post(`/api/billing/imports/${p.id}/apply`, {});
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /Se emitieron facturas desde la vista previa/);
    const [{ n }] = await C.db`SELECT count(*)::int AS n FROM billing_invoices WHERE origin = 'carga_inicial'`;
    assert.equal(n, 0, 'si falla, no queda nada a medias');
  });

  test('si los datos viejos cambian después de aprobar, aplicar se rechaza (el hash ya no coincide)', async () => {
    const p = await preview(C);          // el contador ya es 1 por la factura manual de la prueba anterior
    assert.equal(await aprobar(C, p), 200);
    await C.db`UPDATE invoice_payments SET amount = 800 WHERE client_id = ${C.id['Riccardo Francolini']}`;
    try {
      const r = await C.api.post(`/api/billing/imports/${p.id}/apply`, {});
      assert.equal(r.estado, 409);
      assert.match(r.datos.error, /Los datos cambiaron desde que se aprobó/);
    } finally { await C.db`UPDATE invoice_payments SET amount = 900 WHERE client_id = ${C.id['Riccardo Francolini']}`; }
  });

  test('tras aplicar, un cobro posterior sobre una factura cargada impide revertir el lote', async () => {
    const p = await preview(C);
    assert.equal(p.totals.firstNumber, 2, 'los números siguen a la factura manual ya emitida');
    assert.equal(await aprobar(C, p), 200);
    assert.equal((await C.api.post(`/api/billing/imports/${p.id}/apply`, {})).estado, 200);
    const pendiente = (await C.api.get(`/api/billing/invoices?payerId=${C.id['Sandy Asis']}&status=abierta`)).datos.invoices[0];
    const cobro = await C.api.post('/api/billing/payments', { payerClientId: C.id['Sandy Asis'], amount: 300, method: 'Yappy', paidOn: '2026-10-01',
      applications: [{ invoiceId: pendiente.id, amount: 300 }] });
    assert.equal(cobro.estado, 201);
    const r = await C.api.post(`/api/billing/imports/${p.id}/reverse`, { reason: 'Prueba' });
    assert.equal(r.estado, 409);
    assert.match(r.datos.error, /Ya se emitieron facturas|recibió cobros o cambios posteriores/);
  });
});
