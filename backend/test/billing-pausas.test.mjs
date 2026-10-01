// Pausas a medio término (Joel, opción 2): el corte se corre lo que duró la pausa y el ciclo sigue donde se detuvo; a crédito se factura lo ya dado aunque haya pausa.
// Fechas literales con el reloj inyectado, salvo la prueba de la ruta de reanudar (usa "hoy" real y fechas relativas).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

async function levantarCon(entorno) {
  const previo = {};
  for (const [k, v] of Object.entries(entorno)) { previo[k] = process.env[k]; process.env[k] = v; }
  try { return await levantar(); } finally { for (const [k, v] of Object.entries(previo)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
let servidor; let api; let db; let ownerId; let gen; let dbModulo; const id = {};
const nuevo = async (nombre, corte, extra = {}) => { const r = await api.post('/api/clients', { fullName: nombre, cutoffDay: corte, ...extra }); assert.equal(r.estado, 201); id[nombre] = r.datos.id; };
const linea = async (b, p, kind, price, startsOn, extra = {}) => { const r = await api.post(`/api/clients/${id[b]}/billing-subscriptions`, { beneficiaryClientId: id[b], payerClientId: id[p], kind, price, startsOn, ...extra }); assert.equal(r.estado, 201, JSON.stringify(r.datos)); };
const factura = async (payer, kind, a, b, lines, extra = {}) => { const r = await api.post('/api/billing/invoices', { payerClientId: id[payer], kind, cycleStart: a, cycleEnd: b, issuedOn: kind === 'credito' ? b : a, ...extra, lines: lines.map(([n, unitAmount, description]) => ({ beneficiaryClientId: id[n], unitAmount, description })) }); assert.equal(r.estado, 201, JSON.stringify(r.datos)); };
const plan = (hoy, horizonte = 0, hora = 12) => db.begin(tx => gen.planBillingGeneration(tx, ownerId, hoy, horizonte, hora));

before(async () => {
  servidor = await levantarCon({ LEGACY_BILLING_GENERATION: 'off', NEW_BILLING_GENERATION: 'on' });
  process.env.DATABASE_URL = servidor.databaseUrl; process.env.JWT_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres'; process.env.SETUP_TOKEN = SETUP_TOKEN;
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 6 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  [{ id: ownerId }] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  gen = await import('../dist/billing-generator.js'); dbModulo = await import('../dist/db.js');
  await nuevo('Ana', 15); await nuevo('Julio', 31);
  await linea('Ana', 'Ana', 'monthly', 200, '2026-09-01'); await factura('Ana', 'mensual', '2026-10-15', '2026-11-15', [['Ana', 200, 'Mensualidad']]);
  await linea('Julio', 'Julio', 'credit', 25, '2026-08-31'); await factura('Julio', 'credito', '2026-08-31', '2026-09-30', [['Julio', 25, 'Sesiones a crédito']]);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await dbModulo?.sql.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('mientras Ana está en pausa no se le planea ninguna factura (aunque pase su corte del 15-11)', async () => {
  await db`UPDATE clients SET status = 'paused' WHERE id = ${id.Ana}`;
  assert.equal((await plan('2026-11-15', 40)).filter(i => i.payerId === id.Ana).length, 0);
});

test('al reanudar, el corte se corre lo que duró la pausa: pausa 20-10 -> 05-12 (46 días) mueve el ciclo del 15-11 al 31-12, y el día de corte pasa a 31', async () => {
  await db`UPDATE clients SET status = 'active' WHERE id = ${id.Ana}`;
  await db`INSERT INTO client_package_pauses (client_id, starts_on, resumed_on, days_frozen, status) VALUES (${id.Ana}, '2026-10-20', '2026-12-05', 46, 'resumed')`;
  const mover = await db.begin(tx => gen.shiftCutAfterPause(tx, ownerId, id.Ana));
  assert.deepEqual(mover, { oldCutDay: 15, newCutDay: 31, nextCycleStart: '2026-12-31' });
  assert.equal((await db`SELECT billing_cutoff_day AS d FROM clients WHERE id = ${id.Ana}`)[0].d, 31);
  const antes = (await plan('2026-12-30', 5)).find(i => i.payerId === id.Ana);
  assert.equal(antes.status, 'programada', 'el 30-12 todavía no toca');
  const dia = (await plan('2026-12-31')).find(i => i.payerId === id.Ana);
  assert.deepEqual([dia.status, dia.cycleStart, dia.cycleEnd, dia.issuedOn, dia.dueOn, dia.total], ['emitir', '2026-12-31', '2027-01-31', '2026-12-31', '2027-01-01', 200]);
  assert.equal((await plan('2026-12-05')).filter(i => i.payerId === id.Ana && i.status === 'omitida').length, 0, 'ya no queda un ciclo atrasado "omitido" al reanudar');
});

test('una pausa antigua (que no empezó dentro del último ciclo pagado) no suma, y repetir el cálculo no corre el corte dos veces', async () => {
  await db`INSERT INTO client_package_pauses (client_id, starts_on, resumed_on, days_frozen, status) VALUES (${id.Ana}, '2026-03-01', '2026-03-10', 9, 'resumed')`;
  const otra = await db.begin(tx => gen.shiftCutAfterPause(tx, ownerId, id.Ana));
  assert.deepEqual(otra, { oldCutDay: 31, newCutDay: 31, nextCycleStart: '2026-12-31' }, 'sigue contando solo la pausa del ciclo vigente y es idempotente');
});

test('A CRÉDITO: Julio en pausa o inactivo igual recibe la factura de lo ya dado (cumplidas + cancelación cobrada) al cerrar el ciclo', async () => {
  const ses = (f, status = 'completed', e = {}) => db`INSERT INTO sessions (client_id, starts_at, status, cancellation_kind, cancelled_by, credit_charge) VALUES (${id.Julio}, ${f}::timestamptz, ${status}, ${e.kind ?? null}, ${e.by ?? null}, ${e.cargo ?? false})`;
  for (const f of ['2026-10-02', '2026-10-06', '2026-10-13']) await ses(`${f}T10:00:00-05:00`);
  await ses('2026-10-16T10:00:00-05:00', 'cancelled', { kind: 'not_rescheduled', by: 'client', cargo: true });
  for (const estado of ['paused', 'inactive']) {
    await db`UPDATE clients SET status = ${estado} WHERE id = ${id.Julio}`;
    const j = (await plan('2026-10-31', 0, 21)).find(i => i.payerId === id.Julio);
    assert.deepEqual([j.status, j.total, j.dueOn], ['emitir', 100, '2026-11-01'], `con el cliente ${estado}: 4 clases × $25`);
  }
  // mientras el ciclo sigue abierto y el cliente está en pausa no se planean filas de relleno
  assert.equal((await plan('2026-10-20', 20)).filter(i => i.payerId === id.Julio).length, 0);
  const r = await gen.runBillingGeneration(ownerId, '2026-10-31', 21);
  assert.equal(r.created.filter(c => c.payerName === 'Julio').length, 1);
});

test('RUTA reanudar (estado new): devuelve el nuevo día de corte y la fecha de su próximo ciclo, y mueve el corte del cliente', async () => {
  const [{ hoy }] = await db`SELECT current_date::text AS hoy`;
  const mas = d => { const x = new Date(`${hoy}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
  await nuevo('Berta', 15);
  await linea('Berta', 'Berta', 'monthly', 150, mas(-40));
  await factura('Berta', 'mensual', mas(-20), mas(10), [['Berta', 150, 'Mensualidad']]);
  await db`UPDATE clients SET status = 'paused' WHERE id = ${id.Berta}`;
  const [pausa] = await db`INSERT INTO client_package_pauses (client_id, starts_on, status) VALUES (${id.Berta}, ${mas(-10)}, 'active') RETURNING id`;
  const r = await api.post(`/api/client-pauses/${pausa.id}/resume`, {});
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  const esperado = mas(20);   // fin del ciclo (+10) corrido 10 días de pausa
  assert.deepEqual([r.datos.billing.nextCycleStart, r.datos.billing.newCutDay, r.datos.billing.oldCutDay], [esperado, Number(esperado.slice(8, 10)), 15]);
  assert.equal((await db`SELECT billing_cutoff_day AS d FROM clients WHERE id = ${id.Berta}`)[0].d, Number(esperado.slice(8, 10)));
  assert.equal((await db`SELECT status FROM clients WHERE id = ${id.Berta}`)[0].status, 'active');
});
