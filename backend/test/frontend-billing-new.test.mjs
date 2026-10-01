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

test('la pestaña Cobros (nuevo) existe, es distinta de la de facturas y usa el vocabulario cobro = dinero recibido', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="cobros-nuevo">Cobros \(nuevo\)</);
  assert.match(html, /id="subpanel-cobros-nuevo"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'cobros-nuevo'\) newBillingPayments\(\)/);
  assert.match(app, /Cobro = dinero recibido/);
  assert.match(app, /\/api\/billing\/payments/);
  assert.match(app, /payment-applications\/\$\{button\.dataset\.reverse\}\/reverse/);
});

test('la pestaña Carga inicial existe, confirma con una palabra y muestra fechas dd-mm-aaaa en hora de Panamá', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="carga-inicial">Carga inicial</);
  assert.match(html, /id="subpanel-carga-inicial"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'carga-inicial'\) newBillingImport\(\)/);
  assert.match(app, /\/api\/billing\/imports\/preview/);
  assert.match(app, /Escribe \$\{escapeHtml\(word\)\} para confirmar/);
  assert.match(app, /function fechaHoraPanama/);
  assert.doesNotMatch(app, /toLocaleString\('es-PA'[^)]*\)\.replace\(\/\\\/\/g/);
});

test('la pestaña Corte existe, no enciende ni apaga nada y explica los interruptores de Railway', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="corte">Corte</);
  assert.match(html, /id="subpanel-corte"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'corte'\) newBillingCutover\(\)/);
  assert.match(app, /LEGACY_BILLING_GENERATION=off/);
  assert.match(app, /NEW_BILLING_GENERATION=on/);
  assert.match(app, /\/api\/billing\/cutover\/readiness/);
  assert.match(app, /Crear los \$\{proposed\.lines\.length\} planes propuestos/);
});
