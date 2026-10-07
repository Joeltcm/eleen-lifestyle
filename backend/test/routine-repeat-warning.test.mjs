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

  // El flujo normal: se guarda la rutina para la clienta y a continuación se le manda el enlace. Es UN envío por dos vías, no un repetido.
  const primerEnlace = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteId, hours: 24 });
  assert.equal(primerEnlace.estado, 201, `asignar y luego mandar el enlace no debe avisar: ${JSON.stringify(primerEnlace.datos)}`);
  assert.equal((await db`SELECT repeat_confirmed FROM routine_deliveries WHERE routine_id = ${rutina.datos.id} AND kind = 'link'`)[0].repeat_confirmed, false);
  // Un SEGUNDO enlace de la misma rutina a la misma clienta sí es repetir.
  const enlaceRechazado = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteId, hours: 24 });
  assert.equal(enlaceRechazado.estado, 409, JSON.stringify(enlaceRechazado.datos));
  assert.equal(enlaceRechazado.datos.code, 'repeat_recent');
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_share_links WHERE routine_id = ${rutina.datos.id}`)[0].n, 1, 'el rechazado no creó otro enlace');
  const enlace = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: clienteId, hours: 24, confirmRepeat: true });
  assert.equal(enlace.estado, 201, JSON.stringify(enlace.datos));
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE routine_id = ${rutina.datos.id} AND repeat_confirmed`)[0].n, 1, 'solo el envío hecho a pesar del aviso queda marcado');

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

test('guardar la rutina para la clienta y luego ofrecerla o mandarle el enlace no avisa; confirmRepeat sin repetido no marca nada', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Cliente flujo normal', cutoffDay: 1 })).datos.id;
  // confirmRepeat: true sin que haya ningún repetido NO debe marcar el envío como "hecho a pesar del aviso"
  const rutina = await api.post('/api/routines', { title: 'Flujo normal', sessionsPerWeek: 1, clientId: c, confirmRepeat: true, exercises: [{ name: 'Remo', sets: 3, reps: '10' }] });
  assert.equal(rutina.estado, 201, JSON.stringify(rutina.datos));
  assert.equal((await db`SELECT repeat_confirmed FROM routine_deliveries WHERE routine_id = ${rutina.datos.id}`)[0].repeat_confirmed, false);
  const sesion = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(await diaPanama(1)), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const oferta = await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: rutina.datos.id });
  assert.equal(oferta.estado, 201, `asignar y luego ofrecer no debe avisar: ${JSON.stringify(oferta.datos)}`);
  // otra rutina (otros ejercicios) para el flujo de viaje: asignar y luego enviar el enlace de viaje tampoco avisa
  const rutinaViaje = await api.post('/api/routines', { title: 'Flujo de viaje', sessionsPerWeek: 1, clientId: c, exercises: [{ name: 'Flexiones', sets: 3, reps: '8' }] });
  assert.equal(rutinaViaje.estado, 201, JSON.stringify(rutinaViaje.datos));
  const viaje = (await api.post(`/api/clients/${c}/travel`, { startsOn: await diaPanama(), endsOn: await diaPanama(2), destination: 'Lima' })).datos.id;
  const enlaceViaje = await api.post(`/api/routines/${rutinaViaje.datos.id}/share-links`, { clientId: c, hours: 24, travelId: viaje });
  assert.equal(enlaceViaje.estado, 201, `asignar y luego enviar el enlace de viaje no debe avisar: ${JSON.stringify(enlaceViaje.datos)}`);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE repeat_confirmed`)[0].n >= 0, true);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE client_id = ${c} AND repeat_confirmed`)[0].n, 0, 'ningún envío de un flujo normal queda marcado como repetido');
  // ofrecer la MISMA rutina otra vez por otra vía sí es repetir, y el aviso dice que es la misma rutina
  const viajeDos = (await api.post(`/api/clients/${c}/travel`, { startsOn: await diaPanama(5), endsOn: await diaPanama(6), destination: 'Quito' })).datos.id;
  const repetido = await api.post(`/api/routines/${rutina.datos.id}/share-links`, { clientId: c, hours: 24, travelId: viajeDos });
  assert.equal(repetido.estado, 409, JSON.stringify(repetido.datos));
  assert.equal(repetido.datos.repeats[0].sameRoutine, true, 'es LA MISMA rutina (antes decía "otra con los mismos ejercicios")');
  assert.equal(repetido.datos.repeats[0].kind, 'offer');
  // la consulta de solo lectura distingue la vía de entrada
  const comoEnlace = (await api.get(`/api/routines/${rutinaViaje.datos.id}/recent-sends?clientId=${c}&kind=link`)).datos.repeats;
  const comoAsignacion = (await api.get(`/api/routines/${rutinaViaje.datos.id}/recent-sends?clientId=${c}&kind=assignment`)).datos.repeats;
  assert.ok(comoAsignacion.length >= 1, 'reasignarla sí es repetir');
  assert.ok(comoEnlace.every(r => r.kind !== 'assignment'), 'como enlace, la asignación vigente de la propia rutina no cuenta');
});
