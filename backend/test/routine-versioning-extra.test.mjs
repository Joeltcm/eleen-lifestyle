// Casos límite de la bifurcación de rutinas: lo que la clienta tiene a medias, lo que apunta a la versión vieja, y los avisos tras bifurcar.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db;
const hoy = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
const aHora = (dia, hora = '09:00') => new Date(`${dia}T${hora}:00-05:00`).toISOString();
const dia = n => new Date(Date.now() - 5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const E = (nombre, extra = {}) => ({ name: nombre, sets: 3, reps: '10', ...extra });

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

async function escenario(nombre, ejercicios = [E('Sentadilla'), E('Plancha'), E('Puente')]) {
  const c = (await api.post('/api/clients', { fullName: nombre, cutoffDay: 1, email: `${nombre.toLowerCase().replace(/\W+/g, '')}@prueba.test` })).datos.id;
  const r = await api.post('/api/routines', { title: `Rutina de ${nombre}`, sessionsPerWeek: 3, clientId: c, exercises: ejercicios });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  const enlace = await api.post(`/api/clients/${c}/access-link`, {});
  const acceso = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
  const portal = cliente(servidor.base); portal.usarToken(acceso.datos.token);
  return { c, r: r.datos, portal };
}
const cambiar = (r, ejercicios, extra = {}) => api.patch(`/api/routines/${r.id}`, { title: r.title, description: r.description || '', sessionsPerWeek: r.sessions_per_week, exercises: ejercicios, ...extra });

test('A) si la clienta empezó la rutina hoy y la PAUSÓ con ejercicios marcados, no se bifurca (perdería su avance)', async () => {
  const { r, portal } = await escenario('Pausada');
  const h = hoy();
  assert.equal((await portal.post('/api/portal/routine-activity', { routineId: r.id, completedOn: h, kind: 'started', elapsedSeconds: 0 })).estado, 201);
  const marcado = await portal.post('/api/portal/routine-exercise-completions', { routineId: r.id, completedOn: h, exerciseIndex: 0, elapsedSeconds: 8 });
  assert.equal(marcado.estado, 201, JSON.stringify(marcado.datos));
  assert.equal((await portal.post('/api/portal/routine-activity', { routineId: r.id, completedOn: h, kind: 'paused', elapsedSeconds: 8 })).estado, 201);
  const cambio = await cambiar(r, [E('Sentadilla'), E('Plancha'), E('Remo')], { confirmVersion: true });
  assert.equal(cambio.estado, 409, `no debe bifurcar con la clienta a medias: ${JSON.stringify(cambio.datos)}`);
  assert.equal(cambio.datos.code, 'routine_version_started');
  assert.equal((await db`SELECT count(*)::int AS n FROM routines WHERE root_routine_id = ${r.id}`)[0].n, 1);
});

test('B) la clase ofrecida sigue la versión nueva: sessions.routine_id y la oferta apuntan a la vigente, y la clienta puede cerrar la clase con la versión nueva', async () => {
  const { c, r, portal } = await escenario('Ofrecida');
  const sesion = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(hoy(), '23:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  assert.equal((await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: r.id })).estado, 201);
  const v2 = await cambiar(r, [E('Sentadilla'), E('Plancha'), E('Remo')], { confirmVersion: true });
  assert.equal(v2.estado, 200, JSON.stringify(v2.datos));
  const [s] = await db`SELECT routine_id FROM sessions WHERE id = ${sesion}`;
  const [o] = await db`SELECT routine_id, status FROM session_routine_offers WHERE session_id = ${sesion}`;
  assert.equal(o.routine_id, v2.datos.id, 'la oferta apunta a la versión nueva'); assert.equal(o.status, 'offered');
  assert.equal(s.routine_id, v2.datos.id, 'la clase (sessions.routine_id) también apunta a la versión vigente, no a la archivada');
  // flujo completo con la versión nueva: iniciar, marcar los 3 ejercicios y la clase queda realizada
  const h = hoy();
  assert.equal((await portal.post('/api/portal/routine-activity', { routineId: v2.datos.id, completedOn: h, kind: 'started', elapsedSeconds: 0 })).estado, 201);
  let ultimo;
  for (let i = 0; i < 3; i += 1) { ultimo = await portal.post('/api/portal/routine-exercise-completions', { routineId: v2.datos.id, completedOn: h, exerciseIndex: i, elapsedSeconds: 30 }); assert.equal(ultimo.estado, 201, JSON.stringify(ultimo.datos)); }
  assert.equal(ultimo.datos.routineCompleted, true); assert.equal(ultimo.datos.offerCompleted, true); assert.equal(ultimo.datos.sessionCompleted, true);
  assert.equal((await db`SELECT status FROM sessions WHERE id = ${sesion}`)[0].status, 'completed');
});

test('C) un enlace emitido antes de bifurcar sigue funcionando con la versión que se envió; el portal solo ve la vigente', async () => {
  const { c, r, portal } = await escenario('Enlace');
  const enlace = await api.post(`/api/routines/${r.id}/share-links`, { clientId: c, hours: 48 });
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));
  const token = String(enlace.datos.url).split('#rutina=')[1];
  const v2 = await cambiar(r, [E('Sentadilla'), E('Plancha'), E('Remo')], { confirmVersion: true });
  assert.equal(v2.estado, 200, JSON.stringify(v2.datos));
  const publica = await cliente(servidor.base).get(`/api/public/routine/${token}`);
  assert.equal(publica.estado, 200, JSON.stringify(publica.datos));
  const nombres = JSON.stringify(publica.datos).includes('Puente');
  assert.equal(nombres, true, 'el enlace muestra lo que se envió (la versión 1)');
  const lista = (await portal.get('/api/portal/summary')).datos.routines;
  assert.equal(lista.length, 1, 'el portal solo ve una rutina'); assert.equal(lista[0].id, v2.datos.id, 'la vigente');
});

test('D) tras bifurcar, "Enviar enlace" de la versión nueva a la misma clienta NO avisa de repetido (ya es la rutina que tiene asignada)', async () => {
  const { c, r } = await escenario('Tras versión');
  const v2 = await cambiar(r, [E('Sentadilla'), E('Plancha'), E('Remo')], { confirmVersion: true });
  assert.equal(v2.estado, 200, JSON.stringify(v2.datos));
  const enlace = await api.post(`/api/routines/${v2.datos.id}/share-links`, { clientId: c, hours: 24 });
  assert.equal(enlace.estado, 201, `mandar el enlace de la rutina vigente, recién versionada, no debe avisar: ${JSON.stringify(enlace.datos)}`);
});

test('E) eliminar una rutina en uso con una oferta pendiente no deja a la clienta con una oferta que no puede completar', async () => {
  const { c, r, portal } = await escenario('Eliminada');
  const sesion = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(hoy(), '23:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  assert.equal((await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: r.id })).estado, 201);
  const borrada = await api.delete(`/api/routines/${r.id}`);
  assert.equal(borrada.estado, 200); assert.equal(borrada.datos.archived, true);
  const ofertas = (await portal.get('/api/portal/routine-offers')).datos;
  assert.deepEqual(ofertas, [], 'la clienta no ve una oferta de una rutina archivada que no podría completar');
  assert.equal((await db`SELECT status FROM session_routine_offers WHERE session_id = ${sesion}`)[0].status, 'withdrawn');
});
