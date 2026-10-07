// Casos límite del cierre atómico de la rutina ofrecida (marcar el último ejercicio cierra la clase en la misma transacción).
// La oferta vale SOLO el día de la clase en hora de Panamá, y ese día lo decide el SERVIDOR, no la fecha que mande el teléfono.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let portal; let db; let c;
const panama = (d = 0) => new Date(Date.now() - 5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const alas = (dia, hora) => new Date(`${dia}T${hora}-05:00`).toISOString();

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  c = (await api.post('/api/clients', { fullName: 'Cliente Límites', cutoffDay: 1, email: 'limites@prueba.test' })).datos.id;
  const enlace = await api.post(`/api/clients/${c}/access-link`, {});
  const acceso = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
  portal = cliente(servidor.base); portal.usarToken(acceso.datos.token);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

const rutina = async titulo => (await api.post('/api/routines', { title: titulo, sessionsPerWeek: 1, exercises: [{ name: 'Puente de glúteos', sets: 2, reps: '12' }], clientId: c, confirmRepeat: true })).datos.id;
const hacerRutina = async (routineId, completedOn) => {
  await portal.post('/api/portal/routine-activity', { routineId, completedOn, kind: 'started', elapsedSeconds: 0 });
  return portal.post('/api/portal/routine-exercise-completions', { routineId, completedOn, exerciseIndex: 0, elapsedSeconds: 60 });
};

test('una oferta de una clase de OTRO día no se cierra aunque el teléfono mande la fecha de esa clase como "hoy"', async () => {
  const rid = await rutina('Rutina de pasado mañana');
  const dia = panama(2);
  const sid = (await api.post('/api/sessions', { clientId: c, startsAt: alas(dia, '09:00:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sid}/routine-offer`, { routineId: rid, confirmRepeat: true });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));
  const r = await hacerRutina(rid, dia);
  assert.ok(r.estado < 500, JSON.stringify(r.datos));
  const [s] = await db`SELECT status FROM sessions WHERE id = ${sid}`;
  const [o] = await db`SELECT status FROM session_routine_offers WHERE session_id = ${sid}`;
  assert.equal(s.status, 'scheduled', 'la clase de pasado mañana NO puede darse por realizada hoy');
  assert.equal(o.status, 'offered', 'la oferta sigue sin cumplirse');
});

test('si Eileen ya marcó la clase como realizada, el cliente igual puede terminar su rutina (no se cae con un error)', async () => {
  const rid = await rutina('Rutina con clase ya marcada');
  const sid = (await api.post('/api/sessions', { clientId: c, startsAt: alas(panama(0), '23:00:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sid}/routine-offer`, { routineId: rid, confirmRepeat: true });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));
  await db`UPDATE sessions SET status = 'completed', completion_percent = 100 WHERE id = ${sid}`;   // Eileen la marcó a mano
  const r = await hacerRutina(rid, panama(0));
  assert.equal(r.estado, 201, `la rutina debe quedar registrada: ${JSON.stringify(r.datos)}`);
  assert.equal(r.datos.routineCompleted, true);
  const [rc] = await db`SELECT completion_percent FROM routine_completions WHERE routine_id = ${rid}`;
  assert.equal(rc.completion_percent, 100);
});

test('si Eileen cancela la clase, la rutina del cliente se registra igual y la clase sigue cancelada', async () => {
  const rid = await rutina('Rutina con clase cancelada');
  const sid = (await api.post('/api/sessions', { clientId: c, startsAt: alas(panama(0), '23:30:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sid}/routine-offer`, { routineId: rid, confirmRepeat: true });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));
  await db`UPDATE sessions SET status = 'cancelled' WHERE id = ${sid}`;
  const r = await hacerRutina(rid, panama(0));
  assert.equal(r.estado, 201, `la rutina debe quedar registrada: ${JSON.stringify(r.datos)}`);
  assert.equal((await db`SELECT status FROM sessions WHERE id = ${sid}`)[0].status, 'cancelled');
});
