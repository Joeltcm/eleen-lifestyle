// Etapa 1B-2: la pantalla "Facturas (nuevo)" existe y los marcadores de versión coinciden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const leer = ruta => readFile(new URL(`../../${ruta}`, import.meta.url), 'utf8');

test('la pestaña Facturas (nuevo) y su panel están en la pantalla de Facturación', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="facturas-nuevo">Facturas \(nuevo\)</);
  assert.match(html, /id="subpanel-facturas-nuevo"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'facturas-nuevo'\) newBillingInvoices\(\)/);
  assert.match(app, /\/api\/billing\/invoices/);
});

test('el módulo nuevo muestra fechas dd-mm-aaaa y el aviso de que no reemplaza al sistema actual', async () => {
  const app = await leer('app.js');
  assert.match(app, /Módulo nuevo \(interno\)/);
  assert.match(app, /fechaCorta\(invoice\.cycleStart\)/);
  assert.doesNotMatch(app, /newBilling[^\n]*toISOString\(\)\.slice\(0, 10\)/);
});

test('app.js, sw.js, version.json e index.html llevan la misma versión', async () => {
  const [app, sw, version, html] = await Promise.all(['app.js', 'sw.js', 'version.json', 'index.html'].map(leer));
  const enApp = /const APP_VERSION = '(\d+)'/.exec(app)[1];
  assert.equal(/const VERSION = '(\d+)'/.exec(sw)[1], enApp);
  assert.equal(JSON.parse(version).version, enApp);
  const marcas = [...html.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
  assert.equal(marcas.length, 7);
  assert.ok(marcas.every(v => v === enApp), `index.html tiene ${[...new Set(marcas)]} y app.js ${enApp}`);
});
