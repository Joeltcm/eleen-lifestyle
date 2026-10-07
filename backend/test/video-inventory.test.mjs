import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/normalizar-videos.mjs'), 'utf8');
const normalizer = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/video-normalizer.ts'), 'utf8');

test('el inventario de videos es explícitamente de solo lectura', () => {
  assert.match(script, /--inventario/);
  assert.match(script, /--solo-r2/);
  assert.match(script, /exercise_videos/);
  assert.match(script, /GetObjectCommand/);
  assert.match(script, /HeadObjectCommand/);
  assert.match(script, /ListObjectsV2Command/);
  assert.match(script, /exerciseIdFromObjectKey/);
  assert.match(normalizer, /moof/);
  assert.match(normalizer, /moov/);
  assert.doesNotMatch(script, /DeleteObjectCommand|PutObjectCommand|CopyObjectCommand/);
  assert.match(script, /No se escribió en PostgreSQL ni en R2/);
  assert.match(script, /No se abrió PostgreSQL/);
});
