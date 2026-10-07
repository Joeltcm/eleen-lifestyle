// El relleno no debe duplicar lo que ya se registró en tiempo real, y debe cubrir justo lo que NO tiene registro.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let servidor; let api; let db;
const hoy = () => new Date(Date.now() - 5 * 3600_000).toISOString().slice(0, 10);
const aHora = (d, h = '09:00') => new Date(`${d}T${h}:00-05:00`).toISOString();
const E = (n, x = {}) => ({ name: n, sets: 3, reps: '10', ...x });

async function relleno(...args) {
  const entorno = { ...process.env, TZ: 'America/Panama', DATABASE_URL: servidor.databaseUrl, JWT_SECRET: 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres', SETUP_TOKEN, NODE_ENV: 'test' };
  try { const r = await ejecutar('node', ['dist/scripts/rellenar-envios-rutinas.js', ...args], { cwd: raiz, env: entorno }); return { codigo: 0, salida: r.stdout + r.stderr }; }
  catch (e) { return { codigo: e.code ?? 1, salida: (e.stdout || '') + (e.stderr || '') }; }
}
const entregas = async () => (await db`SELECT count(*)::int AS n FROM routine_deliveries`)[0].n;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('envíos YA registrados en tiempo real (asignación, enlace, oferta, nueva versión) NO se duplican al rellenar; solo se reconstruye lo que no tiene registro', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Cliente relleno', cutoffDay: 1 })).datos.id;
  const r = (await api.post('/api/routines', { title: 'Rutina con registro real', sessionsPerWeek: 2, clientId: c, exercises: [E('Sentadilla'), E('Plancha')] })).datos;
  assert.equal((await api.post(`/api/routines/${r.id}/share-links`, { clientId: c, hours: 24 })).estado, 201);
  const sesion = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(hoy(), '23:00'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  assert.equal((await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: r.id, confirmRepeat: true })).estado, 201);
  const v2 = await api.patch(`/api/routines/${r.id}`, { title: r.title, description: r.description || '', sessionsPerWeek: 2, exercises: [E('Sentadilla'), E('Remo')], confirmVersion: true });
  assert.equal(v2.estado, 200, JSON.stringify(v2.datos));
  const antes = await entregas();
  assert.ok(antes >= 4, `hay envíos registrados en tiempo real (${antes})`);
  // una rutina "antigua": asignada SIN registro (como antes de la 063)
  const antigua = (await api.post('/api/routines', { title: 'Rutina antigua', sessionsPerWeek: 1, clientId: c, confirmRepeat: true, exercises: [E('Press')] })).datos;
  await db`DELETE FROM routine_deliveries WHERE routine_id = ${antigua.id}`;
  const base = await entregas();
  const ensayo = await relleno('--dry-run'); assert.equal(ensayo.codigo, 0, ensayo.salida);
  assert.equal(await entregas(), base, 'el ensayo no escribe');
  assert.match(ensayo.salida, /PENDIENTE · asignación · Cliente relleno · Rutina antigua · \d{2}-\d{2}-\d{4} \(aprox\.\)/, 'el ensayo lista cada envío que reconstruiría, para poder revisarlo antes de aplicar');
  assert.equal((ensayo.salida.match(/PENDIENTE ·/g) || []).length, 1, 'solo lo que no tiene registro');
  assert.equal((await relleno('--aplicar')).codigo, 0);
  const nuevos = await db`SELECT routine_id::text, kind, backfilled, summary_reconstructed FROM routine_deliveries WHERE backfilled`;
  assert.deepEqual(nuevos.map(n => [n.routine_id, n.kind]), [[antigua.id, 'assignment']], `solo se reconstruye lo que no tenía registro; se duplicó: ${JSON.stringify(nuevos)}`);
  assert.equal(nuevos[0].summary_reconstructed, true);
  assert.equal(await entregas(), base + 1);
  assert.equal((await relleno('--aplicar')).codigo, 0); assert.equal(await entregas(), base + 1, 'idempotente');
  assert.equal((await relleno('--revertir')).codigo, 0); assert.equal(await entregas(), base, 'revertir quita solo lo reconstruido');
});

test('el aviso a Eileen de una rutina que cuenta como clase lleva "Cuenta como su clase de hoy" en su propia línea, no como "Comentario:"', async () => {
  const c = (await api.post('/api/clients', { fullName: 'Cliente aviso', cutoffDay: 1, email: 'aviso@prueba.test' })).datos.id;
  const r = (await api.post('/api/routines', { title: 'Rutina de aviso', sessionsPerWeek: 1, clientId: c, exercises: [E('Remo')] })).datos;
  const sesion = (await api.post('/api/sessions', { clientId: c, startsAt: aHora(hoy(), '23:30'), durationMinutes: 45, mode: 'Presencial' })).datos.id;
  assert.equal((await api.post(`/api/sessions/${sesion}/routine-offer`, { routineId: r.id })).estado, 201);
  const enlace = await api.post(`/api/clients/${c}/access-link`, {});
  const acceso = await api.post(`/api/auth/access-link/${String(enlace.datos.url).split('acceso=')[1]}`, { password: 'clave-del-portal-larga' });
  const portal = cliente(servidor.base); portal.usarToken(acceso.datos.token);
  const h = hoy();
  await portal.post('/api/portal/routine-activity', { routineId: r.id, completedOn: h, kind: 'started', elapsedSeconds: 0 });
  const fin = await portal.post('/api/portal/routine-exercise-completions', { routineId: r.id, completedOn: h, exerciseIndex: 0, elapsedSeconds: 20 });
  assert.equal(fin.datos.sessionCompleted, true, JSON.stringify(fin.datos));
  const avisos = (await api.get('/api/notifications')).datos.filter(a => /Cliente aviso/.test(`${a.title} ${a.body}`) && /completó|cumplid/i.test(`${a.title} ${a.body}`));
  assert.ok(avisos.length >= 1, 'hay aviso de rutina cumplida');
  const cuerpo = avisos.map(a => a.body).join('\n---\n');
  assert.match(cuerpo, /Cuenta como su clase de hoy/);
  assert.doesNotMatch(cuerpo, /Comentario: Cuenta como su clase/, `no debe presentarse como un comentario de la clienta:\n${cuerpo}`);
});
