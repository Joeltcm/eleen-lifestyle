import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let db; let hoy;
const dia = n => new Date(Date.now() - 5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const ejercicio = name => ({ name, sets: 3, reps: '10' });

before(async () => {
  servidor = await levantar(); api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  api.usarToken(setup.datos.token); hoy = dia(0);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('el resumen de demos calcula cifras en el servidor y excluye estándar y otro dueño', async () => {
  const crearDemo = async (fullName, email, ends = 14) => { const result = await api.post('/api/clients', { fullName, email, cutoffDay: 1, demo: true, demoEndsOn: dia(ends), demoRoutineLimit: 3 }); assert.equal(result.estado, 201, JSON.stringify(result.datos)); return result.datos.id; };
  const activa = await crearDemo('Demo Activa', 'demo-activa@prueba.test');
  const pronto = await crearDemo('Demo Pronto', 'demo-pronto@prueba.test', 3);
  const vencida = await crearDemo('Demo Vencida', 'demo-vencida@prueba.test');
  await db`UPDATE clients SET demo_ends_on = ${dia(-2)}::date WHERE id = ${vencida}`;
  const convertida = await crearDemo('Demo Convertida', 'demo-convertida@prueba.test');
  assert.equal((await api.post(`/api/clients/${convertida}/demo/convert`, {})).estado, 200);

  const rutina = (await api.post('/api/routines', { title: 'Rutina demo', sessionsPerWeek: 1, clientId: activa, dueOn: dia(10), exercises: [ejercicio('Sentadilla')] })).datos;
  await api.post('/api/routines', { title: 'Rutina demo 2', sessionsPerWeek: 1, clientId: pronto, dueOn: dia(10), exercises: [ejercicio('Plancha')] });
  await db`INSERT INTO routine_completions (routine_id, client_id, completed_on, completion_percent) VALUES (${rutina.id}, ${activa}, ${hoy}::date, 100)`;

  const standard = (await api.post('/api/clients', { fullName: 'Cliente Estándar', email: 'estandar@prueba.test', cutoffDay: 1 })).datos.id;
  await api.post('/api/routines', { title: 'Rutina normal', sessionsPerWeek: 1, clientId: standard, dueOn: dia(10), exercises: [ejercicio('Peso muerto')] });
  const [{ id: otroDueno }] = await db`INSERT INTO users (email, password_hash, full_name, role) VALUES ('otro-dueno@prueba.test', 'no-se-usa', 'Otro dueño', 'trainer') RETURNING id`;
  const [{ id: otroDemo }] = await db`INSERT INTO clients (owner_id, full_name, email, service_mode, demo_started_on, demo_ends_on, demo_routine_limit) VALUES (${otroDueno}, 'Demo de otro dueño', 'otro-demo@prueba.test', 'demo', ${hoy}::date, ${dia(3)}::date, 3) RETURNING id`;
  assert.ok(otroDemo);

  const response = await api.get('/api/demo/summary');
  assert.equal(response.estado, 200, JSON.stringify(response.datos));
  assert.deepEqual({
    active: response.datos.active,
    endingSoon: response.datos.endingSoon,
    expiredUndecided: response.datos.expiredUndecided,
    routinesSent: response.datos.routinesSent,
    routinesCompleted: response.datos.routinesCompleted
  }, { active: 2, endingSoon: 1, expiredUndecided: 1, routinesSent: 2, routinesCompleted: 1 });
  assert.deepEqual(response.datos.funnel, { started: 4, converted: 1, conversionPercent: 25, newThisMonth: 4 });
  assert.deepEqual(response.datos.expiring.map(item => item.full_name), ['Demo Vencida', 'Demo Pronto', 'Demo Activa']);
  assert.equal(response.datos.expiring[0].expired, true);
  assert.equal(response.datos.expiring[1].routinesUsed, 1);
  assert.equal(response.datos.expiring[2].routinesCompleted, 1);
});

test('el resumen exige sesión de Eileen', async () => {
  const sinAuth = cliente(servidor.base);
  assert.equal((await sinAuth.get('/api/demo/summary')).estado, 401);
});
