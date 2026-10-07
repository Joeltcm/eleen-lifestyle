import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor;
let api;
let db;

const diasAtras = async (days) => (await db`
  SELECT (((now() AT TIME ZONE 'America/Panama')::date - ${days}::int) + time '12:00') AT TIME ZONE 'America/Panama' AS momento
`)[0].momento;
const diaPanama = async (offset = 0) => (await db`
  SELECT ((now() AT TIME ZONE 'America/Panama')::date + ${offset}::int)::text AS dia
`)[0].dia;
const aHora = (dia, hora = '09:00') => new Date(`${dia}T${hora}:00-05:00`).toISOString();

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  assert.equal(setup.estado, 201);
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('aviso de repetido: misma rutina, contenido, frontera de 30 días y aislamiento por cliente', async () => {
  const clienteA = (await api.post('/api/clients', { fullName: 'Cliente repetido A', cutoffDay: 1 })).datos.id;
  const clienteB = (await api.post('/api/clients', { fullName: 'Cliente repetido B', cutoffDay: 1 })).datos.id;
  const ejercicios = [{ name: 'Sentadilla', sets: 3, reps: '10', weight: '20 lb' }];
  const primera = await api.post('/api/routines', { title: 'Rutina A', description: 'A', sessionsPerWeek: 2, clientId: clienteA, exercises: ejercicios });
  assert.equal(primera.estado, 201, JSON.stringify(primera.datos));
  const primeraEntrega = (await api.get(`/api/routines/${primera.datos.id}/deliveries`)).datos[0];
  await db`UPDATE routine_deliveries SET sent_at = ${await diasAtras(5)} WHERE id = ${primeraEntrega.id}`;

  const consulta = await api.get(`/api/routines/${primera.datos.id}/recent-sends?clientId=${clienteA}`);
  assert.equal(consulta.estado, 200);
  assert.equal(consulta.datos.repeats.length, 1);
  assert.equal(consulta.datos.repeats[0].daysAgo, 5);
  assert.equal(consulta.datos.repeats[0].sameRoutine, true);

  const antes = (await db`SELECT count(*)::int AS n FROM routine_deliveries`)[0].n;
  const repetida = await api.post('/api/routines', { title: 'Rutina A repetida', description: 'A2', sessionsPerWeek: 2, clientId: clienteA, exercises: ejercicios });
  assert.equal(repetida.estado, 409, JSON.stringify(repetida.datos));
  assert.equal(repetida.datos.code, 'repeat_recent');
  assert.equal(repetida.datos.repeats[0].sameRoutine, false);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries`)[0].n, antes, 'un 409 no deja rutina ni envío a medias');

  const confirmada = await api.post('/api/routines', { title: 'Rutina A repetida', description: 'A2', sessionsPerWeek: 2, clientId: clienteA, confirmRepeat: true, exercises: ejercicios });
  assert.equal(confirmada.estado, 201, JSON.stringify(confirmada.datos));
  assert.equal((await db`SELECT repeat_confirmed FROM routine_deliveries WHERE routine_id = ${confirmada.datos.id}`)[0].repeat_confirmed, true);

  const otroCliente = await api.post('/api/routines', { title: 'Rutina A para B', description: 'B', sessionsPerWeek: 2, clientId: clienteB, exercises: ejercicios });
  assert.equal(otroCliente.estado, 201, JSON.stringify(otroCliente.datos));

  const distinta = await api.post('/api/routines', { title: 'Rutina distinta', description: 'D', sessionsPerWeek: 2, clientId: clienteA, exercises: [{ name: 'Plancha', sets: 3, reps: '30 segundos' }] });
  assert.equal(distinta.estado, 201, JSON.stringify(distinta.datos));

  const entregaConfirmada = (await api.get(`/api/routines/${confirmada.datos.id}/deliveries`)).datos[0];
  await db`UPDATE routine_deliveries SET sent_at = ${await diasAtras(30)} WHERE id = ${primeraEntrega.id}`;
  await db`UPDATE routine_deliveries SET sent_at = ${await diasAtras(30)} WHERE id = ${entregaConfirmada.id}`;
  const enTreinta = await api.post('/api/routines', { title: 'Treinta días', description: 'T', sessionsPerWeek: 2, clientId: clienteA, exercises: ejercicios });
  assert.equal(enTreinta.estado, 201, JSON.stringify(enTreinta.datos));
  const entregaTreinta = (await api.get(`/api/routines/${enTreinta.datos.id}/deliveries`)).datos[0];
  await db`UPDATE routine_deliveries SET sent_at = ${await diasAtras(29)} WHERE id = ${entregaTreinta.id}`;
  const enVeintinueve = await api.post('/api/routines', { title: 'Veintinueve días', description: 'V', sessionsPerWeek: 2, clientId: clienteA, exercises: ejercicios });
  assert.equal(enVeintinueve.estado, 409, JSON.stringify(enVeintinueve.datos));
  assert.equal(enVeintinueve.datos.code, 'repeat_recent');
});

test('las vías de enlace, viaje, oferta y reasignación devuelven el mismo aviso y no escriben hasta confirmar', async () => {
  const clienteId = (await api.post('/api/clients', { fullName: 'Cliente vías repetidas', cutoffDay: 1 })).datos.id;
  const rutina = await api.post('/api/routines', { title: 'Rutina de todas las vías', description: 'Vías', sessionsPerWeek: 1, clientId: clienteId, exercises: [{ name: 'Puente', reps: '12' }] });
  assert.equal(rutina.estado, 201);

  const enlaceRechazado = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteId, hours: 24 });
  assert.equal(enlaceRechazado.estado, 409, JSON.stringify(enlaceRechazado.datos));
  assert.equal(enlaceRechazado.datos.code, 'repeat_recent');
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_share_links WHERE routine_id = ${rutina.datos.id}`)[0].n, 0);
  const enlace = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteId, hours: 24, confirmRepeat: true });
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));

  const viaje = (await api.post(`/api/clients/${clienteId}/travel`, { startsOn: await diaPanama(), endsOn: await diaPanama(2), destination: 'Madrid' })).datos.id;
  const viajeRechazado = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteId, hours: 24, travelId: viaje });
  assert.equal(viajeRechazado.estado, 409, JSON.stringify(viajeRechazado.datos));
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_share_links WHERE travel_id = ${viaje}`)[0].n, 0);
  const enlaceViaje = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteId, hours: 24, travelId: viaje, confirmRepeat: true });
  assert.equal(enlaceViaje.estado, 201, JSON.stringify(enlaceViaje.datos));

  const sesion = (await api.post('/api/sessions', { clientId: clienteId, startsAt: aHora(await diaPanama(1)), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const ofertaRechazada = await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: rutina.datos.id });
  assert.equal(ofertaRechazada.estado, 409, JSON.stringify(ofertaRechazada.datos));
  assert.equal((await db`SELECT count(*)::int AS n FROM session_routine_offers WHERE session_id = ${sesion}`)[0].n, 0);
  const oferta = await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: rutina.datos.id, confirmRepeat: true });
  assert.equal(oferta.estado, 201, JSON.stringify(oferta.datos));

  const reasignada = await api.patch(`/api/routines/${rutina.datos.id}`, {
    title: 'Rutina de todas las vías', description: 'Vías', sessionsPerWeek: 1,
    clientId: clienteId, exercises: rutina.datos.exercises
  });
  assert.equal(reasignada.estado, 409, JSON.stringify(reasignada.datos));
  assert.equal(reasignada.datos.code, 'repeat_recent');
  const confirmada = await api.patch(`/api/routines/${rutina.datos.id}`, {
    title: 'Rutina de todas las vías', description: 'Vías', sessionsPerWeek: 1,
    clientId: clienteId, confirmRepeat: true, exercises: rutina.datos.exercises
  });
  assert.equal(confirmada.estado, 200, JSON.stringify(confirmada.datos));
});
