import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deleteObject, downloadObject, uploadObject, verifyUpload } from './storage.js';
import { copyVideo, inspectVideoFile, normalizeVideo } from './video-normalizer.js';

const MAX_VIDEO_SIZE = 40 * 1024 * 1024;

export type RegisteredVideo = {
  sourceKey: string;
  objectKey: string;
  contentType: 'video/mp4';
  sizeBytes: number;
  durationSeconds: number | null;
  normalized: boolean;
};

/**
 * Convierte una subida antes de registrarla en la base.
 *
 * La URL firmada sigue descargando directamente a R2, pero la referencia que
 * llega a la aplicación nunca apunta al archivo que envió el navegador. Esto
 * evita que un MP4 con AV1/audio o un WebM llegue a los clientes móviles.
 * El original se conserva hasta que el flujo de migración lo purgue de forma
 * explícita.
 */
export async function normalizeRegisteredVideo(sourceKey: string, exerciseId: string): Promise<RegisteredVideo> {
  const uploaded = await verifyUpload(sourceKey);
  if (!uploaded.sizeBytes || uploaded.sizeBytes > MAX_VIDEO_SIZE) {
    throw new Error('El video no llegó completo o supera el máximo de 40 MB');
  }

  const directory = await mkdtemp(join(tmpdir(), 'eileen-video-upload-'));
  const source = join(directory, 'source');
  const output = join(directory, 'normalized.mp4');
  let finalKey: string | null = null;
  try {
    const downloaded = await downloadObject(sourceKey);
    await writeFile(source, downloaded.body);
    const result = await normalizeVideo(source, output);
    if (!result.changed) await copyVideo(source, output);
    const normalized = await inspectVideoFile(output);
    if (normalized.needsNormalize) {
      throw new Error(`El video no cumple el formato móvil: ${normalized.reasons.join('; ')}`);
    }

    finalKey = `exercises/${exerciseId}/${randomUUID()}.mp4`;
    const body = await readFile(output);
    await uploadObject(finalKey, 'video/mp4', body);
    return {
      sourceKey,
      objectKey: finalKey,
      contentType: 'video/mp4',
      sizeBytes: body.byteLength,
      durationSeconds: normalized.duration,
      normalized: result.changed
    };
  } catch (error) {
    if (finalKey) await deleteObject(finalKey).catch(() => {});
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
