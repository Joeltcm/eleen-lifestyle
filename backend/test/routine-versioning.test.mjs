import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor;
let api;
let db;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  assert.equal(setup.estado, 201);
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

const ejercicio = (name, catalogId = undefined) => ({ ...(catalogId ? { catalogId } : {}), name, sets: 3, reps: '10' });

test('cambiar ejercicios de una rutina usada exige confirmación y crea una versión atómica', async () => {
  const clientId = (await api.post('/api/clients', { fullName: 'Cliente de versiones', cutoffDay: 15 })).datos.id;
  const rutina = await api.post('/api/routines', {
    title: 'Rutina con versiones', description: 'Original', sessionsPerWeek: 3, clientId, dueOn: '2026-12-20',
    exercises: [ejercicio('Sentadilla'), ejercicio('Plancha')]
  });
  assert.equal(rutina.estado, 201, JSON.stringify(rutina.datos));
  const sesionRespuesta = await api.post('/api/sessions', { clientId, startsAt: new Date('2026-12-10T09:00:00-05:00').toISOString(), durationMinutes: 45, mode: 'Presencial' });
  assert.equal(sesionRespuesta.estado, 201, JSON.stringify(sesionRespuesta.datos));
  const sesion = sesionRespuesta.datos.id;
  const oferta = await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: rutina.datos.id });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));

  const cambio = { title: 'Rutina con versiones', description: 'Editada', sessionsPerWeek: 3, exercises: [ejercicio('Sentadilla'), ejercicio('Puente') ] };
  const aviso = await api.patch(`/api/routines/${rutina.datos.id}`, cambio);
  assert.equal(aviso.estado, 409, JSON.stringify(aviso.datos));
  assert.equal(aviso.datos.code, 'routine_version_required');
  assert.equal((await db`SELECT count(*)::int AS n FROM routines WHERE root_routine_id = ${rutina.datos.id}`)[0].n, 1, 'la solicitud sin confirmar no deja una versión a medias');

  const versionada = await api.patch(`/api/routines/${rutina.datos.id}`, { ...cambio, confirmVersion: true });
  assert.equal(versionada.estado, 200, JSON.stringify(versionada.datos));
  assert.notEqual(versionada.datos.id, rutina.datos.id);
  assert.equal(versionada.datos.version, 2);
  assert.equal(versionada.datos.supersedes_routine_id, rutina.datos.id);
  const [old] = await db`SELECT archived_at IS NOT NULL AS archived FROM routines WHERE id = ${rutina.datos.id}`;
  assert.equal(old.archived, true);
  assert.equal((await db`SELECT due_on::text AS due FROM routine_assignments WHERE routine_id = ${versionada.datos.id} AND active`)[0].due, '2026-12-20');
  assert.equal((await db`SELECT routine_id FROM session_routine_offers WHERE id = ${oferta.datos.id}`)[0].routine_id, versionada.datos.id, 'la oferta pendiente sigue la versión vigente');
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE routine_id = ${versionada.datos.id} AND kind = 'new_version'`)[0].n, 1);
  assert.equal((await api.get('/api/routines')).datos.some(item => item.id === rutina.datos.id), false, 'la lista normal oculta la versión archivada');
  assert.equal((await api.get(`/api/routines?root=${rutina.datos.id}`)).datos.length, 2, 'el historial por raíz incluye ambas versiones');
});

test('reordenar o cambiar parámetros no crea versión y borrar distingue uso de historial', async () => {
  const clienteNuevo = (await api.post('/api/clients', { fullName: 'Cliente de parámetros', cutoffDay: 1 })).datos.id;
  const rutina = await api.post('/api/routines', { title: 'Sin cambios de conjunto', sessionsPerWeek: 2, clientId: clienteNuevo, exercises: [ejercicio('A'), ejercicio('B')] });
  const editada = await api.patch(`/api/routines/${rutina.datos.id}`, { title: 'Título nuevo', description: 'Nueva nota', sessionsPerWeek: 1, exercises: [{ ...ejercicio('B'), sets: 5 }, { ...ejercicio('A'), reps: '12' }] });
  assert.equal(editada.estado, 200, JSON.stringify(editada.datos));
  assert.equal(editada.datos.id, rutina.datos.id, 'reordenar y editar dosis conserva la versión');
  const archivada = await api.delete(`/api/routines/${rutina.datos.id}`);
  assert.equal(archivada.estado, 200); assert.equal(archivada.datos.archived, true);

  const libre = await api.post('/api/routines', { title: 'Rutina nunca enviada', sessionsPerWeek: 1, exercises: [ejercicio('Libre')] });
  const borrada = await api.delete(`/api/routines/${libre.datos.id}`);
  assert.equal(borrada.estado, 200); assert.equal(borrada.datos.deleted, true);
  assert.equal((await db`SELECT count(*)::int AS n FROM routines WHERE id = ${libre.datos.id}`)[0].n, 0);
});

test('no se puede bifurcar una rutina mientras una clienta la está haciendo hoy', async () => {
  const clientId = (await api.post('/api/clients', { fullName: 'Cliente en entrenamiento', cutoffDay: 1 })).datos.id;
  const rutina = await api.post('/api/routines', { title: 'Rutina iniciada', sessionsPerWeek: 2, clientId, exercises: [ejercicio('A'), ejercicio('B')] });
  await db`INSERT INTO routine_timer_sessions (routine_id, client_id, completed_on, started_at, active) VALUES (${rutina.datos.id}, ${clientId}, (now() AT TIME ZONE 'America/Panama')::date, now(), true)`;
  const cambio = await api.patch(`/api/routines/${rutina.datos.id}`, { title: 'Rutina iniciada', sessionsPerWeek: 2, confirmVersion: true, exercises: [ejercicio('A'), ejercicio('C')] });
  assert.equal(cambio.estado, 409, JSON.stringify(cambio.datos));
  assert.equal(cambio.datos.code, 'routine_version_started');
  assert.equal((await db`SELECT count(*)::int AS n FROM routines WHERE root_routine_id = ${rutina.datos.id}`)[0].n, 1);
});
