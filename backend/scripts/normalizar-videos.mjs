#!/usr/bin/env node

// Inventario compatible con la primera entrega. La normalización con escritura
// vive en src/scripts/normalizar-videos.ts y se ejecuta compilada dentro de
// Railway como dist/scripts/normalizar-videos.js.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { inspectVideo, probeVideo } from '../dist/video-normalizer.js';

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
        const metadata = await probeVideo(file);
        const info = inspectVideo(bytes, metadata);
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
        const metadata = await probeVideo(file);
        const info = inspectVideo(bytes, metadata);
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
