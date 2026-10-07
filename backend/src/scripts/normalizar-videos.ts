#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { inspectVideoFile, normalizeVideo, runCommand, type VideoInfo } from '../video-normalizer.js';

type VideoReference = {
  source: 'variant' | 'legacy';
  id: string;
  exerciseId: string;
  exerciseName: string;
  oldContentType: string | null;
  oldSizeBytes: number;
  oldDurationSeconds: number | null;
};

type VideoGroup = {
  oldObjectKey: string;
  references: VideoReference[];
  info?: VideoInfo;
  inputFile?: string;
};

type ConversionItem = {
  old_object_key: string;
  new_object_key: string;
  references_json: string | VideoReference[];
  normalized_size_bytes: number;
  normalized_duration_seconds: number | null;
};

function conversionReferences(value: unknown) {
  return (typeof value === 'string' ? JSON.parse(value) : value) as VideoReference[];
}

const args = process.argv.slice(2);
const explicitAction = args.find(value => ['--inventario', '--dry-run', '--aplicar', '--revertir', '--purgar-originales'].includes(value));
const action = explicitAction || (args.length === 0 ? '--dry-run' : undefined);
const target = action && ['--revertir', '--purgar-originales'].includes(action)
  ? (args[args.indexOf(action) + 1] && !args[args.indexOf(action) + 1].startsWith('--') ? args[args.indexOf(action) + 1] : 'ultimo')
  : null;

function usage() {
  console.error('Uso:');
  console.error('  node dist/scripts/normalizar-videos.js --inventario');
  console.error('  node dist/scripts/normalizar-videos.js --dry-run');
  console.error('  node dist/scripts/normalizar-videos.js --aplicar');
  console.error('  node dist/scripts/normalizar-videos.js --revertir [id|todos]');
  console.error('  node dist/scripts/normalizar-videos.js --purgar-originales [id|todos]');
}

function requiredStorage() {
  if (!config.R2_ACCOUNT_ID || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) {
    throw new Error('R2 no está configurado en el entorno del servicio');
  }
  return {
    bucket: config.R2_BUCKET,
    s3: new S3Client({
      region: 'auto',
      endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY }
    })
  };
}

async function downloadObject(s3: S3Client, bucket: string, objectKey: string, file: string) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
  if (!response.Body) throw new Error('R2 devolvió el objeto sin contenido');
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  await writeFile(file, bytes);
  return { bytes, contentType: response.ContentType || null };
}

async function uploadObject(s3: S3Client, bucket: string, objectKey: string, file: string) {
  const body = await readFile(file);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: body, ContentType: 'video/mp4' }));
  return body.byteLength;
}

async function deleteObject(s3: S3Client, bucket: string, objectKey: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
}

async function videoRows(sql: postgres.Sql) {
  return sql`
    SELECT v.id::text AS record_id, v.exercise_id::text AS exercise_id,
      e.name AS exercise_name, v.object_key, v.content_type,
      v.size_bytes, v.duration_seconds, 'variant' AS source
    FROM exercise_videos v
    JOIN exercises e ON e.id = v.exercise_id
    UNION ALL
    SELECT e.id::text AS record_id, e.id::text AS exercise_id,
      e.name AS exercise_name, e.video_object_key AS object_key,
      e.video_content_type AS content_type, e.video_size_bytes AS size_bytes,
      e.video_duration_seconds AS duration_seconds, 'legacy' AS source
    FROM exercises e
    WHERE e.video_object_key IS NOT NULL
    ORDER BY exercise_name, source, object_key
  `;
}

function groupRows(rows: any[]): VideoGroup[] {
  const groups = new Map<string, VideoGroup>();
  for (const row of rows) {
    const oldObjectKey = String(row.object_key);
    const group = groups.get(oldObjectKey) || { oldObjectKey, references: [] };
    group.references.push({
      source: row.source,
      id: String(row.record_id),
      exerciseId: String(row.exercise_id),
      exerciseName: String(row.exercise_name),
      oldContentType: row.content_type ? String(row.content_type) : null,
      oldSizeBytes: Number(row.size_bytes) || 0,
      oldDurationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds)
    });
    groups.set(oldObjectKey, group);
  }
  return [...groups.values()];
}

function printInfo(group: VideoGroup, info: VideoInfo) {
  const first = group.references[0];
  console.log(`${first.exerciseName} · ${group.oldObjectKey}`);
  console.log(`  ${info.container} · ${info.codec || '—'} · ${info.profile || '—'} · ${info.duration ?? '—'} s · ${info.width || '—'}x${info.height || '—'} · ${info.fps ? info.fps.toFixed(2) : '—'} fps`);
  console.log(`  audio=${info.hasAudio ? 'sí' : 'no'} · moov-first=${info.moovBeforeMdat ? 'sí' : 'no'} · fragmentado=${info.fragmented ? 'sí' : 'no'} · normalizar=${info.needsNormalize ? 'sí' : 'no'}`);
  if (info.reasons.length) console.log(`  motivos: ${info.reasons.join('; ')}`);
}

async function inspectGroups(s3: S3Client, bucket: string, groups: VideoGroup[], directory: string) {
  let failures = 0;
  for (const [index, group] of groups.entries()) {
      const input = join(directory, `input-${index}`);
      try {
        await downloadObject(s3, bucket, group.oldObjectKey, input);
        group.inputFile = input;
        group.info = await inspectVideoFile(input);
      printInfo(group, group.info);
    } catch (error) {
      failures += 1;
      console.error(`ERROR · ${group.oldObjectKey} · ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

async function inventory() {
  const { s3, bucket } = requiredStorage();
  const sql = postgres(config.DATABASE_URL, { max: 1, connection: { TimeZone: 'America/Panama' } });
  const directory = await mkdtemp(join(tmpdir(), 'eileen-video-inventory-'));
  try {
    const groups = groupRows(await videoRows(sql));
    console.log('INVENTARIO · SOLO LECTURA · America/Panama');
    console.log(`Referencias en base: ${groups.reduce((count, group) => count + group.references.length, 0)} · objetos únicos: ${groups.length}`);
    const failures = await inspectGroups(s3, bucket, groups, directory);
    const needs = groups.filter(group => group.info?.needsNormalize).length;
    console.log(`\nRESUMEN · objetos únicos: ${groups.length} · necesitan normalizar: ${needs} · fallos: ${failures}`);
    console.log('No se escribió en PostgreSQL ni en R2. No se borró ningún objeto.');
  } finally {
    await rm(directory, { recursive: true, force: true });
    await sql.end({ timeout: 5 });
  }
}

async function createBatch(sql: postgres.Sql) {
  const [batch] = await sql`
    INSERT INTO exercise_video_conversions (status) VALUES ('applying') RETURNING id::text AS id
  `;
  return String(batch.id);
}

async function applyConversion(dryRun: boolean) {
  const { s3, bucket } = requiredStorage();
  const sql = postgres(config.DATABASE_URL, { max: 1, connection: { TimeZone: 'America/Panama' } });
  const directory = await mkdtemp(join(tmpdir(), 'eileen-video-normalize-'));
  let batchId: string | null = null;
  try {
    const groups = groupRows(await videoRows(sql));
    console.log(dryRun ? 'DRY-RUN · solo lectura · no se subirán archivos ni se actualizará la base' : 'APLICAR · se conservan los originales en R2');
    let failures = await inspectGroups(s3, bucket, groups, directory);
    const candidates = groups.filter(group => group.info?.needsNormalize);
    console.log(`\nPlan: ${candidates.length} objetos para normalizar · ${groups.length - candidates.length} ya cumplen`);
    if (dryRun) return;
    // Sin nada que convertir no se crea un lote: uno vacío sería el "último" y `--revertir ultimo` / `--purgar-originales ultimo` lo elegirían en lugar del lote real.
    if (!candidates.length) { console.log('Nada que convertir: no se creó ningún lote.'); return; }
    batchId = await createBatch(sql);
    const items: ConversionItem[] = [];
    for (const group of candidates) {
      if (!group.inputFile) throw new Error(`falta el archivo temporal de ${group.oldObjectKey}`);
      const input = group.inputFile;
      const output = join(directory, `output-${randomUUID()}.mp4`);
      const firstExerciseId = group.references[0].exerciseId;
      const newObjectKey = `exercises/${firstExerciseId}/${randomUUID()}.mp4`;
      try {
        await normalizeVideo(input, output);
        const normalized = await inspectVideoFile(output);
        const sizeBytes = await uploadObject(s3, bucket, newObjectKey, output);
        const refs = group.references;
        await sql.begin(async transaction => {
          for (const ref of refs) {
            if (ref.source === 'variant') {
              const updated = await transaction`
                UPDATE exercise_videos
                SET object_key = ${newObjectKey}, content_type = 'video/mp4',
                    size_bytes = ${sizeBytes}, duration_seconds = ${normalized.duration}, updated_at = now()
                WHERE id = ${ref.id}::uuid AND object_key = ${group.oldObjectKey}
                RETURNING id
              `;
              if (!updated.length) throw new Error(`la variante ${ref.id} ya cambió antes de aplicar`);
            } else {
              const updated = await transaction`
                UPDATE exercises
                SET video_object_key = ${newObjectKey}, video_content_type = 'video/mp4',
                    video_size_bytes = ${sizeBytes}, video_duration_seconds = ${normalized.duration},
                    video_uploaded_at = now(), updated_at = now()
                WHERE id = ${ref.id}::uuid AND video_object_key = ${group.oldObjectKey}
                RETURNING id
              `;
              if (!updated.length) throw new Error(`el ejercicio legado ${ref.id} ya cambió antes de aplicar`);
            }
          }
          await transaction`
            INSERT INTO exercise_video_conversion_items
              (conversion_id, old_object_key, new_object_key, references_json, normalized_size_bytes, normalized_duration_seconds)
            VALUES (${batchId}::uuid, ${group.oldObjectKey}, ${newObjectKey}, ${JSON.stringify(refs)}::jsonb, ${sizeBytes}, ${normalized.duration})
          `;
        });
        items.push({ old_object_key: group.oldObjectKey, new_object_key: newObjectKey, references_json: refs, normalized_size_bytes: sizeBytes, normalized_duration_seconds: normalized.duration });
        console.log(`CONVERTIDO · ${group.oldObjectKey} → ${newObjectKey} · ${sizeBytes} bytes`);
      } catch (error) {
        failures += 1;
        await deleteObject(s3, bucket, newObjectKey).catch(() => undefined);
        console.error(`ERROR · ${group.oldObjectKey} · ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await sql`UPDATE exercise_video_conversions SET status = 'applied', finished_at = now() WHERE id = ${batchId}::uuid`;
    console.log(`\nCONVERSIÓN ${batchId} · convertidos: ${items.length} · fallos: ${failures}`);
    console.log('Los originales NO fueron borrados. Verifica en un teléfono antes de ejecutar --purgar-originales.');
  } catch (error) {
    if (batchId) await sql`UPDATE exercise_video_conversions SET status = 'failed', finished_at = now() WHERE id = ${batchId}::uuid`.catch(() => undefined);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
    await sql.end({ timeout: 5 });
  }
}

async function batches(sql: postgres.Sql, requested: string | null, forPurge: boolean) {
  if (requested && requested !== 'todos' && requested !== 'ultimo') {
    return sql`SELECT id::text AS id, status FROM exercise_video_conversions WHERE id = ${requested}::uuid`;
  }
  const statuses = forPurge ? ['applied', 'failed'] : ['applying', 'applied', 'failed'];
  if (requested === 'todos') return sql`SELECT id::text AS id, status FROM exercise_video_conversions WHERE status IN ${sql(statuses)} ORDER BY created_at DESC`;
  return sql`SELECT id::text AS id, status FROM exercise_video_conversions WHERE status IN ${sql(statuses)} ORDER BY created_at DESC LIMIT 1`;
}

async function revertBatch(sql: postgres.Sql, s3: S3Client, bucket: string, batchId: string) {
  const [batch] = await sql`SELECT id::text AS id, status FROM exercise_video_conversions WHERE id = ${batchId}::uuid`;
  if (!batch) throw new Error(`No existe la conversión ${batchId}`);
  if (batch.status === 'purged' || batch.status === 'reverted') return console.log(`OMITIDO · ${batchId} ya está ${batch.status}`);
  const items = await sql`SELECT * FROM exercise_video_conversion_items WHERE conversion_id = ${batchId}::uuid ORDER BY converted_at DESC`;
  // Revertir apunta la base otra vez a los originales: si alguno ya no existe (purga parcial, borrado manual) la demostración quedaría rota. Se comprueba ANTES de tocar nada.
  const faltantes: string[] = [];
  for (const item of items) {
    try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: String(item.old_object_key) })); }
    catch { faltantes.push(String(item.old_object_key)); }
  }
  if (faltantes.length) throw new Error(`No se puede revertir ${batchId}: faltan ${faltantes.length} original(es) en R2 (${faltantes.slice(0, 3).join(', ')}${faltantes.length > 3 ? '…' : ''}). La base no se tocó.`);
  await sql.begin(async transaction => {
    for (const item of items) {
      const refs = conversionReferences(item.references_json);
      for (const ref of refs) {
        if (ref.source === 'variant') {
          await transaction`
            UPDATE exercise_videos
            SET object_key = ${item.old_object_key}, content_type = ${ref.oldContentType || 'video/mp4'},
                size_bytes = ${ref.oldSizeBytes}, duration_seconds = ${ref.oldDurationSeconds}, updated_at = now()
            WHERE id = ${ref.id}::uuid AND object_key = ${item.new_object_key}
          `;
        } else {
          await transaction`
            UPDATE exercises
            SET video_object_key = ${item.old_object_key}, video_content_type = ${ref.oldContentType || 'video/mp4'},
                video_size_bytes = ${ref.oldSizeBytes}, video_duration_seconds = ${ref.oldDurationSeconds},
                video_uploaded_at = now(), updated_at = now()
            WHERE id = ${ref.id}::uuid AND video_object_key = ${item.new_object_key}
          `;
        }
      }
    }
    await transaction`UPDATE exercise_video_conversions SET status = 'reverted', reverted_at = now() WHERE id = ${batchId}::uuid`;
  });
  for (const item of items) await deleteObject(s3, bucket, item.new_object_key).catch(error => console.error(`AVISO · no se pudo borrar ${item.new_object_key}: ${error instanceof Error ? error.message : String(error)}`));
  console.log(`REVERSIÓN ${batchId} · ${items.length} objetos restaurados; los originales se conservaron`);
}

async function purgeBatch(sql: postgres.Sql, s3: S3Client, bucket: string, batchId: string) {
  const [batch] = await sql`SELECT id::text AS id, status FROM exercise_video_conversions WHERE id = ${batchId}::uuid`;
  if (!batch) throw new Error(`No existe la conversión ${batchId}`);
  if (batch.status === 'reverted' || batch.status === 'purged') return console.log(`OMITIDO · ${batchId} está ${batch.status}`);
  const items = await sql`SELECT old_object_key FROM exercise_video_conversion_items WHERE conversion_id = ${batchId}::uuid`;
  let skipped = 0;
  for (const item of items) {
    const referenced = await sql`
      SELECT 1
      WHERE EXISTS (SELECT 1 FROM exercise_videos v WHERE v.object_key = ${item.old_object_key})
         OR EXISTS (SELECT 1 FROM exercises e WHERE e.video_object_key = ${item.old_object_key})
      LIMIT 1
    `;
    if (referenced.length) {
      skipped += 1;
      console.log(`OMITIDO · ${item.old_object_key} todavía está referenciado`);
      continue;
    }
    await deleteObject(s3, bucket, item.old_object_key);
    console.log(`ORIGINAL ELIMINADO · ${item.old_object_key}`);
  }
  if (!skipped) await sql`UPDATE exercise_video_conversions SET status = 'purged', purged_at = now() WHERE id = ${batchId}::uuid`;
  console.log(`PURGA ${batchId} · eliminados: ${items.length - skipped} · omitidos: ${skipped}`);
}

async function main() {
  if (!action || args.filter(value => value.startsWith('--')).length > 1) {
    usage(); process.exitCode = 2; return;
  }
  // Borrar originales es irreversible: nunca por omisión. Hay que escribir el id del lote, "ultimo" o "todos".
  if (action === '--purgar-originales' && !(args[args.indexOf(action) + 1] && !args[args.indexOf(action) + 1].startsWith('--'))) {
    console.error('--purgar-originales borra los originales de forma irreversible: indica el lote (un id, "ultimo" o "todos").');
    usage(); process.exitCode = 2; return;
  }
  if (action === '--inventario') return inventory();
  const { s3, bucket } = requiredStorage();
  const sql = postgres(config.DATABASE_URL, { max: 1, connection: { TimeZone: 'America/Panama' } });
  try {
    if (action === '--dry-run' || action === '--aplicar') return await applyConversion(action === '--dry-run');
    const selected = await batches(sql, target, action === '--purgar-originales');
    if (!selected.length) throw new Error('No hay conversiones que procesar');
    for (const batch of selected) {
      if (action === '--revertir') await revertBatch(sql, s3, bucket, String(batch.id));
      else await purgeBatch(sql, s3, bucket, String(batch.id));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch(error => {
  console.error(`Normalización detenida: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
