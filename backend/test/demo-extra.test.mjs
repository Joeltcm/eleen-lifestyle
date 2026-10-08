import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db;
const dia = n => new Date(Date.now() - 5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const E = n => ({ name: n, sets: 3, reps: '10' });
before(async () => {
  servidor = await levantar(); api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const s = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN }); api.usarToken(s.datos.token);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });
const portalDe = async c => { const a = await api.post(`/api/auth/access-link/${String((await api.post(`/api/clients/${c}/access-link`, {})).datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' }); const p = cliente(servidor.base); p.usarToken(a.datos.token); return p; };

test('1) un cliente creado como cualquier otro (sin plan, sin pagos) PUEDE pasar a demo', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Riny normal', cutoffDay: 1, email: 'rinyn@prueba.test' })).datos.id;
  const r = await api.post(`/api/clients/${c}/demo`, { demoEndsOn: dia(14), demoRoutineLimit: 3 });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
});

test('2) pasar a demo con rutina asignada y enlace: el enlace sigue abriendo, el historial no cambia y NO sale doble', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Riny enlace', cutoffDay: 1, email: 'rinye@prueba.test' })).datos.id;
  const rut = (await api.post('/api/routines', { title: 'Rutina X', sessionsPerWeek: 1, clientId: c, dueOn: dia(5), exercises: [E('A'), E('B')] })).datos;
  const enlace = await api.post(`/api/routines/${rut.id}/share-links`, { clientId: c, until: dia(5), confirmRepeat: true });
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));
  const token = String(enlace.datos.url).split('#rutina=')[1];
  const antes = await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE client_id = ${c}`;
  const pasar = await api.post(`/api/clients/${c}/demo`, { demoEndsOn: dia(14), demoRoutineLimit: 3 });
  assert.equal(pasar.estado, 200, JSON.stringify(pasar.datos));
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE client_id = ${c}`)[0].n, antes[0].n, 'el historial de envíos no cambia');
  const pub = await cliente(servidor.base).get(`/api/public/routine/${token}`);
  assert.equal(pub.estado, 200, 'el enlace público sigue abriendo');
  const portal = await portalDe(c);
  const h = (await portal.get('/api/portal/summary')).datos.routineHistory;
  assert.equal(h.length, 1, `una sola fila para la clienta (hay ${h.length}: ${JSON.stringify(h.map(x => x.kind))})`);
});

test('3) demo terminada: la rutina y el enlace ya enviados siguen valiendo; uno nuevo se rechaza', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Demo termina', cutoffDay: 1, email: 'dt@prueba.test', demo: true, demoEndsOn: dia(3) })).datos.id;
  const rut = (await api.post('/api/routines', { title: 'Enviada antes', sessionsPerWeek: 1, clientId: c, dueOn: dia(20), exercises: [E('A')] })).datos;
  const enlace = await api.post(`/api/routines/${rut.id}/share-links`, { clientId: c, until: dia(20), confirmRepeat: true });
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));
  const token = String(enlace.datos.url).split('#rutina=')[1];
  await db`UPDATE clients SET demo_ends_on = ${dia(-1)}::date WHERE id = ${c}`;
  assert.equal((await cliente(servidor.base).get(`/api/public/routine/${token}`)).estado, 200, 'el enlace ya enviado sigue abriendo');
  const hecho = await cliente(servidor.base).post(`/api/public/routine/${token}/complete`, { completionPercent: 100 });
  assert.equal(hecho.estado, 200, JSON.stringify(hecho.datos));
  const otra = (await api.post('/api/routines', { title: 'Nueva', sessionsPerWeek: 1, exercises: [E('Z')] })).datos;
  assert.equal((await api.post(`/api/routines/${otra.id}/share-links`, { clientId: c, until: dia(5), confirmRepeat: true })).estado, 409, 'un envío nuevo se bloquea');
});

test('4) tope: cuenta lo ya enviado; reenviar la misma rutina por enlace no consume; la tercera distinta se rechaza por TODAS las vías', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Tope', cutoffDay: 1, email: 'tope@prueba.test', demo: true, demoEndsOn: dia(14), demoRoutineLimit: 2 })).datos.id;
  const r1 = (await api.post('/api/routines', { title: 'T1', sessionsPerWeek: 1, clientId: c, exercises: [E('A')] })).datos;
  assert.equal((await api.post(`/api/routines/${r1.id}/share-links`, { clientId: c, until: dia(5), confirmRepeat: true })).estado, 201, 'la misma rutina por enlace no consume');
  const r2 = (await api.post('/api/routines', { title: 'T2', sessionsPerWeek: 1, clientId: c, exercises: [E('B')] })).datos;
  const r3 = (await api.post('/api/routines', { title: 'T3', sessionsPerWeek: 1, exercises: [E('C')] })).datos;
  assert.equal((await api.post(`/api/routines/${r3.id}/share-links`, { clientId: c, until: dia(5), confirmRepeat: true })).estado, 409, 'por enlace');
  assert.equal((await api.patch(`/api/routines/${r3.id}`, { title: 'T3', sessionsPerWeek: 1, clientId: c, exercises: [E('C')], confirmRepeat: true })).estado, 409, 'por asignación (PATCH)');
  assert.ok(r2.id);
});

test('5) el portal del demo: numeración, aviso y WhatsApp', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Portal Demo', cutoffDay: 1, email: 'pd@prueba.test', demo: true, demoEndsOn: dia(14), demoRoutineLimit: 3 })).datos.id;
  await api.post('/api/routines', { title: 'P1', sessionsPerWeek: 1, clientId: c, exercises: [E('A')] });
  const portal = await portalDe(c);
  const s = (await portal.get('/api/portal/summary')).datos;
  console.log('PORTAL', JSON.stringify({ idx: s.routines.map(x => [x.demo_routine_index, x.demo_routine_total]), cli: s.client }));
});

test('6) numeración "Rutina N de TOPE" por orden de envío (no por id) y el total es el tope de Eileen', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Numera', cutoffDay: 1, email: 'num@prueba.test', demo: true, demoEndsOn: dia(14), demoRoutineLimit: 5 })).datos.id;
  const titulos = ['Primera', 'Segunda', 'Tercera', 'Cuarta'];
  for (const t of titulos) { await api.post('/api/routines', { title: t, sessionsPerWeek: 1, clientId: c, exercises: [E(t)] }); await db`UPDATE routine_deliveries SET sent_at = sent_at - interval '1 hour' * ${titulos.length - titulos.indexOf(t)} WHERE client_id = ${c} AND routine_title = ${t}`; }
  const s = (await (await portalDe(c)).get('/api/portal/summary')).datos;
  assert.deepEqual(s.routines.map(r => [r.title, r.demo_routine_index, r.demo_routine_total]), titulos.map((t, i) => [t, i + 1, 5]));
});

test('7) no se puede pasar a demo a quien ya tiene clases programadas o facturas; y al pasar se neutraliza su plan viejo', async () => {
  const conClase = (await api.post('/api/clients', { fullName: 'Con clase', cutoffDay: 1, email: 'cc@prueba.test' })).datos.id;
  assert.equal((await api.post('/api/sessions', { clientId: conClase, startsAt: new Date(Date.now() + 3 * 86400_000).toISOString(), durationMinutes: 45, mode: 'Presencial' })).estado, 201);
  assert.equal((await api.post(`/api/clients/${conClase}/demo`, { demoEndsOn: dia(14) })).estado, 409, 'clase programada');
  const conFactura = (await api.post('/api/clients', { fullName: 'Con factura', cutoffDay: 1, email: 'cf@prueba.test' })).datos.id;
  assert.equal((await api.post('/api/invoices', { clientId: conFactura, concept: 'Sesión suelta', amount: 25, dueOn: dia(3) })).estado, 201);
  assert.equal((await api.post(`/api/clients/${conFactura}/demo`, { demoEndsOn: dia(14) })).estado, 409, 'factura existente');
  const plan = (await api.post('/api/plans', { name: 'Plan demo', billingModel: 'monthly', price: 180, sessionsIncluded: 8 })).datos;
  const conPlan = (await api.post('/api/clients', { fullName: 'Con plan', cutoffDay: 5, email: 'cp@prueba.test', planId: plan.id })).datos.id;
  const pasado = await api.post(`/api/clients/${conPlan}/demo`, { demoEndsOn: dia(14) });
  assert.equal(pasado.estado, 200, JSON.stringify(pasado.datos));
  const [f] = await db`SELECT plan_id, standard_price::float AS precio, billing_model FROM clients WHERE id = ${conPlan}`;
  assert.deepEqual([f.plan_id, f.precio, f.billing_model], [null, 0, 'single'], 'el plan viejo queda neutralizado');
  assert.match((await db`SELECT note FROM client_mode_events WHERE client_id = ${conPlan} ORDER BY at DESC LIMIT 1`)[0].note, /precio=180/, 'la configuración anterior queda en el evento');
  assert.equal((await api.post(`/api/clients/${conPlan}/demo/convert`, {})).estado, 200);
  assert.equal((await db`SELECT count(*)::int AS n FROM invoices WHERE client_id = ${conPlan}`)[0].n + (await db`SELECT count(*)::int AS n FROM billing_invoices WHERE payer_client_id = ${conPlan}`)[0].n, 0, 'convertir no crea cargos');
});

test('8) los trabajos de vencimiento saltan a un demo aunque se le fuerce una clase con oferta', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Forzado', cutoffDay: 1, email: 'fz@prueba.test', demo: true, demoEndsOn: dia(14) })).datos.id;
  const r = (await api.post('/api/routines', { title: 'Forzada', sessionsPerWeek: 1, clientId: c, exercises: [E('A')] })).datos;
  const [ses] = await db`INSERT INTO sessions (client_id, starts_at, duration_minutes, status, mode) VALUES (${c}, now() - interval '2 days', 45, 'scheduled', 'Presencial') RETURNING id`;
  const [{ owner_id: dueno }] = await db`SELECT owner_id FROM clients WHERE id = ${c}`;
  await db`INSERT INTO session_routine_offers (session_id, routine_id, client_id, offered_by_user_id, origin) VALUES (${ses.id}, ${r.id}, ${c}, ${dueno}, 'client')`;
  await api.post('/api/maintenance/vencer-ofertas-rutina', {});
  assert.equal((await db`SELECT status FROM sessions WHERE id = ${ses.id}`)[0].status, 'scheduled', 'no se cancela ni se descuenta');
});

test('9) una clienta que VUELVE (inactiva, con facturas y pagos viejos ya cobrados) sí puede pasar a demo; con una factura por cobrar, no', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Vuelve', cutoffDay: 1, email: 'vuelve@prueba.test' })).datos.id;
  const [{ id: factura }] = await db`INSERT INTO invoices (client_id, concept, amount, due_on, status) VALUES (${c}, 'Mensualidad antigua', 100, '2025-12-01', 'confirmed') RETURNING id`;
  await db`INSERT INTO invoice_payments (client_id, amount, paid_on, method) VALUES (${c}, 100, '2025-12-02', 'Yappy')`;
  await db`UPDATE clients SET status = 'inactive' WHERE id = ${c}`;
  await db`UPDATE clients SET status = 'active' WHERE id = ${c}`;
  const ok = await api.post(`/api/clients/${c}/demo`, { demoEndsOn: dia(14), demoRoutineLimit: 2 });
  assert.equal(ok.estado, 200, JSON.stringify(ok.datos));
  assert.ok(factura);
  const d = (await api.post('/api/clients', { fullName: 'Debe', cutoffDay: 1, email: 'debe@prueba.test' })).datos.id;
  await db`INSERT INTO invoices (client_id, concept, amount, due_on, status) VALUES (${d}, 'Mensualidad sin cobrar', 100, '2026-08-01', 'pending')`;
  const no = await api.post(`/api/clients/${d}/demo`, { demoEndsOn: dia(14) });
  assert.equal(no.estado, 409);
  assert.match(String(no.datos.error || no.datos.message), /1 factura pendiente de cobro/);
});
