// La guardia del frontend (J-116) debe atrapar los defectos que ya llegaron a producción; si dejara de atraparlos, esta prueba lo dice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { revisarFrontend } from '../../scripts/guard-ui.mjs';

async function proyecto({ app = '', otro = '', version = { app: '1', sw: '1', json: '1', html: '1' } } = {}) {
  const carpeta = await mkdtemp(join(tmpdir(), 'guardia-'));
  await writeFile(join(carpeta, 'index.html'), `<html><body><script src="./app.js?v=${version.html}"></script><script src="./zoho-migration.js?v=${version.html}"></script></body></html>`);
  await writeFile(join(carpeta, 'app.js'), `const APP_VERSION = '${version.app}';\n${app}\n`);
  await writeFile(join(carpeta, 'zoho-migration.js'), `${otro}\n`);
  await writeFile(join(carpeta, 'sw.js'), `const VERSION = '${version.sw}';\n`);
  await writeFile(join(carpeta, 'version.json'), JSON.stringify({ version: version.json }));
  return carpeta;
}
const revisar = async opciones => { const carpeta = await proyecto(opciones); try { return (await revisarFrontend(carpeta)).problemas; } finally { await rm(carpeta, { recursive: true, force: true }); } };

test('un proyecto sano pasa', async () => assert.deepEqual(await revisar({ app: 'function hola() { return 1; }\nhola();', otro: 'hola();' }), []));

test('llamar a una función que no existe se detecta (la v286: portalRoutineCard)', async () => {
  const problemas = await revisar({ app: 'const lista = [1].map(portalRoutineCard);' });
  assert.equal(problemas.length, 1); assert.match(problemas[0], /app.js:2.*portalRoutineCard.*not defined/);
});

test('lo que un script declara lo ve el siguiente (ámbito global compartido), y lo publicado con window.X también', async () => {
  assert.deepEqual(await revisar({ app: 'function compartida() {}\nwindow.Publicada = { ok: true };', otro: 'compartida(); Publicada.ok;' }), []);
  const problemas = await revisar({ app: 'function compartida() {}', otro: 'noExiste();' });
  assert.match(problemas[0], /zoho-migration.js:1.*noExiste/);
});

test('declarar dos veces lo mismo (const entre scripts o función repetida) se detecta', async () => {
  assert.ok((await revisar({ app: 'const dinero = 1;', otro: 'const dinero = 2;' })).length >= 1);
  assert.ok((await revisar({ app: 'function repetida() { return 1; }\nfunction repetida() { return 2; }' })).some(p => /already defined|already been declared/i.test(p)));
});

test('un error de sintaxis se detecta', async () => assert.ok((await revisar({ app: 'function rota( {' })).length >= 1));

test('los marcadores de versión desparejados se detectan (los que hacen que el navegador conserve el JavaScript viejo)', async () => {
  const problemas = await revisar({ version: { app: '10', sw: '10', json: '9', html: '10' } });
  assert.equal(problemas.length, 1); assert.match(problemas[0], /marcadores de versión no coinciden/);
});

test('un recurso que index.html carga y no existe se detecta', async () => {
  const carpeta = await proyecto();
  try {
    await writeFile(join(carpeta, 'index.html'), '<html><script src="./app.js?v=1"></script><script src="./zoho-migration.js?v=1"></script><link rel="stylesheet" href="./falta.css?v=1"></html>');
    assert.ok((await revisarFrontend(carpeta)).problemas.some(p => /falta\.css/.test(p)));
  } finally { await rm(carpeta, { recursive: true, force: true }); }
});

test('el frontend real del repositorio pasa la guardia', async () => assert.deepEqual((await revisarFrontend()).problemas, []));
