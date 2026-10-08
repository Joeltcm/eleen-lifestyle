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
  assert.doesNotMatch(texto.split('Bloque 2')[0], /series/, 'dentro de un bloque no se repiten las series: son las rondas del encabezado');
  assert.match(texto, /Sentadilla Goblet — 15/);
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

  const enlace = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteB, hours: 24, confirmRepeat: true });
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));
  const viaje = (await api.post(`/api/clients/${clienteB}/travel`, { startsOn: panama(), endsOn: panama(2), destination: 'Madrid' })).datos.id;
  const enlaceViaje = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteB, hours: 48, travelId: viaje, confirmRepeat: true });
  assert.equal(enlaceViaje.estado, 201, JSON.stringify(enlaceViaje.datos));

  const sesion = (await api.post('/api/sessions', { clientId: clienteB, startsAt: aHora(panama(1), '09:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: rutina.datos.id, confirmRepeat: true });
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
  assert.ok((await api.get(`/api/clients/${clienteB}/routine-deliveries`)).datos.length >= 3, 'asignación y enlace del mismo día forman una sola tarjeta; oferta y viaje permanecen separados');
});

test('el expediente agrupa asignación y enlace del mismo día y atribuye la cumplida al grupo', async () => {
  const clienteC = (await api.post('/api/clients', { fullName: 'Cliente de grupo', cutoffDay: 1 })).datos.id;
  const rutina = (await api.post('/api/routines', {
    title: 'Rutina agrupada', description: 'Prueba de historial', sessionsPerWeek: 1,
    exercises: [{ name: 'Sentadilla', sets: 3, reps: '10' }]
  })).datos;
  const [owner] = await db`SELECT id FROM users LIMIT 1`;
  const primerDia = panama(-3); const segundoDia = panama(-2);
  const vencePrimero = panama(1); const venceSegundo = panama(2);
  const insertar = async ({ kind, sentAt, dueOn, backfilled = false }) => db`
    INSERT INTO routine_deliveries (
      owner_id, routine_id, client_id, kind, sent_at, due_on, routine_title, routine_version,
      client_name, summary_text, exercises_snapshot, backfilled
    ) VALUES (
      ${owner.id}, ${rutina.id}, ${clienteC}, ${kind}, ${sentAt}::timestamptz, ${dueOn}::date,
      'Rutina agrupada', 1, 'Cliente de grupo', 'Rutina agrupada\\nSentadilla — 10',
      ${db.json([{ name: 'Sentadilla', reps: '10' }])}, ${backfilled}
    ) RETURNING id
  `;
  await insertar({ kind: 'link', sentAt: aHora(primerDia, '09:00'), dueOn: vencePrimero });
  await insertar({ kind: 'assignment', sentAt: aHora(primerDia, '12:00'), dueOn: vencePrimero, backfilled: true });
  await insertar({ kind: 'assignment', sentAt: aHora(segundoDia, '10:00'), dueOn: venceSegundo, backfilled: true });
  await insertar({ kind: 'offer', sentAt: aHora(primerDia, '08:00'), dueOn: vencePrimero });
  await db`
    INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent, marked_by_user_id, created_at)
    VALUES (${rutina.id}, ${clienteC}, ${primerDia}::date, 100, ${owner.id}, ${aHora(primerDia, '10:30')}::timestamptz)
  `;

  const historial = (await api.get(`/api/clients/${clienteC}/routine-deliveries`)).datos;
  assert.equal(historial.length, 3, 'la asignación y el enlace se presentan como una sola tarjeta');
  const unido = historial.find(item => item.kind === 'assignment_link');
  assert.ok(unido, 'la etiqueta de la tarjeta unida existe');
  assert.equal(unido.sent_approx, false, 'un envío real evita mostrar la hora inventada del relleno');
  assert.equal(new Date(unido.sent_at).toISOString(), new Date(aHora(primerDia, '09:00')).toISOString(), 'se conserva la hora real del enlace');
  assert.equal(unido.completed, true, 'la cumplida se atribuye al grupo del primer envío');
  assert.equal(historial.filter(item => item.kind === 'assignment').length, 1, 'otro día queda separado');
  assert.equal(historial.filter(item => item.kind === 'offer').length, 1, 'las ofertas nunca se unen');
  assert.equal(historial.find(item => item.kind === 'assignment')?.completed, false, 'la tarjeta posterior no hereda la cumplida anterior');
});

test('la reversa de 063 se niega a destruir el registro sin orden expresa', async () => {
  const archivo = new URL('../migrations-down/063_routine_deliveries_and_versions.down.sql', import.meta.url).pathname;
  await assert.rejects(
    ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]),
    /billing\.allow_destructive_down|orden expresa/i
  );
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries`)[0].n > 0, true, 'la reversa protegida no toca el registro');
});
