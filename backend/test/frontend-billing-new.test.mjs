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

test('1B-8: Carga inicial y Corte ya no son pestañas; Próximas muestra alertas y lo que emitirá el generador, y la hora de Panamá sigue disponible', async () => {
  const html = await leer('index.html');
  assert.doesNotMatch(html, /data-subtab="carga-inicial"|data-subtab="corte"/);
  assert.match(html, /data-subtab="proximas">Próximas</);
  assert.match(html, /id="subpanel-proximas"/);
  const app = await leer('app.js');
  assert.match(app, /nombre === 'proximas'\) newBillingUpcoming\(\)/);
  assert.match(app, /\/api\/billing\/generation\/plan/);
  assert.match(app, /\/api\/billing\/cutover\/readiness/);
  assert.doesNotMatch(app, /newBillingImport|LEGACY_BILLING_GENERATION=off/, 'ya no hay pantalla de carga ni guía de corte');
  assert.match(app, /function fechaHoraPanama/, 'la bitácora de Reportes la sigue usando');
  assert.doesNotMatch(app, /toLocaleString\('es-PA'[^)]*\)\.replace\(\/\\\/\/g/);
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
  const cuerpo = app.slice(app.indexOf('async function newBillingArchive()'), app.indexOf('// Corregir el reparto por persona'));
  assert.doesNotMatch(cuerpo, /method: '(POST|PATCH|PUT|DELETE)'/, 'el archivo no escribe nada');
  for (const id of ['new-archive-month', 'new-archive-client', 'new-archive-status']) assert.match(cuerpo, new RegExp(id));
});

test('Corregir reparto: botón en cada factura de varias personas y diálogo que exige que el total no cambie', async () => {
  const app = await leer('app.js');
  assert.match(app, /data-new-invoice-split="\$\{invoice\.id\}">Corregir reparto</);
  assert.match(app, /\/api\/billing\/invoices\/\$\{invoice\.id\}\/redistribute/);
  assert.match(app, /debe seguir sumando/);
});

test('Plan de facturación: las líneas ya cerradas van en un historial plegado, no mezcladas con las vigentes', async () => {
  const app = await leer('app.js');
  assert.match(app, /Historial de montos anteriores/);
  assert.match(app, /line\.endsOn && line\.endsOn < hoy/);
});
