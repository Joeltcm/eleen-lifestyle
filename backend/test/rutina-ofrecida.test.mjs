// Rutina ofrecida cuando un cliente cancela (J-102): la clase sigue programada; si el cliente cumple la rutina en el portal, la clase pasa a realizada y Eileen recibe el aviso.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);

let servidor; let api; let portal; let c; let rutinaId; let otraRutinaId; let sesionId;
// La oferta solo vale el día de la clase (hora de Panamá): la clase de prueba es hoy a las 23:00 de Panamá (puede estar aún por delante o ya pasada; la rutina la cierra igual).
const hoyPanama = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
const hoyALas23 = () => new Date(`${hoyPanama()}T23:00:00-05:00`).toISOString();

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  c = (await api.post('/api/clients', { fullName: 'Cliente Rutina', cutoffDay: 1, email: 'rutina@prueba.test' })).datos.id;
  const ejercicios = [{ name: 'Sentadilla', sets: 3, reps: '12' }, { name: 'Plancha', sets: 3, reps: '30 seg' }];
  rutinaId = (await api.post('/api/routines', { title: 'Rutina en casa', description: 'Calienta 5 minutos.', sessionsPerWeek: 1, exercises: ejercicios, clientId: c })).datos.id;
  otraRutinaId = (await api.post('/api/routines', { title: 'Sin asignar', sessionsPerWeek: 1, exercises: ejercicios })).datos.id;
  sesionId = (await api.post('/api/sessions', { clientId: c, startsAt: hoyALas23(), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const enlace = await api.post(`/api/clients/${c}/access-link`, {});
  const acceso = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
  portal = cliente(servidor.base); portal.usarToken(acceso.datos.token);
}, { timeout: 90_000 });
after(async () => { await servidor?.parar(); });

const sesionDe = async id => (await api.get('/api/sessions')).datos.find(x => x.id === id);

test('ofrecer una rutina no cancela la clase: queda programada con la rutina ligada y la oferta visible', async () => {
  assert.equal((await api.post(`/api/sessions/${sesionId}/routine-offer`, { routineId: otraRutinaId })).estado, 409, 'una rutina no asignada al cliente no se ofrece');
  const r = await api.post(`/api/sessions/${sesionId}/routine-offer`, { routineId: rutinaId, confirmRepeat: true });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  const s = await sesionDe(sesionId);
  assert.equal(s.status, 'scheduled');
  assert.equal(s.routine_id, rutinaId);
  assert.equal(s.routine_offer_status, 'offered');
  assert.match(s.notes, /Rutina ofrecida en lugar de la clase/);
  const ofertas = await portal.get('/api/portal/routine-offers');
  assert.equal(ofertas.datos.length, 1);
  assert.equal(ofertas.datos[0].routine_title, 'Rutina en casa');
});

test('cumplir la rutina cierra la clase como realizada (aunque su hora no haya llegado), guarda la duración y avisa a Eileen', async () => {
  const oferta = (await portal.get('/api/portal/routine-offers')).datos[0];
  const r = await portal.post(`/api/portal/routine-offers/${oferta.id}/complete`, { completionPercent: 100, durationSeconds: 1500 });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.completed, true);
  assert.equal(r.datos.sessionCompleted, true);
  const s = await sesionDe(sesionId);
  assert.equal(s.status, 'completed');
  assert.equal(s.routine_offer_status, 'completed');
  assert.equal(s.routine_offer_duration_seconds, 1500);
  assert.equal((await portal.get('/api/portal/routine-offers')).datos.length, 0);
  const avisos = (await api.get('/api/notifications')).datos.filter(a => a.type === 'routine');
  assert.equal(avisos.length, 1);
  assert.match(avisos[0].title, /Cliente Rutina/);
  assert.match(avisos[0].body, /Rutina en casa.*25 min.*100%/);
  const otra = await portal.post(`/api/portal/routine-offers/${oferta.id}/complete`, { completionPercent: 100 });
  assert.equal(otra.datos.alreadyCompleted, true, 'completarla dos veces no descuenta dos veces');
  assert.equal((await api.post(`/api/sessions/${sesionId}/routine-offer`, { routineId: rutinaId, confirmRepeat: true })).estado, 409, 'ya no se ofrece en una clase realizada');
});

test('marcar el último ejercicio cierra la oferta y la clase en la misma operación', async () => {
  const rutinaAtomica = (await api.post('/api/routines', {
    title: 'Rutina atómica', sessionsPerWeek: 1,
    exercises: [{ name: 'Puente de glúteos', sets: 2, reps: '12' }], clientId: c
  })).datos.id;
  const sesionAtomica = (await api.post('/api/sessions', { clientId: c, startsAt: hoyALas23(), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sesionAtomica}/routine-offer`, { routineId: rutinaAtomica, confirmRepeat: true });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));

  const hoy = hoyPanama();
  const inicio = await portal.post('/api/portal/routine-activity', { routineId: rutinaAtomica, completedOn: hoy, kind: 'started', elapsedSeconds: 0 });
  assert.equal(inicio.estado, 201, JSON.stringify(inicio.datos));
  const marcado = await portal.post('/api/portal/routine-exercise-completions', {
    routineId: rutinaAtomica, completedOn: hoy, exerciseIndex: 0, elapsedSeconds: 120
  });
  assert.equal(marcado.estado, 201, JSON.stringify(marcado.datos));
  assert.equal(marcado.datos.routineCompleted, true);
  assert.equal(marcado.datos.offerCompleted, true);
  assert.equal(marcado.datos.sessionCompleted, true);

  const sesion = await sesionDe(sesionAtomica);
  assert.equal(sesion.status, 'completed');
  assert.equal(sesion.routine_offer_status, 'completed');
  assert.equal(sesion.routine_offer_duration_seconds, 120);
  assert.equal((await portal.get('/api/portal/routine-offers')).datos.some(item => item.id === oferta.datos.id), false);
});

test('la oferta vale SOLO el día de la clase: una clase de otro día no se muestra ni se puede cumplir; una clase pasada no admite oferta; la vencida se marca', async () => {
  const futura = (await api.post('/api/sessions', { clientId: c, startsAt: new Date(Date.now() + 50 * 3600_000).toISOString(), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const ofrecida = await api.post(`/api/sessions/${futura}/routine-offer`, { routineId: rutinaId, confirmRepeat: true });
  assert.equal(ofrecida.estado, 201, 'se puede ofrecer con anticipación para el día de esa clase');
  assert.equal((await portal.get('/api/portal/routine-offers')).datos.length, 0, 'pero el portal no la muestra hasta ese día');
  const antes = await portal.post(`/api/portal/routine-offers/${ofrecida.datos.id}/complete`, { completionPercent: 100 });
  assert.equal(antes.estado, 409);
  assert.match(antes.datos.error, /solo valía el \d{2}-\d{2}-\d{4}/);
  assert.equal((await sesionDe(futura)).status, 'scheduled', 'la clase no se tocó');
  // Clase de ayer: ya no admite oferta.
  const ayer = (await api.post('/api/sessions', { clientId: c, startsAt: new Date(Date.now() - 30 * 3600_000).toISOString(), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const tarde = await api.post(`/api/sessions/${ayer}/routine-offer`, { routineId: rutinaId, confirmRepeat: true });
  assert.equal(tarde.estado, 409); assert.match(tarde.datos.error, /solo vale el día de la clase/);
  // Una oferta cuyo día ya pasó queda marcada como vencida (la clase sigue programada para que Eileen decida).
  const db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  try { await db`UPDATE sessions SET starts_at = now() - interval '3 days' WHERE id = ${futura}`; } finally { await db.end({ timeout: 1 }).catch(() => {}); }
  const vencida = await sesionDe(futura);
  assert.equal(vencida.routine_offer_status, 'offered'); assert.equal(vencida.routine_offer_expired, true); assert.equal(vencida.status, 'scheduled');
  assert.equal((await portal.post(`/api/portal/routine-offers/${ofrecida.datos.id}/complete`, { completionPercent: 100 })).estado, 409);
});

test('retirar la oferta la quita; el portal no acepta ofertas ajenas ni sesiones sin ella', async () => {
  const s2 = (await api.post('/api/sessions', { clientId: c, startsAt: hoyALas23(), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  assert.equal((await api.post(`/api/sessions/${s2}/routine-offer`, { routineId: rutinaId, confirmRepeat: true })).estado, 201);
  assert.equal((await portal.get('/api/portal/routine-offers')).datos.length, 1, 'hoy sí se muestra');
  assert.equal((await api.delete(`/api/sessions/${s2}/routine-offer`)).estado, 200);
  assert.equal((await portal.get('/api/portal/routine-offers')).datos.length, 0);
  assert.equal((await sesionDe(s2)).status, 'scheduled');
  assert.equal((await api.delete(`/api/sessions/${s2}/routine-offer`)).estado, 404);
  const sinSesion = await cliente(servidor.base).get('/api/portal/routine-offers');
  assert.equal(sinSesion.estado, 401);
  const comoStaff = await api.get('/api/portal/routine-offers');
  assert.equal(comoStaff.estado, 403);
});

test('la rutina cumplida suelta también guarda la duración del cronómetro y avisa a Eileen', async () => {
  const hoy = new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
  const r = await portal.post('/api/portal/routine-completions', { routineId: rutinaId, completedOn: hoy, completionPercent: 80, durationSeconds: 900 });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  assert.equal(r.datos.duration_seconds, 900);
  const mala = await portal.post('/api/portal/routine-completions', { routineId: rutinaId, completedOn: hoy, completionPercent: 80, durationSeconds: 999999 });
  assert.equal(mala.estado, 400, 'una duración absurda se rechaza');
});

test('oferta por cancelación DEL CLIENTE: cumplida cierra la clase; sin cumplir, pasado el día la clase se da por perdida (cuenta como incumplida). La de Eileen no se pierde sola', async () => {
  const mk = async hora => (await api.post('/api/sessions', { clientId: c, startsAt: hora, durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const sClienteIncumple = await mk(hoyALas23());
  const sEileen = await mk(hoyALas23());
  const sClienteCumple = await mk(hoyALas23());
  const oc = await api.post(`/api/sessions/${sClienteIncumple}/routine-offer`, { routineId: rutinaId, origin: 'client', confirmRepeat: true });
  assert.equal(oc.estado, 201); assert.equal(oc.datos.origin, 'client');
  assert.match((await sesionDe(sClienteIncumple)).notes, /cancelación del cliente.*se da por perdida/);
  assert.equal((await api.post(`/api/sessions/${sEileen}/routine-offer`, { routineId: rutinaId, confirmRepeat: true })).datos.origin, 'trainer', 'por omisión es de Eileen');
  const oCumple = await api.post(`/api/sessions/${sClienteCumple}/routine-offer`, { routineId: rutinaId, origin: 'client', confirmRepeat: true });
  const ofertas = (await portal.get('/api/portal/routine-offers')).datos;
  assert.deepEqual(ofertas.map(o => o.origin).sort(), ['client', 'client', 'trainer']);
  // El cliente cumple una; las otras dos "se quedan sin hacer" y su día pasa.
  assert.equal((await portal.post(`/api/portal/routine-offers/${oCumple.datos.id}/complete`, { completionPercent: 100, durationSeconds: 600 })).datos.sessionCompleted, true);
  const db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  try { await db`UPDATE sessions SET starts_at = now() - interval '30 hours' WHERE id IN ${db([sClienteIncumple, sEileen])}`; } finally { await db.end({ timeout: 1 }).catch(() => {}); }
  const antes = (await api.get('/api/compliance/summary?period=week')).datos.clients.find(x => x.clientId === c)?.missed ?? 0;
  const r = await api.post('/api/maintenance/vencer-ofertas-rutina', {});
  assert.equal(r.datos.perdidas, 1, 'solo la del cliente se da por perdida');
  const perdida = await sesionDe(sClienteIncumple);
  assert.equal(perdida.status, 'cancelled'); assert.equal(perdida.cancelled_by, 'client'); assert.equal(perdida.cancellation_kind, 'not_rescheduled');
  assert.equal(perdida.routine_offer_status, 'expired');
  const despues = (await api.get('/api/compliance/summary?period=week')).datos.clients.find(x => x.clientId === c)?.missed ?? 0;
  assert.equal(despues, antes + 1, 'cuenta como incumplida en el cumplimiento del cliente');
  const deEileen = await sesionDe(sEileen);
  assert.equal(deEileen.status, 'scheduled', 'la clase que Eileen no pudo atender no se pierde sola');
  assert.equal(deEileen.routine_offer_expired, true);
  assert.equal((await api.post('/api/maintenance/vencer-ofertas-rutina', {})).datos.perdidas, 0, 'idempotente');
});

// Van al final a propósito: las reversas modifican/borran la tabla.
test('la reversa de 058 se niega a perder ofertas por cancelación del cliente sin orden expresa, y con la orden deja la tabla como en 057', async () => {
  const archivo = new URL('../migrations-down/058_rutina_origen_cliente.down.sql', import.meta.url).pathname;
  const db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  try {
    assert.ok((await db`SELECT count(*)::int AS n FROM session_routine_offers WHERE origin = 'client'`)[0].n >= 1);
    await assert.rejects(ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]), /ofertas de rutina por cancelación del cliente o vencidas/);
    await ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-c', "SET billing.allow_destructive_down = 'on'", '-f', archivo]);
    assert.equal((await db`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'session_routine_offers' AND column_name = 'origin'`)[0].n, 0);
    assert.equal((await db`SELECT count(*)::int AS n FROM session_routine_offers WHERE status = 'expired'`)[0].n, 0);
  } finally { await db.end({ timeout: 1 }).catch(() => {}); }
});

test('la reversa de 057 se niega a borrar ofertas y duraciones sin orden expresa, y con la orden las quita', async () => {
  const archivo = new URL('../migrations-down/057_rutina_en_lugar_de_clase.down.sql', import.meta.url).pathname;
  const db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  try {
    await assert.rejects(ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]), /hay ofertas de rutina o duraciones guardadas/);
    assert.ok((await db`SELECT count(*)::int AS n FROM session_routine_offers`)[0].n >= 1, 'las ofertas siguen ahí');
    await ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-c', "SET billing.allow_destructive_down = 'on'", '-f', archivo]);
    assert.equal((await db`SELECT to_regclass('session_routine_offers') AS t`)[0].t, null);
  } finally { await db.end({ timeout: 1 }).catch(() => {}); }
});
