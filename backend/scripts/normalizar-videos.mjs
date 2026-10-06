#!/usr/bin/env node

// Inventario y, en entregas posteriores, migración de las demostraciones de
// ejercicios. Esta primera entrega implementa deliberadamente solo
// --inventario: no escribe en PostgreSQL ni en R2.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const MAX_VIDEO_SIZE = 40 * 1024 * 1024;
const ACCEPTED_PROFILES = /baseline|main/i;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} terminó con código ${code}: ${stderr.trim()}`));
    });
  });
}

function usage() {
  console.error('Uso:');
  console.error('  DATABASE_URL=… R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node scripts/normalizar-videos.mjs --inventario');
  console.error('  R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… node scripts/normalizar-videos.mjs --solo-r2');
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta la variable de entorno ${name}`);
  return value;
}

function fraction(value) {
  if (!value || value === '0/0') return null;
  const [numerator, denominator] = String(value).split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
}

function topLevelMp4Boxes(bytes) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const start = offset;
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    offset += 8;
    if (size === 1) {
      if (offset + 8 > bytes.length) break;
      const high = bytes.readUInt32BE(offset);
      const low = bytes.readUInt32BE(offset + 4);
      size = high * 2 ** 32 + low;
      offset += 8;
    } else if (size === 0) {
      size = bytes.length - start;
    }
    if (!Number.isSafeInteger(size) || size < offset - start || start + size > bytes.length) break;
    boxes.push({ type, start, end: start + size });
    offset = start + size;
  }
  return boxes;
}

async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,level,pix_fmt,width,height,avg_frame_rate,r_frame_rate',
    file
  ]);
  return JSON.parse(stdout);
}

function inspect(bytes, metadata) {
  const formatName = String(metadata.format?.format_name || '');
  const video = (metadata.streams || []).find(stream => stream.codec_type === 'video') || {};
  const audio = (metadata.streams || []).some(stream => stream.codec_type === 'audio');
  const isMp4 = formatName.split(',').some(name => ['mp4', 'mov', '3gp', '3g2', 'mj2'].includes(name));
  const boxes = isMp4 ? topLevelMp4Boxes(bytes) : [];
  const moov = boxes.find(box => box.type === 'moov');
  const mdat = boxes.find(box => box.type === 'mdat');
  const fragmented = boxes.some(box => box.type === 'moof');
  const duration = Number(metadata.format?.duration);
  const fps = fraction(video.avg_frame_rate) ?? fraction(video.r_frame_rate);
  const maxSide = Math.max(Number(video.width) || 0, Number(video.height) || 0);
  const reasons = [];
  if (!isMp4) reasons.push('contenedor no es MP4');
  if (video.codec_name !== 'h264') reasons.push(`códec ${video.codec_name || 'desconocido'}`);
  if (!ACCEPTED_PROFILES.test(String(video.profile || ''))) reasons.push(`perfil ${video.profile || 'desconocido'}`);
  if (Number(video.level) > 40) reasons.push(`nivel ${video.level}`);
  if (video.pix_fmt !== 'yuv420p') reasons.push(`píxel ${video.pix_fmt || 'desconocido'}`);
  if (!Number.isFinite(duration) || duration <= 0) reasons.push('duración ausente o inválida');
  if (fragmented) reasons.push('MP4 fragmentado (moof)');
  if (!moov || !mdat || moov.start > mdat.start) reasons.push('moov no está antes de mdat');
  if (audio) reasons.push('contiene audio');
  if ((Number(video.width) || 0) % 2 || (Number(video.height) || 0) % 2) reasons.push('dimensiones impares');
  if (maxSide > 1280) reasons.push(`lado mayor ${maxSide}px`);
  if (fps && fps > 30.01) reasons.push(`frecuencia ${fps.toFixed(2)} fps`);
  if (bytes.length > MAX_VIDEO_SIZE) reasons.push(`supera 40 MB (${bytes.length} bytes)`);
  return {
    container: isMp4 ? 'mp4' : formatName || 'desconocido',
    codec: video.codec_name || null,
    profile: video.profile || null,
    level: video.level ?? null,
    duration: Number.isFinite(duration) ? duration : null,
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    fps,
    pixelFormat: video.pix_fmt || null,
    hasAudio: audio,
    fragmented,
    moovBeforeMdat: Boolean(moov && mdat && moov.start < mdat.start),
    sizeBytes: bytes.length,
    needsNormalize: reasons.length > 0,
    reasons
  };
}

async function downloadObject(s3, bucket, objectKey, directory, index) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!response.Body) throw new Error('R2 devolvió el objeto sin contenido');
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  const file = join(directory, `${index}.video`);
  await writeFile(file, bytes);
  return { file, bytes, contentType: response.ContentType || null };
}

function exerciseIdFromObjectKey(objectKey) {
  return /^exercises\/([^/]+)\//.exec(objectKey)?.[1] || null;
}

function createStorageClient() {
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  const accessKeyId = requiredEnv('R2_ACCESS_KEY_ID');
  const secretAccessKey = requiredEnv('R2_SECRET_ACCESS_KEY');
  const bucket = process.env.R2_BUCKET || 'eileen-lifestyle-private';
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  });
  return { bucket, s3 };
}

async function inventoryR2() {
  const { bucket, s3 } = createStorageClient();
  const prefix = process.env.R2_VIDEO_PREFIX || 'exercises/';
  const temporary = await mkdtemp(join(tmpdir(), 'eileen-videos-r2-inventory-'));
  const rows = [];
  try {
    let continuationToken;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken }));
      rows.push(...(page.Contents || []).filter(object => object.Key && !object.Key.endsWith('/')));
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);

    const summary = { total: rows.length, sizeBytes: 0, byContentType: new Map(), needsNormalize: 0, failures: 0 };
    console.log('INVENTARIO DE VIDEOS EN R2 · SOLO LECTURA · SIN BASE DE DATOS');
    console.log(`Bucket: ${bucket} · prefijo: ${prefix} · objetos: ${rows.length}`);
    for (const [index, row] of rows.entries()) {
      const objectKey = row.Key;
      const exerciseId = exerciseIdFromObjectKey(objectKey);
      process.stdout.write(`\n${index + 1}. ejercicio: ${exerciseId || 'ruta no reconocida'} · clave: ${objectKey}\n`);
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));
        summary.sizeBytes += Number(head.ContentLength ?? row.Size) || 0;
        const { file, bytes, contentType: downloadedContentType } = await downloadObject(s3, bucket, objectKey, temporary, index);
        const metadata = await probe(file);
        const info = inspect(bytes, metadata);
        if (info.needsNormalize) summary.needsNormalize += 1;
        const actualType = head.ContentType || downloadedContentType || 'desconocido';
        summary.byContentType.set(actualType, (summary.byContentType.get(actualType) || 0) + 1);
        console.log(`   content-type R2 (HeadObject): ${actualType} · tamaño: ${head.ContentLength ?? row.Size ?? '—'} bytes · última modificación: ${row.LastModified?.toISOString?.() || '—'}`);
        console.log(`   formato: ${info.container} · códec: ${info.codec || '—'} · perfil: ${info.profile || '—'} · duración: ${info.duration ?? '—'} s`);
        console.log(`   video: ${info.width || '—'}x${info.height || '—'} · ${info.fps ? `${info.fps.toFixed(2)} fps` : 'fps —'} · píxel: ${info.pixelFormat || '—'} · audio: ${info.hasAudio ? 'sí' : 'no'}`);
        console.log(`   mp4: moov antes de mdat=${info.moovBeforeMdat ? 'sí' : 'no'} · fragmentado=${info.fragmented ? 'sí' : 'no'} · normalizar=${info.needsNormalize ? 'sí' : 'no'}`);
        if (info.reasons.length) console.log(`   motivos: ${info.reasons.join('; ')}`);
      } catch (error) {
        summary.failures += 1;
        console.log(`   ERROR al inspeccionar: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log('\nRESUMEN R2');
    console.log(`Total: ${summary.total} · tamaño listado: ${(summary.sizeBytes / 1024 / 1024).toFixed(2)} MB · necesitan normalizar: ${summary.needsNormalize} · fallos: ${summary.failures}`);
    for (const [type, count] of summary.byContentType) console.log(`${type}: ${count}`);
    console.log('No se abrió PostgreSQL. No se escribió ni se borró ningún objeto de R2.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function inventory() {
  const databaseUrl = requiredEnv('DATABASE_URL');
  const { bucket, s3 } = createStorageClient();
  const sql = postgres(databaseUrl, {
    ssl: process.env.NODE_ENV === 'production' ? 'require' : undefined,
    max: 1,
    connection: { TimeZone: 'America/Panama' }
  });
  const temporary = await mkdtemp(join(tmpdir(), 'eileen-videos-inventory-'));
  try {
    const rows = await sql`
      SELECT v.id::text AS video_id, v.exercise_id::text AS exercise_id,
        e.name AS exercise_name, v.object_key, v.content_type,
        v.size_bytes, v.duration_seconds, 'variant' AS source
      FROM exercise_videos v
      JOIN exercises e ON e.id = v.exercise_id
      UNION ALL
      SELECT NULL AS video_id, e.id::text AS exercise_id, e.name AS exercise_name,
        e.video_object_key AS object_key, e.video_content_type AS content_type,
        e.video_size_bytes AS size_bytes, e.video_duration_seconds AS duration_seconds,
        'legacy' AS source
      FROM exercises e
      WHERE e.video_object_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM exercise_videos v
          WHERE v.exercise_id = e.id AND v.object_key = e.video_object_key
        )
      ORDER BY exercise_name, source, object_key
    `;
    const summary = { total: rows.length, sizeBytes: 0, byContentType: new Map(), needsNormalize: 0, failures: 0 };
    console.log('INVENTARIO DE VIDEOS · SOLO LECTURA');
    console.log(`Zona horaria: America/Panama · Objetos: ${rows.length}`);
    for (const [index, row] of rows.entries()) {
      const contentType = row.content_type || 'desconocido';
      const declaredSize = Number(row.size_bytes) || 0;
      summary.sizeBytes += declaredSize;
      summary.byContentType.set(contentType, (summary.byContentType.get(contentType) || 0) + 1);
      process.stdout.write(`\n${index + 1}. ${row.exercise_name} · ${row.source} · ${contentType}\n   clave: ${row.object_key}\n`);
      try {
        const { file, bytes } = await downloadObject(s3, bucket, row.object_key, temporary, index);
        const metadata = await probe(file);
        const info = inspect(bytes, metadata);
        if (info.needsNormalize) summary.needsNormalize += 1;
        console.log(`   formato: ${info.container} · códec: ${info.codec || '—'} · perfil: ${info.profile || '—'} · duración: ${info.duration ?? '—'} s`);
        console.log(`   video: ${info.width || '—'}x${info.height || '—'} · ${info.fps ? `${info.fps.toFixed(2)} fps` : 'fps —'} · píxel: ${info.pixelFormat || '—'} · audio: ${info.hasAudio ? 'sí' : 'no'}`);
        console.log(`   mp4: moov antes de mdat=${info.moovBeforeMdat ? 'sí' : 'no'} · fragmentado=${info.fragmented ? 'sí' : 'no'} · normalizar=${info.needsNormalize ? 'sí' : 'no'}`);
        if (info.reasons.length) console.log(`   motivos: ${info.reasons.join('; ')}`);
      } catch (error) {
        summary.failures += 1;
        console.log(`   ERROR al inspeccionar: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log('\nRESUMEN');
    console.log(`Total: ${summary.total} · tamaño declarado: ${(summary.sizeBytes / 1024 / 1024).toFixed(2)} MB · necesitan normalizar: ${summary.needsNormalize} · fallos: ${summary.failures}`);
    for (const [type, count] of summary.byContentType) console.log(`${type}: ${count}`);
    console.log('No se escribió en PostgreSQL ni en R2. No se borró ningún objeto.');
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await sql.end({ timeout: 5 });
  }
}

const args = new Set(process.argv.slice(2));
const hasDatabaseInventory = args.has('--inventario');
const hasR2Inventory = args.has('--solo-r2');
const hasWriteFlag = args.has('--aplicar') || args.has('--revertir') || args.has('--purgar-originales') || args.has('--dry-run');
const validMode = hasR2Inventory ? (args.size === 1 || (hasDatabaseInventory && args.size === 2)) : hasDatabaseInventory && args.size === 1;
if (hasWriteFlag || !validMode) {
  usage();
  if (hasWriteFlag) {
    console.error('Esta entrega implementa deliberadamente solo --inventario y --solo-r2; las operaciones de escritura esperan la revisión del inventario.');
  }
  process.exitCode = 2;
} else if (hasR2Inventory) {
  inventoryR2().catch(error => {
    console.error(`Inventario R2 detenido: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else {
  inventory().catch(error => {
    console.error(`Inventario detenido: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
