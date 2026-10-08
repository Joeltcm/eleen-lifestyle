// El expediente de Eileen agrupa asignación+enlace, pero NO debe perder las filas "Nueva versión" (rastro de cuándo se modificó una rutina) ni cortar la atribución de lo cumplido.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db;
const E = n => ({ name: n, sets: 3, reps: '10' });
before(async () => {
  servidor = await levantar(); api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const s = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN }); api.usarToken(s.datos.token);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('al modificar una rutina enviada, el expediente sigue mostrando la fila "Nueva versión" junto a la asignación', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Con versiones', cutoffDay: 1, email: 'cv@prueba.test' })).datos.id;
  const r = (await api.post('/api/routines', { title: 'Rutina versionada', sessionsPerWeek: 1, clientId: c, exercises: [E('A'), E('B')] })).datos;
  assert.equal((await api.patch(`/api/routines/${r.id}`, { title: 'Rutina versionada', sessionsPerWeek: 1, confirmVersion: true, exercises: [E('A'), E('C')] })).estado, 200);
  const lista = (await api.get(`/api/clients/${c}/routine-deliveries`)).datos;
  assert.deepEqual(lista.map(x => [x.kind, Number(x.routine_version)]).sort(), [['assignment', 1], ['new_version', 2]], JSON.stringify(lista.map(x => x.kind)));
});

test('una fila "Nueva versión" entre el envío y la cumplida no le quita la cumplida al envío', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Cumple tras versión', cutoffDay: 1, email: 'ctv@prueba.test' })).datos.id;
  const r = (await api.post('/api/routines', { title: 'Rutina que cumple', sessionsPerWeek: 1, clientId: c, exercises: [E('A'), E('B')] })).datos;
  const [{ id: dueno }] = await db`SELECT id FROM users LIMIT 1`;
  await api.patch(`/api/routines/${r.id}`, { title: 'Rutina que cumple', sessionsPerWeek: 1, confirmVersion: true, exercises: [E('A'), E('C')] });
  await db`INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent, marked_by_user_id) VALUES (${r.id}, ${c}, (now() AT TIME ZONE 'America/Panama')::date, 100, ${dueno})`;
  const lista = (await api.get(`/api/clients/${c}/routine-deliveries`)).datos;
  const asignacion = lista.find(x => x.kind === 'assignment');
  assert.ok(asignacion, 'la asignación sigue en la lista');
  assert.equal(asignacion.completed, true, 'la cumplida se atribuye a la asignación aunque haya una fila de versión nueva después');
});
