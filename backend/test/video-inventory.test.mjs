import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/normalizar-videos.mjs'), 'utf8');

test('el inventario de videos es explícitamente de solo lectura', () => {
  assert.match(script, /--inventario/);
  assert.match(script, /exercise_videos/);
  assert.match(script, /GetObjectCommand/);
  assert.match(script, /moof/);
  assert.match(script, /moov/);
  assert.doesNotMatch(script, /DeleteObjectCommand|PutObjectCommand|CopyObjectCommand/);
  assert.match(script, /No se escribió en PostgreSQL ni en R2/);
});
