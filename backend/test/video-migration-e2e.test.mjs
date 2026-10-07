// Ciclo completo del script de migración de videos con una base REAL y un R2 simulado en una carpeta (ver fake-s3.mjs):
// ensayo, aplicar, repetir, revertir, aplicar y purgar, más los casos en que debe NEGARSE a actuar.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

const ejecutar = promisify(execFile);
const tiene = async (...c) => { try { await ejecutar(c[0], c.slice(1)); return true; } catch { return false; } };
const hayFfmpeg = (await tiene('ffmpeg', '-version')) && (await tiene('ffprobe', '-version'));
const codificadores = hayFfmpeg ? (await ejecutar('ffmpeg', ['-hide_banner', '-encoders'])).stdout : '';
// AV1 si hay codificador; si no, VP9: ambos son códecs que iOS/Android no garantizan y deben recodificarse.
const CODEC_RARO = /libsvtav1/.test(codificadores) ? ['libsvtav1'] : /libaom-av1/.test(codificadores) ? ['libaom-av1', '-cpu-used', '8'] : ['libvpx-vp9', '-pix_fmt', 'yuv420p'];
const omitir = { skip: hayFfmpeg ? false : 'ffmpeg/ffprobe no están instalados; se omite la prueba de migración' };
const aqui = dirname(fileURLToPath(import.meta.url));
const raiz = resolve(aqui, '..');
let servidor; let db; let api; let r2; let work; const claves = {}; const ids = {}; const archivos = {};

const ffmpeg = (...args) => ejecutar('ffmpeg', ['-v', 'error', '-y', ...args]);
const poner = (clave, desde) => { const destino = join(r2, ...clave.split('/')); mkdirSync(dirname(destino), { recursive: true }); writeFileSync(destino, readFileSync(desde)); };
const hay = clave => existsSync(join(r2, ...clave.split('/')));
const ops = () => (existsSync(join(work, 'ops.log')) ? readFileSync(join(work, 'ops.log'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
async function correr(...args) {
  const entorno = { ...process.env, TZ: 'America/Panama', DATABASE_URL: servidor.databaseUrl, JWT_SECRET: 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres', SETUP_TOKEN, NODE_ENV: 'test',
    R2_ACCOUNT_ID: 'cuenta-falsa', R2_ACCESS_KEY_ID: 'falsa', R2_SECRET_ACCESS_KEY: 'falsa', R2_BUCKET: 'bucket-falso', FAKE_R2_DIR: r2, NODE_OPTIONS: `--import ${join(aqui, 'fake-s3.mjs')}` };
  try { const r = await ejecutar('node', ['dist/scripts/normalizar-videos.js', ...args], { cwd: raiz, env: entorno }); return { codigo: 0, salida: r.stdout + r.stderr }; }
  catch (e) { return { codigo: e.code ?? 1, salida: (e.stdout || '') + (e.stderr || '') }; }
}
const videosDe = async () => db`SELECT v.id::text AS id, e.name, v.object_key, v.content_type, v.size_bytes FROM exercise_videos v JOIN exercises e ON e.id = v.exercise_id ORDER BY e.name, v.object_key`;
const info = async clave => (await import(join(raiz, 'dist/video-normalizer.js'))).inspectVideoFile(join(r2, ...clave.split('/')));

before(async () => {
  if (!hayFfmpeg) return;
  servidor = await levantar();
  api = cliente(servidor.base);
  db = postgres(servidor.databaseUrl, { onnotice: () => {}, max: 2 });
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  work = mkdtempSync(join(tmpdir(), 'mig-e2e-')); r2 = join(work, 'r2'); mkdirSync(r2);
  const f = join(work, 'f'); mkdirSync(f);
  const lav = (d, s, r) => ['-f', 'lavfi', '-i', `testsrc=duration=${d}:size=${s}:rate=${r}`];
  await ffmpeg(...lav(3, '480x854', 25), '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', ...CODEC_RARO, '-c:a', 'aac', '-shortest', join(f, 'av1.mp4'));
  await ffmpeg(...lav(3, '360x640', 30), '-f', 'lavfi', '-i', 'sine=duration=3', '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(f, 'h264audio.mp4'));
  await ffmpeg(...lav(3, '404x720', 30), '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', join(f, 'frag.mp4'));
  await ffmpeg(...lav(3, '480x854', 30), '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(f, 'good.mp4'));
  await ffmpeg(...lav(3, '404x720', 30), '-c:v', 'libx264', '-profile:v', 'baseline', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', join(f, 'frag2.mp4'));
  writeFileSync(join(f, 'corrupto.mp4'), Buffer.from('esto no es un video'));
  Object.assign(archivos, { av1: join(f, 'av1.mp4'), h264audio: join(f, 'h264audio.mp4'), frag: join(f, 'frag.mp4'), good: join(f, 'good.mp4'), legado: join(f, 'frag2.mp4'), comp: join(f, 'h264audio.mp4'), corrupto: join(f, 'corrupto.mp4') });
  const [dueno] = await db`SELECT id FROM users LIMIT 1`;
  const ej = async nombre => (await db`INSERT INTO exercises (owner_id, slug, name, section, level) VALUES (${dueno.id}, ${nombre.toLowerCase().replace(/\W+/g, '-')}, ${nombre}, 'core', 'Todos') RETURNING id::text AS id`)[0].id;
  const variante = async (nombre, tag) => { const id = await ej(nombre); ids[tag] = id; claves[tag] = `exercises/${id}/${tag}.mp4`; poner(claves[tag], archivos[tag]);
    await db`INSERT INTO exercise_videos (exercise_id, owner_id, label, object_key, content_type, size_bytes, duration_seconds, sort_order) VALUES (${id}, ${dueno.id}, 'Demostración', ${claves[tag]}, 'video/mp4', ${readFileSync(archivos[tag]).length}, 3, 0)`; };
  await variante('Ejercicio AV1', 'av1');
  await variante('Ejercicio H264 audio', 'h264audio');
  await variante('Ejercicio fragmentado', 'frag');
  await variante('Ejercicio ya correcto', 'good');
  await variante('Ejercicio corrupto', 'corrupto');
  // heredado: solo en la columna vieja de exercises
  const legado = await ej('Ejercicio heredado'); ids.legado = legado; claves.legado = `exercises/${legado}/legado.mp4`; poner(claves.legado, archivos.legado);
  await db`UPDATE exercises SET video_object_key = ${claves.legado}, video_content_type = 'video/mp4', video_size_bytes = ${readFileSync(archivos.legado).length}, video_duration_seconds = 3 WHERE id = ${legado}::uuid`;
  // compartido: la misma clave en la columna vieja y en una variante (así los dejó la migración 056)
  const comp = await ej('Ejercicio compartido'); ids.comp = comp; claves.comp = `exercises/${comp}/comp.mp4`; poner(claves.comp, archivos.comp);
  await db`UPDATE exercises SET video_object_key = ${claves.comp}, video_content_type = 'video/mp4', video_size_bytes = 1000, video_duration_seconds = 3 WHERE id = ${comp}::uuid`;
  await db`INSERT INTO exercise_videos (exercise_id, owner_id, label, object_key, content_type, size_bytes, duration_seconds, sort_order) VALUES (${comp}::uuid, ${dueno.id}, 'Demostración', ${claves.comp}, 'video/mp4', 1000, 3, 0)`;
}, { timeout: 180_000 });
after(async () => { await db?.end({ timeout: 1 }).catch(() => {}); await servidor?.parar(); });

const CONVERTIBLES = [['Ejercicio AV1', 'av1'], ['Ejercicio H264 audio', 'h264audio'], ['Ejercicio fragmentado', 'frag'], ['Ejercicio compartido', 'comp']];
let lote;
test('1) el ensayo (y el valor por defecto sin argumentos) no escribe nada: ni base ni R2', omitir, async () => {
  const antes = JSON.stringify(await videosDe());
  for (const args of [['--dry-run'], []]) {
    const r = await correr(...args);
    assert.equal(r.codigo, 0, r.salida);
    assert.match(r.salida, /Plan: \d+ objetos para normalizar/);
  }
  assert.equal(JSON.stringify(await videosDe()), antes, 'la base no cambió');
  assert.deepEqual(ops().filter(o => o.op === 'put' || o.op === 'delete'), [], 'no hubo escrituras en R2');
  assert.equal((await db`SELECT count(*)::int AS n FROM exercise_video_conversions`)[0].n, 0, 'ni siquiera se creó un lote');
});

test('2) --aplicar convierte lo que hace falta, deja intacto lo correcto y lo corrupto, y conserva los originales', omitir, async () => {
  const r = await correr('--aplicar');
  assert.equal(r.codigo, 0, r.salida);
  const filas = Object.fromEntries((await videosDe()).map(v => [v.name, v]));
  for (const [nombre, tag] of CONVERTIBLES) {
    const v = filas[nombre]; assert.notEqual(v.object_key, claves[tag], `${nombre}: apunta al archivo nuevo`);
    assert.equal(v.content_type, 'video/mp4'); assert.ok(hay(v.object_key), `${nombre}: el archivo nuevo existe`);
    const i = await info(v.object_key); assert.equal(i.needsNormalize, false, `${nombre}: la salida cumple el formato universal (${i.reasons.join('; ')})`);
    assert.equal(i.codec, 'h264'); assert.equal(i.hasAudio, false); assert.equal(i.fragmented, false); assert.equal(i.moovBeforeMdat, true);
    assert.ok(hay(claves[tag]), `${nombre}: el ORIGINAL sigue en R2`);
  }
  assert.equal(filas['Ejercicio ya correcto'].object_key, claves.good, 'lo que ya cumplía no se toca');
  assert.equal(filas['Ejercicio corrupto'].object_key, claves.corrupto, 'lo corrupto queda como estaba');
  const [legado] = await db`SELECT video_object_key AS k FROM exercises WHERE id = ${ids.legado}::uuid`;
  assert.notEqual(legado.k, claves.legado, 'el heredado también se actualizó'); assert.ok(hay(legado.k)); assert.ok(hay(claves.legado));
  const [comp] = await db`SELECT video_object_key AS k FROM exercises WHERE id = ${ids.comp}::uuid`;
  assert.equal(comp.k, filas['Ejercicio compartido'].object_key, 'columna vieja y variante comparten el MISMO archivo nuevo');
  assert.equal((await db`SELECT count(*)::int AS n FROM exercise_video_conversion_items`)[0].n, 5, 'cinco objetos únicos convertidos (av1, h264audio, frag, heredado, compartido)');
  assert.equal(ops().filter(o => o.op === 'delete').length, 0, 'nada se borró');
  lote = (await db`SELECT id::text AS id, status FROM exercise_video_conversions ORDER BY created_at DESC LIMIT 1`)[0];
  assert.equal(lote.status, 'applied');
});

test('3) repetir --aplicar no reconvierte nada y NO deja un lote vacío que estorbe a --revertir ultimo', omitir, async () => {
  const antes = (await db`SELECT count(*)::int AS n FROM exercise_video_conversion_items`)[0].n; const puts = ops().filter(o => o.op === 'put').length;
  const r = await correr('--aplicar'); assert.equal(r.codigo, 0, r.salida);
  assert.equal((await db`SELECT count(*)::int AS n FROM exercise_video_conversion_items`)[0].n, antes);
  assert.equal(ops().filter(o => o.op === 'put').length, puts, 'no se subió ningún archivo más');
  const lotes = await db`SELECT status FROM exercise_video_conversions ORDER BY created_at`;
  assert.equal(lotes.length, 1, `no debe crearse un segundo lote vacío (hay ${lotes.length}: ${lotes.map(l => l.status)})`);
});

test('4) --revertir ultimo devuelve la base a los originales y borra solo lo nuevo', omitir, async () => {
  const r = await correr('--revertir', 'ultimo'); assert.equal(r.codigo, 0, r.salida);
  const filas = Object.fromEntries((await videosDe()).map(v => [v.name, v]));
  for (const [nombre, tag] of CONVERTIBLES) { assert.equal(filas[nombre].object_key, claves[tag], `${nombre}: de vuelta al original`); assert.ok(hay(claves[tag])); }
  const [legado] = await db`SELECT video_object_key AS k FROM exercises WHERE id = ${ids.legado}::uuid`; assert.equal(legado.k, claves.legado);
  assert.equal((await db`SELECT status FROM exercise_video_conversions WHERE id = ${lote.id}::uuid`)[0].status, 'reverted');
  const borrados = ops().filter(o => o.op === 'delete').map(o => o.key);
  assert.ok(borrados.length === 5 && borrados.every(k => !Object.values(claves).includes(k)), 'solo se borraron los 5 archivos nuevos, ningún original');
});

test('5) aplicar de nuevo y --purgar-originales: borra solo los originales convertidos, nunca los que no se tocaron, y revertir después ya no es posible', omitir, async () => {
  assert.equal((await correr('--aplicar')).codigo, 0);
  const nuevo = (await db`SELECT id::text AS id FROM exercise_video_conversions WHERE status = 'applied' ORDER BY created_at DESC LIMIT 1`)[0];
  const r = await correr('--purgar-originales', nuevo.id); assert.equal(r.codigo, 0, r.salida);
  for (const tag of ['av1', 'h264audio', 'frag', 'legado', 'comp']) assert.equal(hay(claves[tag]), false, `${tag}: el original se purgó`);
  for (const tag of ['good', 'corrupto']) assert.equal(hay(claves[tag]), true, `${tag}: no se tocó`);
  for (const v of await videosDe()) assert.ok(hay(v.object_key), `${v.name}: todo lo que la base referencia sigue existiendo`);
  const rev = await correr('--revertir', nuevo.id); assert.match(rev.salida, /OMITIDO/, 'un lote purgado no se puede revertir');
});

test('6) una combinación de opciones inválida no hace nada', omitir, async () => {
  const antes = JSON.stringify(await videosDe());
  const r = await correr('--aplicar', '--purgar-originales'); assert.equal(r.codigo, 2);
  assert.equal(JSON.stringify(await videosDe()), antes);
});

test('7) --revertir se niega, sin tocar la base, si ya falta algún original en R2 (purga parcial o borrado manual)', omitir, async () => {
  // se vuelve al estado inicial (originales puestos y apuntados) para convertir otra vez y luego "perder" un original
  for (const tag of ['av1', 'h264audio', 'frag', 'comp', 'legado']) poner(claves[tag], archivos[tag]);
  for (const tag of ['av1', 'h264audio', 'frag']) await db`UPDATE exercise_videos SET object_key = ${claves[tag]} WHERE exercise_id = ${ids[tag]}::uuid`;
  await db`UPDATE exercise_videos SET object_key = ${claves.comp} WHERE exercise_id = ${ids.comp}::uuid`;
  await db`UPDATE exercises SET video_object_key = ${claves.comp} WHERE id = ${ids.comp}::uuid`;
  await db`UPDATE exercises SET video_object_key = ${claves.legado} WHERE id = ${ids.legado}::uuid`;
  assert.equal((await correr('--aplicar')).codigo, 0);
  const lote3 = (await db`SELECT id::text AS id FROM exercise_video_conversions WHERE status = 'applied' ORDER BY created_at DESC LIMIT 1`)[0];
  const apuntaAlNuevo = JSON.stringify(await videosDe());
  await rm(join(r2, ...claves.av1.split('/')), { force: true });   // un original desaparece
  const r = await correr('--revertir', lote3.id);
  assert.notEqual(r.codigo, 0, 'debe negarse');
  assert.match(r.salida, /No se puede revertir.*faltan 1 original/);
  assert.equal(JSON.stringify(await videosDe()), apuntaAlNuevo, 'la base no se tocó: los clientes siguen viendo los videos nuevos');
  assert.equal((await db`SELECT status FROM exercise_video_conversions WHERE id = ${lote3.id}::uuid`)[0].status, 'applied');
});

test('8) --purgar-originales sin indicar lote se niega: borrar originales nunca es por omisión', omitir, async () => {
  const borrados = ops().filter(o => o.op === 'delete').length;
  const r = await correr('--purgar-originales');
  assert.equal(r.codigo, 2); assert.match(r.salida, /irreversible/);
  assert.equal(ops().filter(o => o.op === 'delete').length, borrados, 'no se borró nada');
});
