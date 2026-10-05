import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor;
let api;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  assert.equal(setup.estado, 201);
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });

after(async () => { await servidor?.parar(); });

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
