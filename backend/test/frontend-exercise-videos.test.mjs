import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const leer = ruta => readFile(new URL(`../../${ruta}`, import.meta.url), 'utf8');

test('las demostraciones de ejercicios admiten variantes etiquetadas', async () => {
  const [app, server, migration, compressor] = await Promise.all([
    leer('app.js'), leer('backend/src/server.ts'), leer('backend/migrations/056_exercise_videos.sql'), leer('video-compressor.js')
  ]);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS exercise_videos/);
  assert.match(migration, /ON CONFLICT \(owner_id, object_key\) DO NOTHING/);
  assert.match(server, /\/api\/exercises\/:id\/videos-upload-url/);
  assert.match(server, /\/api\/exercises\/:id\/videos/);
  assert.match(server, /\/api\/exercises\/:id\/video-urls/);
  assert.match(app, /multiple hidden \/>Agregar demostraciones/);
  assert.match(app, /videoLabelFromFilename/);
  assert.match(app, /Opción \$\{match\[1\]\}/);
  assert.match(app, /video-urls/);
  assert.match(server, /normalizeRegisteredVideo\(input\.objectKey, id\)/);
  assert.match(server, /formato compatible con móviles/);
  assert.match(compressor, /uploadType/);
});
