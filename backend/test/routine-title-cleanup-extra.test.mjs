// Casos límite de la limpieza de "(copia)" y de su reversa de migración: que revertir no pise un título que alguien cambió después,
// y que la reversa de la migración se niegue a destruir el registro de lo limpiado sin orden expresa.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let servidor; let db; let api; let dueno; const id = {};

async function limpiar(...args) {
  const entorno = { ...process.env, TZ: 'America/Panama', DATABASE_URL: servidor.databaseUrl, JWT_SECRET: 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres', SETUP_TOKEN, NODE_ENV: 'test' };
  try { const r = await ejecutar('node', ['dist/scripts/limpiar-copias-rutinas.js', ...args], { cwd: raiz, env: entorno }); return { codigo: 0, salida: r.stdout + r.stderr }; }
  catch (e) { return { codigo: e.code ?? 1, salida: (e.stdout || '') + (e.stderr || '') }; }
}
const titulo = async tag => (await db`SELECT title FROM routines WHERE id = ${id[tag]}::uuid`)[0].title;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  [dueno] = await db`SELECT id FROM users LIMIT 1`;
  const nueva = async (tag, title) => { id[tag] = (await db`INSERT INTO routines (owner_id, title, description, sessions_per_week, exercises) VALUES (${dueno.id}, ${title}, '', 3, '[]'::jsonb) RETURNING id::text AS id`)[0].id; };
  await nueva('a', 'Rutina de glúteos (copia)');
  await nueva('b', 'Fuerza total (Copia 2)');
  await nueva('c', 'Piernas (copia) y core');      // en medio: NO se toca
  await nueva('d', 'Pecho');                       // sin sufijo
  await nueva('e', 'X (copia)');                   // quedaría de 1 carácter: se omite
}, { timeout: 120_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

test('limpia solo el sufijo FINAL, omite lo que quedaría casi vacío, y es idempotente', async () => {
  const antes = JSON.stringify(await db`SELECT id, title FROM routines ORDER BY id`);
  assert.equal((await limpiar()).codigo, 0); assert.equal(JSON.stringify(await db`SELECT id, title FROM routines ORDER BY id`), antes, 'sin argumentos es ensayo: no escribe');
  assert.equal((await limpiar('--aplicar')).codigo, 0);
  assert.equal(await titulo('a'), 'Rutina de glúteos'); assert.equal(await titulo('b'), 'Fuerza total');
  assert.equal(await titulo('c'), 'Piernas (copia) y core'); assert.equal(await titulo('d'), 'Pecho'); assert.equal(await titulo('e'), 'X (copia)');
  const otra = await limpiar('--aplicar'); assert.equal(otra.codigo, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_title_cleanups`)[0].n, 2, 'idempotente: dos registros, no cuatro');
});

test('--revertir NO pisa un título que alguien cambió después de limpiarlo', async () => {
  await db`UPDATE routines SET title = 'Rutina de glúteos NUEVA' WHERE id = ${id.a}::uuid`;   // Eileen la renombró después
  const r = await limpiar('--revertir'); assert.equal(r.codigo, 0, r.salida);
  assert.equal(await titulo('a'), 'Rutina de glúteos NUEVA', 'el título nuevo de Eileen se respeta');
  assert.equal(await titulo('b'), 'Fuerza total (Copia 2)', 'el que seguía limpio sí vuelve a su título anterior');
});

test('la reversa de 062 se niega a destruir el registro de lo limpiado sin orden expresa, y con la orden lo quita', async () => {
  await limpiar('--aplicar');                                       // vuelve a haber un registro (b se limpia de nuevo)
  assert.ok((await db`SELECT count(*)::int AS n FROM routine_title_cleanups`)[0].n > 0);
  const archivo = join(raiz, 'migrations-down', '062_routine_title_cleanups.down.sql');
  await assert.rejects(ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]), /allow_destructive_down|respalde/i, 'sin la orden debe negarse');
  assert.ok((await db`SELECT to_regclass('routine_title_cleanups')::text AS t`)[0].t, 'la tabla sigue existiendo');
  await ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-c', "SET billing.allow_destructive_down = 'on'", '-f', archivo]);
  assert.equal((await db`SELECT to_regclass('routine_title_cleanups')::text AS t`)[0].t, null, 'con la orden se quita');
});
