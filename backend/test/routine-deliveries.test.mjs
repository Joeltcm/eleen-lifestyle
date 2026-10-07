import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';
import { routineSummaryText } from '../dist/routine-utils.js';

let servidor;
let api;
let db;
const ejecutar = promisify(execFile);
const panama = (delta = 0) => new Date(Date.now() - 5 * 3600_000 + delta * 86400_000).toISOString().slice(0, 10);
const aHora = (dia, hora) => new Date(`${dia}T${hora}:00-05:00`).toISOString();

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  assert.equal(setup.estado, 201);
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('routineSummaryText conserva bloques, rondas, texto libre, peso y notas', () => {
  const texto = routineSummaryText({
    title: 'Piernas intensas', version: 2, sessionsPerWeek: 1, dueOn: '2026-10-11',
    exercises: [
      { name: 'Sentadilla Goblet', sets: 3, reps: '15', weight: '15 lb', block: 1, rounds: 3 },
      { name: 'Zancada', reps: '12 por pierna', weight: '10 lbs por mano', block: 1, rounds: 3, notes: 'Rodilla alineada' },
      { name: 'Puente', reps: '20', weight: 'liga heavy' }
    ]
  });
  assert.match(texto, /Piernas intensas \(v2\) · 3 ejercicios · 1 sesión por semana/);
  assert.match(texto, /Fecha límite: 11-10-2026/);
  assert.match(texto, /Bloque 1 · 3 rondas/);
  assert.match(texto, /3 series × 15/);
  assert.match(texto, /12 por pierna · peso 10 lbs por mano/);
  assert.match(texto, /Nota: Rodilla alineada/);
  assert.match(texto, /Puente — 20 · peso liga heavy/);
});

test('las cinco vías de entrega registran instantáneas y el resumen no cambia al editar', async () => {
  const clienteA = (await api.post('/api/clients', { fullName: 'Cliente de envíos', cutoffDay: 1 })).datos.id;
  const clienteB = (await api.post('/api/clients', { fullName: 'Cliente reasignado', cutoffDay: 1 })).datos.id;
  const rutina = await api.post('/api/routines', {
    title: 'Rutina enviada', description: 'Texto de prueba', sessionsPerWeek: 1,
    clientId: clienteA, dueOn: '2026-10-11',
    exercises: [{ name: 'Sentadilla', sets: 3, reps: '10', weight: '20 lb', notes: 'Controlar bajada' }]
  });
  assert.equal(rutina.estado, 201, JSON.stringify(rutina.datos));

  let entregas = (await api.get(`/api/routines/${rutina.datos.id}/deliveries`)).datos;
  assert.equal(entregas.length, 1);
  assert.equal(entregas[0].kind, 'assignment');
  assert.equal(entregas[0].client_name, 'Cliente de envíos');
  assert.match(entregas[0].summary_text, /20 lb/);
  const resumenOriginal = entregas[0].summary_text;

  const reasignada = await api.patch(`/api/routines/${rutina.datos.id}`, {
    title: 'Rutina enviada', description: 'Texto de prueba', sessionsPerWeek: 1,
    clientId: clienteB, dueOn: '2026-10-12', exercises: rutina.datos.exercises
  });
  assert.equal(reasignada.estado, 200, JSON.stringify(reasignada.datos));
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE kind = 'assignment'`)[0].n, 2);

  const enlace = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteB, hours: 24 });
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));
  const viaje = (await api.post(`/api/clients/${clienteB}/travel`, { startsOn: panama(), endsOn: panama(2), destination: 'Madrid' })).datos.id;
  const enlaceViaje = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteB, hours: 48, travelId: viaje });
  assert.equal(enlaceViaje.estado, 201, JSON.stringify(enlaceViaje.datos));

  const sesion = (await api.post('/api/sessions', { clientId: clienteB, startsAt: aHora(panama(1), '09:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: rutina.datos.id });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));

  entregas = (await api.get(`/api/routines/${rutina.datos.id}/deliveries`)).datos;
  assert.deepEqual(entregas.map(item => item.kind).sort(), ['assignment', 'assignment', 'link', 'offer', 'travel_link'].sort());
  assert.ok(entregas.every(item => item.exercises_snapshot[0].weight === '20 lb'));

  const editada = await api.patch(`/api/routines/${rutina.datos.id}`, {
    title: 'Rutina enviada', description: 'Texto de prueba', sessionsPerWeek: 1,
    exercises: [{ name: 'Sentadilla', sets: 5, reps: '12', weight: '35 lb', notes: 'Otra nota' }]
  });
  assert.equal(editada.estado, 200);
  entregas = (await api.get(`/api/routines/${rutina.datos.id}/deliveries`)).datos;
  assert.equal(entregas.find(item => item.client_name === 'Cliente de envíos').summary_text, resumenOriginal, 'el primer resumen es una foto del envío');
  assert.ok(entregas.every(item => item.summary_text.includes('20 lb') && !item.summary_text.includes('35 lb')), 'los resúmenes no se recalculan con la edición');
  assert.ok((await api.get(`/api/clients/${clienteB}/routine-deliveries`)).datos.length >= 4);
});

test('la reversa de 063 se niega a destruir el registro sin orden expresa', async () => {
  const archivo = new URL('../migrations-down/063_routine_deliveries_and_versions.down.sql', import.meta.url).pathname;
  await assert.rejects(
    ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]),
    /billing\.allow_destructive_down|orden expresa/i
  );
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries`)[0].n > 0, true, 'la reversa protegida no toca el registro');
});
