// Subida de un video nuevo (camino real del servidor): el navegador sube a R2 y luego REGISTRA la clave; el servidor debe convertirla y
// nunca dejar la base apuntando a un archivo que no existe. R2 simulado en carpeta (fake-s3.mjs), base real, ffmpeg real.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente } from './harness.mjs';

const ejecutar = promisify(execFile);
const aqui = dirname(fileURLToPath(import.meta.url)); const raiz = resolve(aqui, '..');
const tiene = async (...c) => { try { await ejecutar(c[0], c.slice(1)); return true; } catch { return false; } };
const hayFfmpeg = (await tiene('ffmpeg', '-version')) && (await tiene('ffprobe', '-version'));
const omitir = { skip: hayFfmpeg ? false : 'ffmpeg/ffprobe no están instalados' };
const work = mkdtempSync(join(tmpdir(), 'up-e2e-')); const r2 = join(work, 'r2'); mkdirSync(r2);
// el servidor que levanta el harness hereda estas variables
Object.assign(process.env, { R2_ACCOUNT_ID: 'cuenta-falsa', R2_ACCESS_KEY_ID: 'falsa', R2_SECRET_ACCESS_KEY: 'falsa', R2_BUCKET: 'bucket-falso', FAKE_R2_DIR: r2, NODE_OPTIONS: `--import ${join(aqui, 'fake-s3.mjs')}` });
const { levantar } = await import('./harness.mjs');
let servidor; let db; let api; let ejId; let dueno; const f = join(work, 'f');
const poner = (clave, desde) => { const d = join(r2, ...clave.split('/')); mkdirSync(dirname(d), { recursive: true }); writeFileSync(d, readFileSync(desde)); };
const hay = clave => existsSync(join(r2, ...clave.split('/')));
const ffmpeg = (...a) => ejecutar('ffmpeg', ['-v', 'error', '-y', ...a]);
const info = async clave => (await import(join(raiz, 'dist/video-normalizer.js'))).inspectVideoFile(join(r2, ...clave.split('/')));
const colgantes = async () => {
  const claves = [...(await db`SELECT object_key FROM exercise_videos`).map(r => r.object_key), ...(await db`SELECT video_object_key AS object_key FROM exercises WHERE video_object_key IS NOT NULL`).map(r => r.object_key)];
  return [...new Set(claves)].filter(k => !hay(k));
};

before(async () => {
  if (!hayFfmpeg) return;
  mkdirSync(f);
  await ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=3:size=480x854:rate=25', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(f, 'alto-audio.mp4'));
  await ffmpeg('-f', 'lavfi', '-i', 'testsrc=duration=3:size=404x720:rate=30', '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', join(f, 'frag.mp4'));
  writeFileSync(join(f, 'corrupto.mp4'), Buffer.from('esto no es un video'));
  servidor = await levantar();
  api = cliente(servidor.base); db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password }); api.usarToken(login.datos.token);
  [dueno] = await db`SELECT id FROM users LIMIT 1`;
  ejId = (await db`INSERT INTO exercises (owner_id, slug, name, section, level) VALUES (${dueno.id}, 'sentadilla', 'Sentadilla', 'tren_inferior', 'Todos') RETURNING id::text AS id`)[0].id;
}, { timeout: 180_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

let claveA;
test('A) un video H.264 High con audio se registra convertido a MP4 universal y la subida original se retira', omitir, async () => {
  const fuente = `exercises/${ejId}/fuente-a.mp4`; poner(fuente, join(f, 'alto-audio.mp4'));
  const r = await api.post(`/api/exercises/${ejId}/videos`, { objectKey: fuente, label: 'A' });
  assert.equal(r.estado, 201, JSON.stringify(r.datos));
  const [v] = await db`SELECT object_key, content_type FROM exercise_videos WHERE exercise_id = ${ejId}::uuid`;
  claveA = v.object_key;
  assert.notEqual(v.object_key, fuente); assert.equal(v.content_type, 'video/mp4'); assert.ok(hay(v.object_key));
  const i = await info(v.object_key); assert.equal(i.needsNormalize, false, i.reasons.join('; ')); assert.equal(i.hasAudio, false);
  assert.equal(hay(fuente), false, 'la subida original ya no sobra en R2');
  assert.deepEqual(await colgantes(), [], 'nada apunta a un archivo inexistente');
});

test('B) un archivo que no es video se rechaza sin tocar la base (y se informa de lo que queda en R2)', omitir, async () => {
  const fuente = `exercises/${ejId}/fuente-b.mp4`; poner(fuente, join(f, 'corrupto.mp4'));
  const antes = JSON.stringify(await db`SELECT object_key FROM exercise_videos ORDER BY object_key`);
  const r = await api.post(`/api/exercises/${ejId}/videos`, { objectKey: fuente, label: 'B' });
  assert.equal(r.estado, 422, JSON.stringify(r.datos));
  assert.equal(JSON.stringify(await db`SELECT object_key FROM exercise_videos ORDER BY object_key`), antes);
  assert.equal(hay(fuente), false, 'una subida rechazada no debe dejar basura huérfana en R2');
});

test('C) registrar la clave de un video YA EN USO del mismo ejercicio no puede borrarlo (dejaría la demostración rota)', omitir, async () => {
  const r = await api.post(`/api/exercises/${ejId}/videos`, { objectKey: claveA, label: 'C' });
  assert.ok(r.estado === 201 || r.estado >= 400, `respuesta ${r.estado}`);
  assert.deepEqual(await colgantes(), [], 'todo lo que la base referencia sigue existiendo');
  assert.equal(hay(claveA), true, 'el video en uso sigue en R2');
});

test('D) la ruta heredada /video convierte también (MP4 fragmentado) y reemplaza sin dejar referencias rotas', omitir, async () => {
  const fuente = `exercises/${ejId}/fuente-d.mp4`; poner(fuente, join(f, 'frag.mp4'));
  const r = await api.post(`/api/exercises/${ejId}/video`, { objectKey: fuente });
  assert.equal(r.estado, 200, JSON.stringify(r.datos));
  const [e] = await db`SELECT video_object_key AS k, video_content_type AS t FROM exercises WHERE id = ${ejId}::uuid`;
  assert.notEqual(e.k, fuente); assert.equal(e.t, 'video/mp4'); assert.equal((await info(e.k)).needsNormalize, false);
  assert.deepEqual(await colgantes(), []);
});
