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

test('Plan de facturación: "Corregir monto" existe como acción aparte de "Cambiar monto" y usa su propio endpoint', async () => {
  const app = await leer('app.js');
  assert.match(app, /data-correct-billing="\$\{line\.id\}">Corregir monto</);
  assert.match(app, /\/api\/billing-subscriptions\/\$\{line\.id\}\/correct-price/);
});

test('Horarios fijos: se pueden AGREGAR desde el administrador (varios por cliente, uno por hora) y el botón de rellenar se explica sin jerga', async () => {
  const app = await leer('app.js');
  assert.match(app, /id="agregar-horario-fijo">\+ Agregar horario fijo</);
  assert.match(app, /function nuevoHorarioFijo\(\)/);
  assert.match(app, /api\('\/api\/session-recurrences', \{ method: 'POST'/);
  assert.match(app, /lun y mar a las 17:30 y vie a las 10:00/);
  assert.match(app, /id="rellenar-horarios">Actualizar el calendario ahora</);
  assert.doesNotMatch(app, /Rellenar días que falten/);
});

test('E1: la sección de planes se llama Tarifas de referencia y avisa que no modifica a los clientes', async () => {
  const html = await leer('index.html');
  assert.match(html, /<h3>Tarifas de referencia<\/h3>/);
  assert.match(html, /Cambiar una tarifa no modifica a los clientes que ya la tienen/);
  assert.match(html, /TARIFA DE REFERENCIA/);
  assert.doesNotMatch(html, /Planes comerciales/);
});

test('J-097: "Pago pendiente" en vez de "vencida", estados con color, sección En pausa en Próximas y la tarjeta de saludo del portal sigue el período', async () => {
  const app = await leer('app.js'); const css = await leer('styles.css');
  assert.match(app, /pendiente: 'Pago pendiente'/);
  const textoEstado = app.slice(app.indexOf('function newBillingStatusText'), app.indexOf('function newBillingStatusChip'));
  assert.doesNotMatch(textoEstado, /vencida/i, 'el estado de las facturas nuevas nunca dice vencida');
  assert.match(app, /function newBillingStatusChip\(invoice\)/);
  assert.match(app, /<p class="eyebrow">EN PAUSA<\/p>/);
  for (const clase of ['pago-pendiente', 'pagada', 'parcial', 'anulada', 'en-pausa']) assert.match(css, new RegExp(`\\.estado-chip\\.${clase}`));
  assert.match(app, /getElementById\('portal-compliance'\)/);
  assert.match(app, /complianceHero\.textContent = `\$\{overall\}%`/);
  assert.match(app, /Hola, \$\{welcomeName\}/);
});

test('E2: las tarifas tienen zona/especial y el plan de facturación ofrece sugerencias editables', async () => {
  const [html, app] = await Promise.all([leer('index.html'), leer('app.js')]);
  for (const zona of ['Costa del Este', 'Paitilla', 'San Francisco', 'La Cresta']) assert.match(html, new RegExp(zona));
  assert.match(html, /name="specialFor"/);
  assert.match(app, /plan-zone-filter/);
  assert.match(app, /plan-sessions-filter/);
  assert.match(app, /Mostrar tarifas especiales/);
  assert.match(app, /No crea ningún vínculo con la tarifa/);
  assert.match(app, /specialFor/);
});

test('cobro "Sesión individual": avisa y desmarca "La clase ya se dio" si la persona ya tiene clase ese día (evita dobles, J-101)', async () => {
  const app = await leer('app.js');
  assert.match(app, /const revisarClaseDelDia = /);
  assert.match(app, /Registrar otra la deja doble/);
  assert.match(app, /desmarcadaPorAviso/);
  assert.match(app, /Registrar "La clase ya se dio" crea OTRA clase ese día/);
});

test('estado de la clase: solo Sin estado / Cumplió (verde) / Cancelar (rojo); "No asistió" ya no se ofrece (agenda ni recordatorios)', async () => {
  const app = await leer('app.js'); const css = await leer('styles.css');
  const form = app.slice(app.indexOf('const sessionComplianceForm'), app.indexOf('function renderDashboard'));
  assert.match(form, /value="scheduled"/); assert.match(form, /value="completed"/); assert.match(form, /data-cancel-session/);
  assert.doesNotMatch(form, /no_show|No asistió/);
  assert.doesNotMatch(app, /data-marcar="no_show"/);
  assert.match(css, /\.outcome-done/); assert.match(css, /\.outcome-cancel/);
  assert.equal((app.match(/data-cancel-session="\$\{session\.id\}"/g) || []).length, 1, 'un solo botón Cancelar por clase');
});

test('ajustes visuales iPhone 15 Plus / iPad Pro 11" (v271): tablas de Facturación como tarjetas, calendario semanal y portal sin desbordes', async () => {
  const css = await leer('styles.css');
  assert.match(css, /iPhone 15 Plus \/ Pro Max \(430 px\) e iPad Pro 11"/);
  assert.match(css, /\.view:has\(#billing-subtabs\) \.stack-mobile td\[data-label=""\]/);
  assert.match(css, /\.calendar-period-nav\{grid-template-columns:44px minmax\(0,1fr\) 44px 58px/);
  assert.match(css, /\.portal-period-nav\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(css, /\.calendar-week \.day-col\{display:flex;flex-direction:column/);
});

test('cumplimiento del Resumen: "Últimos 7 días", "perdidas" y sin saldo del ciclo para quien entrena a crédito (v272)', async () => {
  const app = await leer('app.js'); const html = await leer('index.html');
  assert.match(html, /<option value="week">Últimos 7 días<\/option><option value="month">Último mes<\/option>/);
  assert.match(app, /perdida\$\{client\.missed === 1 \? '' : 's'\}/);
  assert.doesNotMatch(app, /sin hacer`/);
  assert.match(app, /c\.paymentMode === 'no_anticipado'\)\) return ''/);
});

test('rutina en lugar de la clase (J-102): diálogo de cancelación, IA para el cliente, cronómetro del portal, tarjeta de rutinas cumplidas y aviso sonoro', async () => {
  const app = await leer('app.js'); const sw = await leer('sw.js'); const css = await leer('styles.css');
  assert.match(app, /id="ofrecer-rutina">No puedo atenderla: ofrecerle una rutina/);
  const dialogoCliente = app.slice(app.indexOf('const preguntarDestinoCliente'), app.indexOf('const preguntarCompensacion'));
  assert.doesNotMatch(dialogoCliente, /ofrecer-rutina/, 'la oferta no aparece cuando cancela el cliente: solo cuando Eileen no puede atender');
  assert.match(app, /forClient: true, durationMinutes: sesion\.durationMinutes/);
  assert.match(app, /\/routine-offer`, \{ method: 'POST', body: \{ routineId: guardada\.id \}/);
  assert.match(app, /vale solo este día/); assert.match(app, /routineOfferExpired/);
  assert.match(app, /data-routine-timer/); assert.match(app, /data-timer-toggle/);
  assert.match(app, /portal-routines-done-card/); assert.match(app, /Rutinas cumplidas/);
  assert.match(app, /durationSeconds: segundos/);
  assert.match(app, /function sonarAviso\(\)/); assert.match(app, /EILEEN_PUSH/);
  assert.match(sw, /requireInteraction = true/); assert.match(sw, /type: 'EILEEN_PUSH'/);
  assert.match(css, /\.routine-timer\.corriendo/); assert.match(css, /\.portal-offer-card/);
});
