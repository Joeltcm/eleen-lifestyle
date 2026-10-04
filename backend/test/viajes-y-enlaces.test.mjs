// Cliente de viaje + rutina por enlace temporal (J-107). El viaje no pausa nada; confirmar la rutina el día de la clase la cuenta; sin confirmar equivale a una cancelación del cliente.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);
let servidor; let api; let publico; let db; let c; let rutina;
const panama = (delta = 0) => new Date(Date.now() - 5 * 3600_000 + delta * 86400_000).toISOString().slice(0, 10);
const aHora = (dia, hora) => new Date(`${dia}T${hora}:00-05:00`).toISOString();
const sesionDe = async id => (await api.get('/api/sessions')).datos.find(x => x.id === id);
const tokenDe = url => String(url).split('#rutina=')[1];

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base); publico = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  c = (await api.post('/api/clients', { fullName: 'Sara Viajera', cutoffDay: 1, email: 'sara.viaje@prueba.test' })).datos.id;
  rutina = (await api.post('/api/routines', { title: 'Rutina de viaje', description: 'Sin equipo.', sessionsPerWeek: 3, exercises: [{ name: 'Plancha', sets: 3, reps: '30 seg' }], clientId: c })).datos.id;
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('viajes: se marcan con fechas (regreso opcional), no se traslapan y se editan o borran; no tocan plan ni estado del cliente', async () => {
  assert.equal((await api.post(`/api/clients/${c}/travel`, { startsOn: '2026-11-10', endsOn: '2026-11-01' })).estado, 400, 'regreso antes de la salida');
  const v = await api.post(`/api/clients/${c}/travel`, { startsOn: '2026-11-10', endsOn: '2026-11-20', destination: 'Madrid' });
  assert.equal(v.estado, 201, JSON.stringify(v.datos));
  assert.equal(v.datos.starts_on, '2026-11-10');
  assert.equal((await api.post(`/api/clients/${c}/travel`, { startsOn: '2026-11-15', endsOn: null })).estado, 409, 'traslape');
  assert.equal((await api.post(`/api/clients/${c}/travel`, { startsOn: '2026-12-01', endsOn: null })).estado, 201, 'sin regreso definido');
  assert.equal((await api.patch(`/api/travel/${v.datos.id}`, { startsOn: '2026-11-10', endsOn: '2026-11-18', destination: 'Madrid' })).datos.ends_on, '2026-11-18');
  assert.equal((await api.get('/api/travel')).datos.filter(x => x.client_id === c).length, 2);
  const lista = await api.get(`/api/clients/${c}/travel`);
  assert.equal(lista.datos.length, 2);
  assert.equal((await api.delete(`/api/travel/${lista.datos.find(x => x.ends_on === null).id}`)).estado, 200);
  const clientes = (await api.get('/api/clients')).datos.find(x => x.id === c);
  assert.equal(clientes.status, 'active', 'viajar no cambia el estado del cliente');
  await api.delete(`/api/travel/${v.datos.id}`);
});

test('enlace temporal: vigencia configurable, solo rutinas asignadas, sin datos del cliente, revocable y que vence', async () => {
  const otra = (await api.post('/api/routines', { title: 'Sin asignar', sessionsPerWeek: 1, exercises: [] })).datos.id;
  assert.equal((await api.post(`/api/routines/${otra}/share-links`, { clientId: c, hours: 24 })).estado, 409, 'la rutina debe estar asignada al cliente');
  assert.equal((await api.post(`/api/routines/${rutina}/share-links`, { clientId: c })).estado, 400, 'falta la vigencia');
  assert.equal((await api.post(`/api/routines/${rutina}/share-links`, { clientId: c, hours: 24, until: panama(3) })).estado, 400, 'o horas o fecha, no ambas');
  assert.equal((await api.post(`/api/routines/${rutina}/share-links`, { clientId: c, until: panama(-2) })).estado, 400, 'una fecha pasada no sirve');
  assert.equal((await api.post(`/api/routines/${rutina}/share-links`, { clientId: c, hours: 24 * 120 })).estado, 400, 'máximo 90 días');
  const e = await api.post(`/api/routines/${rutina}/share-links`, { clientId: c, hours: 48 });
  assert.equal(e.estado, 201, JSON.stringify(e.datos));
  assert.match(e.datos.url, /#rutina=[A-Za-z0-9_-]{40,}$/);
  const token = tokenDe(e.datos.url);
  const guardado = await db`SELECT token_hash FROM routine_share_links WHERE id = ${e.datos.id}`;
  assert.notEqual(guardado[0].token_hash, token, 'el token no se guarda, solo su hash');
  const vista = await publico.get(`/api/public/routine/${token}`);
  assert.equal(vista.estado, 200, JSON.stringify(vista.datos));
  assert.equal(vista.datos.clientFirstName, 'Sara');
  assert.equal(vista.datos.routine.title, 'Rutina de viaje');
  assert.ok(!JSON.stringify(vista.datos).includes('sara.viaje@prueba.test'), 'no expone datos del cliente');
  assert.equal((await publico.get('/api/public/routine/' + 'x'.repeat(43))).estado, 404);
  const lista = await api.get(`/api/clients/${c}/share-links`);
  assert.equal(lista.datos[0].active, true); assert.ok(lista.datos[0].opens >= 1);
  assert.equal((await api.delete(`/api/share-links/${e.datos.id}`)).estado, 200);
  const revocado = await publico.get(`/api/public/routine/${token}`);
  assert.equal(revocado.estado, 410); assert.match(revocado.datos.error, /retiró/);
  const f = await api.post(`/api/routines/${rutina}/share-links`, { clientId: c, until: panama(2) });
  assert.equal(f.estado, 201);
  await db`UPDATE routine_share_links SET expires_at = now() - interval '1 minute' WHERE id = ${f.datos.id}`;
  const vencido = await publico.get(`/api/public/routine/${tokenDe(f.datos.url)}`);
  assert.equal(vencido.estado, 410); assert.match(vencido.datos.error, /venció/);
});

test('confirmar la rutina por enlace el día de la clase en viaje la cuenta como clase; sin viaje solo queda como rutina cumplida; avisa a Eileen', async () => {
  const hoy = panama();
  const viaje = (await api.post(`/api/clients/${c}/travel`, { startsOn: hoy, endsOn: panama(10) })).datos.id;
  const clase = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(hoy, '23:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const avisosViaje = (await api.get('/api/notifications')).datos.filter(a => a.type === 'travel');
  assert.ok(avisosViaje.some(a => a.travelId === viaje), 'sin rutina enviada, Eileen recibe el aviso de viaje');
  const e = await api.post(`/api/routines/${rutina}/share-links`, { clientId: c, until: panama(10), travelId: viaje });
  assert.equal((await api.get('/api/notifications')).datos.filter(a => a.type === 'travel').length, 0, 'con una rutina enviada el aviso desaparece');
  const token = tokenDe(e.datos.url);
  const vista = await publico.get(`/api/public/routine/${token}`);
  assert.ok(vista.datos.classes.some(x => x.dia === hoy && x.hora === '23:00'), 'el cliente ve la clase de hoy del viaje');
  const r = await publico.post(`/api/public/routine/${token}/complete`, { completionPercent: 100, durationSeconds: 1200 });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.sessionCompleted, true);
  assert.equal((await sesionDe(clase)).status, 'completed');
  const segunda = await publico.post(`/api/public/routine/${token}/complete`, { completionPercent: 100 });
  assert.equal(segunda.datos.sessionCompleted, false, 'la segunda confirmación del día no cierra otra clase');
  const aviso = (await api.get('/api/notifications')).datos.filter(a => a.type === 'routine');
  assert.equal(aviso.length, 1); assert.match(aviso[0].title, /Sara Viajera/);
  assert.equal((await publico.post(`/api/public/routine/${token}/complete`, { completionPercent: 0 })).estado, 400);
  // Sin viaje ese día, la confirmación no cierra ninguna clase.
  await api.delete(`/api/travel/${viaje}`);
  const otraClase = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(panama(1), '10:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  await db`DELETE FROM routine_completions WHERE client_id = ${c}`;
  const sinViaje = await publico.post(`/api/public/routine/${token}/complete`, { completionPercent: 100 });
  assert.equal(sinViaje.datos.sessionCompleted, false);
  assert.equal((await sesionDe(otraClase)).status, 'scheduled');
});

test('clase de un día de viaje sin rutina confirmada se CANCELA sola (cancelación del cliente, incumplida) y queda justificada con el viaje; no si confirmó; con o sin enlace enviado', async () => {
  const cc = (await api.post('/api/clients', { fullName: 'Pedro Viajero', cutoffDay: 1, email: 'pedro.viaje@prueba.test' })).datos.id;
  const rr = (await api.post('/api/routines', { title: 'Viaje Pedro', sessionsPerWeek: 3, exercises: [{ name: 'Sentadilla', sets: 3, reps: '12' }], clientId: cc })).datos.id;
  const hace4 = panama(-4); const hace3 = panama(-3); const hace2 = panama(-2); const hace1 = panama(-1);
  const viaje = (await api.post(`/api/clients/${cc}/travel`, { startsOn: hace4, endsOn: panama(5), destination: 'Lisboa' })).datos.id;
  // clases: hace 4 días (sin ningún enlace aún), hace 3 (sin confirmar), hace 2 (CONFIRMÓ por enlace), ayer (sin confirmar) y mañana (aún no)
  const crear = async dia => (await api.post('/api/sessions', { clientId: cc, startsAt: aHora(dia, '09:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  const s4 = await crear(hace4); const s3 = await crear(hace3); const s2 = await crear(hace2); const s1 = await crear(hace1); const manana = await crear(panama(1));
  const enlace = (await api.post(`/api/routines/${rr}/share-links`, { clientId: cc, until: panama(5), travelId: viaje })).datos.id;
  // El viaje se registró hace 4 días (sin esto, "nunca hacia atrás" protegería todas las clases).
  await db`UPDATE client_travel SET created_at = now() - interval '4 days' WHERE id = ${viaje}`;
  await db`UPDATE routine_share_links SET created_at = now() - interval '3 days' WHERE id = ${enlace}`;
  await db`INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent, via_link) VALUES (${rr}, ${cc}, ${hace2}::date, 100, true)`;
  const r = await api.post('/api/maintenance/vencer-ofertas-rutina', {});
  assert.equal(r.estado, 200); assert.equal(r.datos.porViaje, 3, 'hace 4 días (sin enlace), hace 3 y ayer');
  for (const [id, esperado] of [[s4, 'cancelled'], [s3, 'cancelled'], [s1, 'cancelled'], [s2, 'scheduled'], [manana, 'scheduled']]) assert.equal((await sesionDe(id)).status, esperado);
  const perdida = await sesionDe(s3);
  assert.equal(perdida.cancelled_by, 'client'); assert.equal(perdida.cancellation_kind, 'not_rescheduled');
  assert.equal(perdida.cancelled_travel_id, viaje, 'ligada al viaje que la justifica');
  assert.match(perdida.cancellation_reason, /de viaje del \d{2}-\d{2}-\d{4} al \d{2}-\d{2}-\d{4} · Lisboa/);
  assert.match(perdida.notes, /Cancelada automáticamente por viaje del cliente/);
  const resumen = (await api.get('/api/compliance/summary?period=week')).datos.clients.find(x => x.clientId === cc);
  assert.equal(resumen.missed, 3, 'cuentan como incumplidas en su cumplimiento');
  assert.equal((await api.get(`/api/clients/${cc}/travel`)).datos[0].cancelled_sessions, 3, 'el viaje muestra cuántas cancelaciones justificó');
  assert.equal((await api.post('/api/maintenance/vencer-ofertas-rutina', {})).datos.porViaje, 0, 'idempotente');
  // El viaje es el registro: mientras justifique cancelaciones no se puede quitar.
  const intento = await api.delete(`/api/travel/${viaje}`);
  assert.equal(intento.estado, 409); assert.match(intento.datos.error, /justificó 3 cancelaciones/);
  assert.equal((await api.get(`/api/clients/${cc}/travel`)).datos.length, 1);
});

test('viaje registrado después: nunca cancela clases de días anteriores a su registro; un cliente sin ningún enlace enviado igual pierde sus clases de viaje', async () => {
  const cc = (await api.post('/api/clients', { fullName: 'Lucia Retro', cutoffDay: 1 })).datos.id;
  const viaje = (await api.post(`/api/clients/${cc}/travel`, { startsOn: panama(-3), endsOn: panama(3) })).datos.id;
  const clase = (await api.post('/api/sessions', { clientId: cc, startsAt: aHora(panama(-1), '09:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  assert.equal((await api.post('/api/maintenance/vencer-ofertas-rutina', {})).datos.porViaje, 0, 'registrado hoy: ayer es retroactivo y no se cancela');
  assert.equal((await sesionDe(clase)).status, 'scheduled');
  await db`UPDATE client_travel SET created_at = now() - interval '5 days' WHERE id = ${viaje}`;
  assert.equal((await api.post('/api/maintenance/vencer-ofertas-rutina', {})).datos.porViaje, 1, 'sin acción (nunca se le envió rutina) la clase se cancela sola');
  const cancelada = await sesionDe(clase);
  assert.equal(cancelada.status, 'cancelled'); assert.equal(cancelada.cancelled_travel_id, viaje);
  assert.match(cancelada.cancellation_reason, /No confirmó una rutina ese día/);
});

test('los bloques de una rutina (bloque y rondas por ejercicio) se guardan, se devuelven y viajan en la página pública del enlace', async () => {
  const ejercicios = [1, 2, 3, 4, 5, 6].map(n => ({ name: `Ejercicio ${n}`, reps: '12', sets: 3, block: n <= 3 ? 1 : 2, rounds: 3 }));
  const r = await api.post('/api/routines', { title: 'En bloques', sessionsPerWeek: 3, exercises: ejercicios, clientId: c });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  const guardada = (await api.get('/api/routines')).datos.find(x => x.id === r.datos.id);
  assert.deepEqual(guardada.exercises.map(e => [e.block, e.rounds]), [[1, 3], [1, 3], [1, 3], [2, 3], [2, 3], [2, 3]]);
  const e = await api.post(`/api/routines/${r.datos.id}/share-links`, { clientId: c, hours: 24 });
  const vista = await publico.get(`/api/public/routine/${tokenDe(e.datos.url)}`);
  assert.deepEqual(vista.datos.routine.exercises.map(x => x.block), [1, 1, 1, 2, 2, 2]);
  assert.equal((await api.post('/api/routines', { title: 'Mal', sessionsPerWeek: 3, exercises: [{ name: 'X', block: 0 }] })).estado, 400, 'el bloque 0 no existe');
});

// Van al final a propósito: las reversas borran columnas y tablas.
test('la reversa de 060 se niega a perder la justificación de cancelaciones sin orden expresa, y con la orden quita las columnas sin descancelar las clases', async () => {
  const archivo = new URL('../migrations-down/060_cancelacion_por_viaje.down.sql', import.meta.url).pathname;
  await assert.rejects(ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]), /cancelaciones con su justificación guardada/);
  await ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-c', "SET billing.allow_destructive_down = 'on'", '-f', archivo]);
  assert.equal((await db`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'sessions' AND column_name IN ('cancellation_reason', 'cancelled_travel_id')`)[0].n, 0);
  assert.ok((await db`SELECT count(*)::int AS n FROM sessions WHERE status = 'cancelled'`)[0].n >= 4, 'las clases siguen canceladas');
});

test('la reversa de 059 se niega a borrar viajes y enlaces sin orden expresa, y con la orden los quita', async () => {
  const archivo = new URL('../migrations-down/059_viajes_y_enlaces_de_rutina.down.sql', import.meta.url).pathname;
  await assert.rejects(ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]), /hay viajes o enlaces de rutina guardados/);
  assert.ok((await db`SELECT count(*)::int AS n FROM routine_share_links`)[0].n >= 1);
  await ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-c', "SET billing.allow_destructive_down = 'on'", '-f', archivo]);
  assert.equal((await db`SELECT to_regclass('routine_share_links') AS t`)[0].t, null);
});
