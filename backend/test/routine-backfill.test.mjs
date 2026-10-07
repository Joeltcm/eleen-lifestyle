import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);
let servidor;
let api;
let db;

before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {} });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  assert.equal(setup.estado, 201);
  api.usarToken(setup.datos.token);
}, { timeout: 90_000 });

after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

async function correr(...args) {
  const resultado = await ejecutar('node', ['dist/scripts/rellenar-envios-rutinas.js', ...args], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      DATABASE_URL: servidor.databaseUrl,
      JWT_SECRET: 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres',
      SETUP_TOKEN,
      TZ: 'America/Panama',
      NODE_ENV: 'test'
    }
  });
  return resultado.stdout + resultado.stderr;
}

test('el relleno es de solo lectura por defecto, idempotente y reversible por lote', async () => {
  const clientId = (await api.post('/api/clients', { fullName: 'Cliente histórico de rutinas', cutoffDay: 1 })).datos.id;
  const [owner] = await db`SELECT id::text AS id FROM users LIMIT 1`;
  const routineId = randomUUID();
  const exercises = [{ name: 'Sentadilla', sets: 3, reps: '10', weight: '20 lb' }];
  await db`
    INSERT INTO routines (id, owner_id, root_routine_id, title, description, sessions_per_week, exercises, exercises_hash)
    VALUES (${routineId}::uuid, ${owner.id}::uuid, ${routineId}::uuid, 'Rutina histórica', 'Antes del registro', 2, ${db.json(exercises)}, NULL)
  `;
  const assignmentId = (await db`
    INSERT INTO routine_assignments (routine_id, client_id, starts_on, due_on)
    VALUES (${routineId}::uuid, ${clientId}::uuid, '2026-10-01', '2026-10-31') RETURNING id::text AS id
  `)[0].id;
  const travelId = (await db`
    INSERT INTO client_travel (client_id, starts_on, ends_on, destination)
    VALUES (${clientId}::uuid, '2026-10-02', '2026-10-05', 'Prueba') RETURNING id::text AS id
  `)[0].id;
  await db`
    INSERT INTO routine_share_links (owner_id, client_id, routine_id, travel_id, token_hash, expires_at, created_by, created_at)
    VALUES (${owner.id}::uuid, ${clientId}::uuid, ${routineId}::uuid, NULL, ${randomUUID()}, '2026-10-20T12:00:00-05:00', ${owner.id}::uuid, '2026-10-02T09:00:00-05:00')
  `;
  await db`
    INSERT INTO routine_share_links (owner_id, client_id, routine_id, travel_id, token_hash, expires_at, created_by, created_at)
    VALUES (${owner.id}::uuid, ${clientId}::uuid, ${routineId}::uuid, ${travelId}::uuid, ${randomUUID()}, '2026-10-20T12:00:00-05:00', ${owner.id}::uuid, '2026-10-03T09:00:00-05:00')
  `;
  const sessionId = (await db`
    INSERT INTO sessions (client_id, starts_at, duration_minutes, mode)
    VALUES (${clientId}::uuid, '2026-10-04T09:00:00-05:00', 45, 'Presencial') RETURNING id::text AS id
  `)[0].id;
  await db`
    INSERT INTO session_routine_offers (session_id, routine_id, client_id, offered_by_user_id, offered_at)
    VALUES (${sessionId}::uuid, ${routineId}::uuid, ${clientId}::uuid, ${owner.id}::uuid, '2026-10-04T10:00:00-05:00')
  `;

  const dry = await correr('--dry-run');
  assert.match(dry, /Envíos reconstruibles pendientes: 4/);
  assert.match(dry, /No reconstruible: enlaces copiados/);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE backfilled`)[0].n, 0);
  assert.equal((await db`SELECT exercises_hash FROM routines WHERE id = ${routineId}::uuid`)[0].exercises_hash, null);

  const applied = await correr('--aplicar');
  assert.match(applied, /envíos: 4/);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE backfilled`)[0].n, 4);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE backfilled AND summary_reconstructed`)[0].n, 4);
  assert.ok((await db`SELECT exercises_hash FROM routines WHERE id = ${routineId}::uuid`)[0].exercises_hash);

  const repeated = await correr('--aplicar');
  assert.match(repeated, /no hay nada nuevo/);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE backfilled`)[0].n, 4);

  await db`
    INSERT INTO routine_deliveries (
      owner_id, routine_id, client_id, kind, sent_at, sent_by_user_id,
      routine_title, routine_version, client_name, summary_text, exercises_snapshot
    ) VALUES (
      ${owner.id}::uuid, ${routineId}::uuid, ${clientId}::uuid, 'link', now(), ${owner.id}::uuid,
      'Envío manual', 1, 'Cliente histórico de rutinas', 'manual', '[]'::jsonb
    )
  `;
  await correr('--revertir');
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE backfilled`)[0].n, 0);
  assert.equal((await db`SELECT count(*)::int AS n FROM routine_deliveries WHERE NOT backfilled`)[0].n, 1, 'la reversa no borra envíos normales');
  assert.equal((await db`SELECT exercises_hash FROM routines WHERE id = ${routineId}::uuid`)[0].exercises_hash, null, 'la reversa restaura el hash que estaba vacío');
  assert.equal(assignmentId.length > 0, true);
});

test('la reversa de 066 protege los lotes y sus datos sin orden expresa', async () => {
  const archivo = new URL('../migrations-down/066_routine_delivery_backfill.down.sql', import.meta.url).pathname;
  await assert.rejects(
    ejecutar('psql', ['-v', 'ON_ERROR_STOP=1', '-q', servidor.databaseUrl, '-f', archivo]),
    /billing\.allow_destructive_down|orden expresa/i
  );
});
