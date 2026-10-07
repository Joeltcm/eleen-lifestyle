import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);
let servidor; let db; let api; let ids;
const raiz = new URL('..', import.meta.url).pathname;

async function correr(...args) {
  return ejecutar('node', ['dist/scripts/limpiar-copias-rutinas.js', ...args], {
    cwd: raiz,
    env: { ...process.env, TZ: 'America/Panama', DATABASE_URL: servidor.databaseUrl, JWT_SECRET: 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres', SETUP_TOKEN, NODE_ENV: 'test' }
  });
}

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  api.usarToken(setup.datos.token);
  const [owner] = await db`SELECT id FROM users WHERE email = ${CREDENCIALES.email}`;
  const clientePrueba = await api.post('/api/clients', { fullName: 'Cliente de copia', cutoffDay: 1 });
  const crear = async title => (await db`INSERT INTO routines (owner_id, title, sessions_per_week, exercises) VALUES (${owner.id}, ${title}, 3, '[]'::jsonb) RETURNING id::text AS id`)[0].id;
  ids = {
    uno: await crear('Piernas (copia)'),
    dos: await crear('Core (copy 2)'),
    medio: await crear('Mantener (copia) aquí'),
    corto: await crear('x (copia)')
  };
  await db`INSERT INTO routine_assignments (routine_id, client_id) VALUES (${ids.uno}::uuid, ${clientePrueba.datos.id})`;
}, { timeout: 120_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('limpiar copias: dry-run, aplicar idempotente, sufijo final, duplicados y reversa', async () => {
  const antes = await db`SELECT id::text, title FROM routines ORDER BY title`;
  const ensayo = await correr('--dry-run');
  assert.match(ensayo.stdout, /Piernas \(copia\)/);
  assert.match(ensayo.stdout, /Rutinas con sufijo: 3/);
  assert.deepEqual(await db`SELECT id::text, title FROM routines ORDER BY title`, antes, 'dry-run no escribe');

  const aplicado = await correr('--aplicar');
  assert.match(aplicado.stdout, /APLICAR/);
  const despues = Object.fromEntries((await db`SELECT id::text, title FROM routines`).map(row => [row.id, row.title]));
  assert.equal(despues[ids.uno], 'Piernas');
  assert.equal(despues[ids.dos], 'Core');
  assert.equal(despues[ids.medio], 'Mantener (copia) aquí', 'el texto intermedio no se toca');
  assert.equal(despues[ids.corto], 'x (copia)', 'no se deja un título de menos de dos caracteres');
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_title_cleanups`)[0].n, 2);

  await correr('--aplicar');
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_title_cleanups`)[0].n, 2, 'aplicar otra vez es idempotente');
  await correr('--revertir');
  const restauradas = Object.fromEntries((await db`SELECT id::text, title FROM routines`).map(row => [row.id, row.title]));
  assert.equal(restauradas[ids.uno], 'Piernas (copia)');
  assert.equal(restauradas[ids.dos], 'Core (copy 2)');
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_title_cleanups`)[0].n, 0);
});
