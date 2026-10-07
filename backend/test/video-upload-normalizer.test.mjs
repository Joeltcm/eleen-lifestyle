import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const exec = promisify(execFile);
const available = await Promise.all(['ffmpeg', 'ffprobe'].map(async command => {
  try { await exec(command, ['-version']); return true; } catch { return false; }
}));
const skip = { skip: available.every(Boolean) ? false : 'ffmpeg/ffprobe no están instalados; se omite la prueba de alta' };

test('la ruta de alta deja en R2 un MP4 móvil y conserva la subida original', skip, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-upload-normalizer-test-'));
  const r2 = join(directory, 'r2');
  const source = join(directory, 'source.mp4');
  const sourceKey = 'exercises/00000000-0000-0000-0000-000000000001/incoming.mp4';
  const exerciseId = '00000000-0000-0000-0000-000000000001';
  try {
    await mkdir(join(r2, 'exercises', exerciseId), { recursive: true });
    await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=480x854:rate=25', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    await writeFile(join(r2, ...sourceKey.split('/')), await readFile(source));
    process.env.DATABASE_URL = 'postgres://video-test';
    process.env.JWT_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres';
    process.env.SETUP_TOKEN = 'token-de-configuracion-de-prueba';
    process.env.R2_ACCOUNT_ID = 'cuenta-falsa';
    process.env.R2_ACCESS_KEY_ID = 'falsa';
    process.env.R2_SECRET_ACCESS_KEY = 'falsa';
    process.env.R2_BUCKET = 'bucket-falso';
    process.env.FAKE_R2_DIR = r2;
    await import('./fake-s3.mjs');
    const { normalizeRegisteredVideo } = await import('../dist/video-upload-normalizer.js');
    const { inspectVideoFile } = await import('../dist/video-normalizer.js');
    const result = await normalizeRegisteredVideo(sourceKey, exerciseId);
    assert.equal(result.contentType, 'video/mp4');
    assert.ok(result.normalized);
    assert.ok(existsSync(join(r2, ...result.objectKey.split('/'))));
    assert.ok(existsSync(join(r2, ...sourceKey.split('/'))), 'la subida original se conserva');
    const info = await inspectVideoFile(join(r2, ...result.objectKey.split('/')));
    assert.equal(info.needsNormalize, false);
    assert.equal(info.codec, 'h264');
    assert.equal(info.hasAudio, false);
    assert.ok(Math.abs(info.fps - 25) < 0.2, `conserva los 25 fps: ${info.fps}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
