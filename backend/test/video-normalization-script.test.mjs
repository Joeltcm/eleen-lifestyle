import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const script = await readFile(new URL('../src/scripts/normalizar-videos.ts', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/061_exercise_video_conversions.sql', import.meta.url), 'utf8');
const down = await readFile(new URL('../migrations-down/061_exercise_video_conversions.down.sql', import.meta.url), 'utf8');

test('el runner de normalización tiene los modos seguros y la reversa registrada', () => {
  for (const flag of ['--inventario', '--dry-run', '--aplicar', '--revertir', '--purgar-originales']) assert.match(script, new RegExp(flag.replaceAll('-', '\\-')));
  assert.match(script, /dist\/scripts\/normalizar-videos\.js/);
  assert.match(script, /Los originales NO fueron borrados/);
  assert.match(script, /video\/mp4/);
  assert.match(script, /No hay conversiones que procesar/);
  assert.match(migration, /exercise_video_conversions/);
  assert.match(migration, /exercise_video_conversion_items/);
  assert.match(down, /DROP TABLE IF EXISTS exercise_video_conversion_items/);
  assert.match(down, /DROP TABLE IF EXISTS exercise_video_conversions/);
});

test('el runner deja el dry-run como modo por defecto y no imprime credenciales', () => {
  assert.match(script, /args\.length === 0 \? '--dry-run'/);
  assert.doesNotMatch(script, /console\.(log|error)\([^)]*(SECRET|DATABASE_URL)/i);
});
