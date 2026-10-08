// Expiración de la rutina ofrecida por cancelación de la clienta: descuento del plan mensual o cargo a crédito, sin duplicar, y lo que ve la clienta en su historial.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db;
const dia = n => new Date(Date.now() - 5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const aHora = (d, h = '09:00') => new Date(`${d}T${h}:00-05:00`).toISOString();
const E = (n, x = {}) => ({ name: n, sets: 3, reps: '10', ...x });

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

async function escenario(nombre, { credito = false, origen = 'client', conPaquete = !credito } = {}) {
  const alta = await api.post('/api/clients', credito ? { fullName: nombre, cutoffDay: 1, email: `${nombre.toLowerCase().replace(/\W+/g, '')}@prueba.test`, paymentMode: 'no_anticipado', creditSessionPrice: 25 } : { fullName: nombre, cutoffDay: 1, email: `${nombre.toLowerCase().replace(/\W+/g, '')}@prueba.test` });
  assert.equal(alta.estado, 201, JSON.stringify(alta.datos));
  const c = alta.datos.id;
  let paquete = null;
  if (conPaquete) {
    paquete = (await api.post('/api/packages', { clientId: c, totalSessions: 12, amount: 300, dueOn: dia(0), kind: 'monthly' })).datos;
    await db`UPDATE session_packages SET status = 'active' WHERE id = ${paquete.id}`;
  }
  const r = (await api.post('/api/routines', { title: `Rutina ${nombre}`, sessionsPerWeek: 2, clientId: c, dueOn: dia(5), exercises: [E('Sentadilla'), E('Plancha')] })).datos;
  const sesion = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(dia(0), '23:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: r.id, origin: origen });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));
  const acceso = await api.post(`/api/auth/access-link/${String((await api.post(`/api/clients/${c}/access-link`, {})).datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
  const portal = cliente(servidor.base); portal.usarToken(acceso.datos.token);
  return { c, r, sesion, paquete, portal };
}
const pasarElDia = sesion => db`UPDATE sessions SET starts_at = starts_at - interval '2 days' WHERE id = ${sesion}`;
const vencer = async () => api.post('/api/maintenance/vencer-ofertas-rutina', {});

test('A) plan mensual: al vencer la oferta de la clienta se descuenta UNA sesión, la clase queda cancelada por la clienta, y repetir no descuenta de nuevo', async () => {
  const { sesion, paquete, portal } = await escenario('Mensual');
  const antes = (await db`SELECT used_sessions FROM session_packages WHERE id = ${paquete.id}`)[0].used_sessions;
  await pasarElDia(sesion);
  const v1 = await vencer(); assert.ok(v1.estado < 300, JSON.stringify(v1.datos));
  const [s] = await db`SELECT status, cancelled_by, cancellation_kind, package_debited, credit_charge FROM sessions WHERE id = ${sesion}`;
  assert.deepEqual([s.status, s.cancelled_by, s.cancellation_kind, s.package_debited, s.credit_charge], ['cancelled', 'client', 'not_rescheduled', true, false]);
  assert.equal((await db`SELECT used_sessions FROM session_packages WHERE id = ${paquete.id}`)[0].used_sessions, antes + 1);
  await vencer(); await portal.get('/api/portal/summary'); await api.get('/api/notifications'); await vencer();
  assert.equal((await db`SELECT used_sessions FROM session_packages WHERE id = ${paquete.id}`)[0].used_sessions, antes + 1, 'no se descuenta dos veces');
  const avisos = (await api.get('/api/notifications')).datos.filter(a => /expirada/i.test(a.title));
  assert.equal(avisos.length, 1, `un solo aviso de expiración en la campanita (hay ${avisos.length})`);
  assert.match(avisos[0].body, /no cumplida/); assert.match(avisos[0].body, /plan mensual/);
});

test('B) a crédito: al vencer se registra el cargo de UNA clase en la factura de crédito, una sola vez', async () => {
  const { c, sesion } = await escenario('Credito', { credito: true });
  await pasarElDia(sesion);
  assert.ok((await vencer()).estado < 300);
  const [s] = await db`SELECT status, cancelled_by, credit_charge, package_debited FROM sessions WHERE id = ${sesion}`;
  assert.deepEqual([s.status, s.cancelled_by, s.credit_charge, s.package_debited], ['cancelled', 'client', true, false]);
  // El motor de facturación cobra las clases con credit_charge (generador: cancelaciones del cliente no reprogramadas y marcadas cobrables; su prueba ya cubre el monto).
  const cobrables = async () => (await db`SELECT count(*)::int AS n FROM sessions WHERE client_id = ${c} AND status = 'cancelled' AND cancellation_kind = 'not_rescheduled' AND COALESCE(cancelled_by, 'client') = 'client' AND credit_charge = true`)[0].n;
  assert.equal(await cobrables(), 1, 'la clase expirada queda como cobrable en la factura a crédito');
  await vencer(); await api.get('/api/notifications'); await vencer();
  assert.equal(await cobrables(), 1, 'repetir no suma otro cargo');
  assert.equal((await db`SELECT count(*)::int AS n FROM session_packages WHERE client_id = ${c}`)[0].n, 0, 'a crédito no toca ningún paquete');
});

test('C) la oferta de EILEEN no se penaliza al vencer; la cumplida a tiempo tampoco; y una clase de HOY no vence aún', async () => {
  const eileen = await escenario('Eileen origen', { origen: 'trainer' });
  await pasarElDia(eileen.sesion); await vencer();
  assert.equal((await db`SELECT status FROM sessions WHERE id = ${eileen.sesion}`)[0].status, 'scheduled', 'oferta de Eileen: la clase sigue pendiente');
  const hoyCliente = await escenario('Hoy');
  await vencer();
  assert.equal((await db`SELECT status FROM sessions WHERE id = ${hoyCliente.sesion}`)[0].status, 'scheduled', 'una clase de hoy no ha vencido');
});

test('D) el historial de la clienta: lo que ve (sin versiones ni traslados), y el vencimiento sigue la fecha límite ACTUAL, no la de cuando se envió', async () => {
  const { c, r, portal } = await escenario('Historial', { conPaquete: false });
  // 1) la fecha límite se alarga después del envío: no debe aparecer expirada
  await db`UPDATE routine_assignments SET due_on = ${dia(-2)}::date WHERE routine_id = ${r.id}`;
  await db`UPDATE routine_deliveries SET due_on = ${dia(-2)}::date WHERE routine_id = ${r.id}`;           // como estaba al enviarse (ya vencida)
  const ext = await api.patch(`/api/routines/${r.id}`, { title: r.title, description: r.description || '', sessionsPerWeek: 2, exercises: r.exercises, dueOn: dia(10) });   // Eileen la alarga
  assert.equal(ext.estado, 200, JSON.stringify(ext.datos));
  const h1 = (await portal.get('/api/portal/summary')).datos.routineHistory.find(x => x.routine_id === r.id && x.kind === 'assignment');
  assert.equal(h1.delivery_status, 'active', `con la fecha límite alargada la rutina está ACTIVA, no expirada: ${JSON.stringify(h1)}`);
  // 2) tras versionar, la clienta no ve filas de "nueva versión" ni número de versión
  const v2 = await api.patch(`/api/routines/${r.id}`, { title: r.title, description: r.description || '', sessionsPerWeek: 2, exercises: [E('Sentadilla'), E('Remo')], confirmVersion: true });
  assert.equal(v2.estado, 200, JSON.stringify(v2.datos));
  const historial = (await portal.get('/api/portal/summary')).datos.routineHistory;
  assert.ok(!historial.some(x => x.kind === 'new_version'), `un traslado a una versión nueva no es un envío para la clienta: ${JSON.stringify(historial.map(x => x.kind))}`);
  assert.ok(historial.every(x => x.routine_version == null), 'la clienta no ve números de versión');
});

test('F) viaje sin rutina confirmada: a crédito la clase queda cobrable (una vez); con plan mensual sigue descontando y no es cobrable', async () => {
  const hace2 = dia(-2);
  const caso = async nombre => {
    const credito = nombre === 'Viaje credito';
    const alta = await api.post('/api/clients', credito ? { fullName: nombre, cutoffDay: 1, email: 'viajecredito@prueba.test', paymentMode: 'no_anticipado', creditSessionPrice: 25 } : { fullName: nombre, cutoffDay: 1, email: 'viajemensual@prueba.test' });
    assert.equal(alta.estado, 201, JSON.stringify(alta.datos));
    const c = alta.datos.id;
    let paquete = null;
    if (!credito) { paquete = (await api.post('/api/packages', { clientId: c, totalSessions: 12, amount: 300, dueOn: dia(0), kind: 'monthly' })).datos; await db`UPDATE session_packages SET status = 'active' WHERE id = ${paquete.id}`; }
    const viaje = (await api.post(`/api/clients/${c}/travel`, { startsOn: dia(-3), endsOn: dia(5), destination: 'Lisboa' })).datos.id;
    const sesion = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(hace2, '09:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
    await db`UPDATE client_travel SET created_at = now() - interval '3 days' WHERE id = ${viaje}`;
    return { c, sesion, paquete };
  };
  const cred = await caso('Viaje credito'); const mens = await caso('Viaje mensual');
  assert.equal((await vencer()).datos.porViaje, 2);
  const [sc] = await db`SELECT status, cancelled_by, credit_charge, package_debited FROM sessions WHERE id = ${cred.sesion}`;
  assert.deepEqual([sc.status, sc.cancelled_by, sc.credit_charge, sc.package_debited], ['cancelled', 'client', true, false]);
  const [sm] = await db`SELECT status, credit_charge, package_debited FROM sessions WHERE id = ${mens.sesion}`;
  assert.deepEqual([sm.status, sm.credit_charge, sm.package_debited], ['cancelled', false, true]);
  assert.equal((await db`SELECT used_sessions FROM session_packages WHERE id = ${mens.paquete.id}`)[0].used_sessions, 1);
  await vencer(); await vencer();
  assert.equal((await db`SELECT count(*)::int AS n FROM sessions WHERE client_id = ${cred.c} AND credit_charge = true`)[0].n, 1, 'una sola clase cobrable');
});

test('G) aviso previo a la clienta: solo ofertas de ELLA, de HOY, desde las 19:00 (Panamá); la de Eileen no alarma; y 068 admite los tipos nuevos de aviso', async () => {
  const suya = await escenario('Aviso clienta'); const credito = await escenario('Aviso credito', { credito: true }); const deEileen = await escenario('Aviso Eileen', { origen: 'trainer' });
  const nombres = async hora => (await api.get(`/api/maintenance/rutinas-por-vencer?hora=${hora}`)).datos;
  assert.deepEqual((await nombres(10)).candidatas, [], 'de mañana/mediodía todavía no');
  // Sin suscripción push no hay a quién avisar: la consulta exige un dispositivo activo.
  assert.deepEqual((await nombres(20)).candidatas, [], 'sin dispositivo registrado no hay aviso');
  for (const e of [suya, credito, deEileen]) {
    const usuario = (await db`SELECT portal_user_id FROM clients WHERE id = ${e.c}`)[0].portal_user_id;
    await db`INSERT INTO notification_preferences (user_id, browser_enabled) VALUES (${usuario}, true) ON CONFLICT (user_id) DO UPDATE SET browser_enabled = true`;
    await db`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (${usuario}, ${'https://push.invalid/' + e.c}, 'p', 'a')`;
  }
  const a20 = (await nombres(20)).candidatas;
  assert.deepEqual(a20.map(x => [x.cliente, x.a_credito]).sort(), [['Aviso clienta', false], ['Aviso credito', true]], 'solo las dos ofertas de la clienta');
  assert.deepEqual((await nombres(18)).candidatas, [], 'antes de las 19:00 no');
  // Ya avisada (clave idempotente): deja de aparecer.
  const oferta = (await db`SELECT o.id, c.portal_user_id AS u FROM session_routine_offers o JOIN sessions s ON s.id = o.session_id JOIN clients c ON c.id = s.client_id WHERE c.id = ${suya.c}`)[0];
  await db`INSERT INTO notification_deliveries (user_id, kind, reference_id) VALUES (${oferta.u}, 'routine_expiring', ${oferta.id})`;
  assert.deepEqual((await nombres(20)).candidatas.map(x => x.cliente), ['Aviso credito']);
  // Los tipos que el código ya usaba y la restricción vieja rechazaba.
  for (const tipo of ['pending', 'pause']) await db`INSERT INTO notification_deliveries (user_id, kind, reference_id) VALUES (${oferta.u}, ${tipo}, gen_random_uuid())`;
});

// Va al final: revierte la restricción compartida por todas las pruebas de este archivo.
test('E) la reversa de 067 se NIEGA a borrar avisos de expiración sin orden expresa, y con ella deja la restricción anterior', async () => {
  const psql = (permitir = false) => promisify(execFile)('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, ...(permitir ? ['-c', "SET billing.allow_destructive_down = 'on'"] : []), '-f', new URL('../migrations-down/067_routine_expiration_notifications.down.sql', import.meta.url).pathname]);
  assert.ok((await db`SELECT count(*)::int AS n FROM routine_activity_notifications WHERE kind = 'expired'`)[0].n > 0, 'las pruebas anteriores dejaron avisos expired');
  await assert.rejects(psql(), /exige orden expresa/);
  assert.ok((await db`SELECT count(*)::int AS n FROM routine_activity_notifications WHERE kind = 'expired'`)[0].n > 0, 'sin orden no se borró nada');
  await psql(true);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_activity_notifications WHERE kind = 'expired'`)[0].n, 0);
  const [base] = await db`SELECT r.owner_id, r.id AS routine_id, ra.client_id FROM routines r JOIN routine_assignments ra ON ra.routine_id = r.id LIMIT 1`;
  await assert.rejects(db`INSERT INTO routine_activity_notifications (owner_id, routine_id, client_id, completed_on, kind, title, body) VALUES (${base.owner_id}, ${base.routine_id}, ${base.client_id}, '2026-01-01', 'expired', 't', 'b')`, /check/i);
});
