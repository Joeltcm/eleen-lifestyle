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

test('editar ejercicios conserva la asignación y permite dejar nuevos ejercicios fuera de bloques', async () => {
  const clienteCreado = await api.post('/api/clients', { fullName: 'Cliente de edición de rutina', cutoffDay: 1 });
  assert.equal(clienteCreado.estado, 201);

  const rutina = await api.post('/api/routines', {
    title: 'Rutina editable', description: 'Prueba de edición', sessionsPerWeek: 3,
    clientId: clienteCreado.datos.id,
    exercises: [
      { name: 'Sentadilla', sets: 3, reps: '10', block: 1, rounds: 3 },
      { name: 'Plancha', sets: 3, reps: '30 s', block: 1, rounds: 3 }
    ]
  });
  assert.equal(rutina.estado, 201);

  const editada = await api.patch(`/api/routines/${rutina.datos.id}`, {
    title: 'Rutina editable', description: 'Prueba de edición', sessionsPerWeek: 3,
    exercises: [
      { name: 'Sentadilla', sets: 3, reps: '10', block: 1, rounds: 3 },
      { name: 'Puente de glúteo', sets: 3, reps: '12' }
    ]
  });
  assert.equal(editada.estado, 200);

  const rutinas = await api.get('/api/routines');
  const guardada = rutinas.datos.find(item => item.id === rutina.datos.id);
  assert.deepEqual(guardada.assigned_client_ids, [clienteCreado.datos.id]);
  assert.equal(guardada.exercises[1].name, 'Puente de glúteo');
  assert.equal(guardada.exercises[1].block, undefined);
});

test('editar fecha límite distingue omitida, nueva y nula, sólo toca asignaciones activas y exige asignación', async () => {
  const clienteA = await api.post('/api/clients', { fullName: 'Cliente con fecha activa', cutoffDay: 1 });
  const clienteB = await api.post('/api/clients', { fullName: 'Cliente nuevo de rutina', email: 'cliente.nuevo.rutina@prueba.test', cutoffDay: 1 });
  const rutina = await api.post('/api/routines', {
    title: 'Rutina con vencimiento', description: 'Fecha editable', sessionsPerWeek: 3,
    clientId: clienteA.datos.id, dueOn: '2026-09-15', exercises: [{ name: 'Sentadilla', sets: 3, reps: '10' }]
  });
  assert.equal(rutina.estado, 201);
  const base = { title: 'Rutina con vencimiento', description: 'Fecha editable', sessionsPerWeek: 3, exercises: rutina.datos.exercises };

  const omitida = await api.patch(`/api/routines/${rutina.datos.id}`, base);
  assert.equal(omitida.estado, 200);
  assert.equal((await db`SELECT due_on::text AS due FROM routine_assignments WHERE routine_id = ${rutina.datos.id} AND active`)[0].due, '2026-09-15');

  const nueva = await api.patch(`/api/routines/${rutina.datos.id}`, { ...base, dueOn: '2026-10-20' });
  assert.equal(nueva.estado, 200);
  assert.equal((await db`SELECT due_on::text AS due FROM routine_assignments WHERE routine_id = ${rutina.datos.id} AND active`)[0].due, '2026-10-20');

  const reasignada = await api.patch(`/api/routines/${rutina.datos.id}`, { ...base, clientId: clienteB.datos.id, dueOn: '2026-11-05' });
  assert.equal(reasignada.estado, 200);
  const historico = await db`SELECT client_id, active, ends_on::text AS ends, due_on::text AS due FROM routine_assignments WHERE routine_id = ${rutina.datos.id} ORDER BY starts_on`;
  assert.equal(historico.length, 2);
  assert.equal(historico[0].active, false);
  assert.equal(historico[0].due, '2026-10-20', 'la asignación inactiva conserva su fecha histórica');
  assert.equal(historico[1].active, true);
  assert.equal(historico[1].due, '2026-11-05');
  const enlace = await api.post(`/api/clients/${clienteB.datos.id}/access-link`, {});
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));
  const acceso = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
  assert.equal(acceso.estado, 200, JSON.stringify(acceso.datos));
  const portal = cliente(servidor.base); portal.usarToken(acceso.datos.token);
  const resumenPortal = await portal.get('/api/portal/summary');
  assert.equal(resumenPortal.estado, 200, JSON.stringify(resumenPortal.datos));
  assert.ok(Array.isArray(resumenPortal.datos.routines), `el portal debe devolver rutinas: ${JSON.stringify(Object.keys(resumenPortal.datos))}`);
  const portalRutina = resumenPortal.datos.routines.find(item => item.id === rutina.datos.id);
  assert.equal(String(portalRutina.due_on).slice(0, 10), '2026-11-05', 'el portal devuelve la fecha nueva');

  const borrada = await api.patch(`/api/routines/${rutina.datos.id}`, { ...base, dueOn: null });
  assert.equal(borrada.estado, 200);
  assert.equal((await db`SELECT due_on FROM routine_assignments WHERE routine_id = ${rutina.datos.id} AND active`)[0].due_on, null);

  const invalida = await api.patch(`/api/routines/${rutina.datos.id}`, { ...base, dueOn: '31-12-2026' });
  assert.equal(invalida.estado, 400);

  const sinAsignar = await api.post('/api/routines', { title: 'Rutina sin asignación', sessionsPerWeek: 2, exercises: [{ name: 'Plancha' }] });
  const conflicto = await api.patch(`/api/routines/${sinAsignar.datos.id}`, { title: 'Rutina sin asignación', sessionsPerWeek: 2, exercises: sinAsignar.datos.exercises, dueOn: '2026-12-01' });
  assert.equal(conflicto.estado, 409);
  assert.match(conflicto.datos.error, /Asigna la rutina/);

  const inexistente = await api.patch('/api/routines/00000000-0000-0000-0000-000000000000', { ...base, dueOn: '2026-12-01' });
  assert.equal(inexistente.estado, 404);
});
