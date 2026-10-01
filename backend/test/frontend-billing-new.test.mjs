// Etapa 1B-2: la pantalla "Facturas (nuevo)" existe y los marcadores de versión coinciden.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const leer = ruta => readFile(new URL(`../../${ruta}`, import.meta.url), 'utf8');

test('la pestaña Facturas y su panel están en la pantalla de Facturación', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="facturas-nuevo">Facturas</);
  assert.match(html, /id="subpanel-facturas-nuevo"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'facturas-nuevo'\) newBillingInvoices\(\)/);
  assert.match(app, /\/api\/billing\/invoices/);
});

test('el panel de facturas tiene filtros por mes, corte y cliente y muestra fechas dd-mm-aaaa', async () => {
  const app = await leer('app.js');
  assert.match(app, /Mes de emisión/);
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

test('la pestaña Cobros existe, es distinta de la de facturas y usa el vocabulario cobro = dinero recibido', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="cobros-nuevo">Cobros</);
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

test('la pestaña Reportes existe, descarga con la sesión y el portal muestra el aviso del beneficiario sin montos', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="reportes-nuevo">Reportes</);
  assert.match(html, /id="subpanel-reportes-nuevo"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'reportes-nuevo'\) newBillingReports\(\)/);
  assert.match(app, /\/api\/billing\/reports\/receivables/);
  assert.match(app, /\/api\/billing\/reports\/delinquency/);
  assert.match(app, /Authorization: `Bearer \$\{authToken\}`/);
  assert.match(app, /portalData\.billingNotice/);
  assert.doesNotMatch(app, /billingNotice\.(amount|balance|payer)/, 'el aviso nunca muestra montos ni pagador');
});

test('cada factura con saldo ofrece "Registrar cobro": abre el formulario con el pagador, el saldo y esa factura primera', async () => {
  const app = await leer('app.js');
  assert.match(app, /data-new-invoice-pay="\$\{invoice\.id\}">Registrar cobro</);
  assert.match(app, /newBillingPaymentDialog\(\{ payerId: invoice\.payerClientId, amount: invoice\.balance, invoiceId: invoice\.id \}\)/);
  assert.match(app, /\(b\.id === firstInvoiceId\) - \(a\.id === firstInvoiceId\)/);
});

test('1B-7: el menú Cobros viejo ya no se ofrece; Facturas es la pestaña de entrada y los datos viejos siguen en la página', async () => {
  const html = await leer('index.html');
  assert.doesNotMatch(html, /data-subtab="cobros">/, 'ya no hay pestaña del sistema anterior');
  assert.match(html, /class="subtab active" data-subtab="facturas-nuevo">Facturas</);
  assert.match(html, /<div class="subpanel active" id="subpanel-facturas-nuevo">/);
  assert.match(html, /id="subpanel-cobros" hidden>/, 'el panel viejo queda oculto, no borrado: sus datos no se tocan');
  const app = await leer('app.js');
  for (const id of ['new-billing-month', 'new-billing-cut', 'new-billing-client', 'new-billing-status']) assert.match(app, new RegExp(id));
});

test('Historial Zoho: pestaña de solo lectura con filtros y sin botones que escriban', async () => {
  const html = await leer('index.html');
  assert.match(html, /data-subtab="archivo">Historial Zoho</);
  assert.match(html, /id="subpanel-archivo"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'archivo'\) newBillingArchive\(\)/);
  const cuerpo = app.slice(app.indexOf('async function newBillingArchive()'), app.indexOf('function newBillingVoidDialog('));
  assert.doesNotMatch(cuerpo, /method: '(POST|PATCH|PUT|DELETE)'/, 'el archivo no escribe nada');
  for (const id of ['new-archive-month', 'new-archive-client', 'new-archive-status']) assert.match(cuerpo, new RegExp(id));
});
