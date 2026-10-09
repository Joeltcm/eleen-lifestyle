// Datos ficticios: nunca incluir aquí los datos legales de la cuenta real.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';
import { abrirPantalla, esperar } from './ui-harness.mjs';
import { renderContractTemplate, contractTimestamp } from '../dist/contracts.js';

let server, api, db, token, scenarioNumber = 0;
const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
before(async () => {
  server = await levantar(); api = cliente(server.base);
  db = postgres(server.databaseUrl, { onnotice: () => {}, max: 1 });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  token = setup.datos.token; api.usarToken(token);
  const settings = await api.patch('/api/account-settings', { legalName: 'Entrenadora Ficticia', legalId: 'ID-FICTICIO-01', contractCity: 'Ciudad de Prueba' });
  assert.equal(settings.estado, 200, JSON.stringify(settings.datos));
}, { timeout: 90000 });
after(async () => { await db?.end({ timeout: 1 }); await server?.parar(); });
const ok = (result, status = 201) => { assert.equal(result.estado, status, JSON.stringify(result.datos)); return result.datos; };
async function scenario(model = 'mensualidad', extra = {}) {
  const plan = ok(await api.post('/api/plans', { name: 'Plan ficticio ' + model + ' ' + (++scenarioNumber), billingModel: model === 'paquete' ? 'package' : 'monthly',
    price: model === 'rutinas' ? 90 : 300, ...(model === 'rutinas' ? { serviceType: 'rutinas', routinesPerMonth: 4 } : { sessionsIncluded: 12 }),
    ...extra.plan }));
  const client = ok(await api.post('/api/clients', { fullName: 'María Contrato ' + model, email: model + Math.random().toString(36).slice(2) + '@prueba.test',
    cutoffDay: Number(today().slice(-2)), planId: plan.id, idDocument: 'PASAPORTE-FICTICIO', ...extra.client }));
  const link = ok(await api.post('/api/clients/' + client.id + '/access-link', {}), 201);
  const access = ok(await api.post('/api/auth/access-link/' + String(link.url).split('acceso=')[1], { password: 'contrasena-portal-larga' }), 200);
  const portal = cliente(server.base); portal.usarToken(access.token);
  return { plan, client, portal, portalToken: access.token };
}
const generate = async (s, extra = {}) => ok(await api.post('/api/clients/' + s.client.id + '/contracts', { templateKey: s.plan.service_type === 'rutinas' ? 'rutinas' : s.plan.billing_model === 'package' ? 'paquete' : 'mensualidad', send: true, ...extra }));
// PDFKit usa Helvetica/WinAnsi. Inspeccionamos los operandos hexadecimales de
// sus streams de texto: no dependemos de una instalación externa en CI.
function pdfText(bytes) {
  const source = bytes.toString('latin1'); let text = '';
  for (const match of source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let stream; try { stream = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { continue; }
    for (const operand of stream.matchAll(/<([0-9a-f]+)>/gi)) text += Buffer.from(operand[1], 'hex').toString('latin1');
  }
  return text.replace(/\s+/g, ' ');
}

test('los tres modelos usan valores del expediente y las constantes, incluso un precio propio distinto del catálogo', async () => {
  for (const model of ['mensualidad', 'paquete', 'rutinas']) {
    const s = await scenario(model);
    if (model === 'mensualidad') ok(await api.patch('/api/clients/' + s.client.id, { fullName: s.client.full_name, standardPrice: 276, monthlySessionTarget: 8 }), 200);
    const preview = ok(await api.post('/api/clients/' + s.client.id + '/contracts/preview', { templateKey: model, commitmentMonths: 3 }), 200);
    assert.equal(preview.canSend, true); assert.doesNotMatch(preview.bodyText, /\{\{|undefined/);
    const text = pdfText(Buffer.from(preview.pdfBase64, 'base64'));
    assert.match(text, /Entrenadora Ficticia/); assert.match(text, /PASAPORTE-FICTICIO/);
    assert.match(text, model === 'rutinas' ? /4 rutinas.*90\.00/ : model === 'paquete' ? /12 sesiones.*300\.00/ : /8 clases.*276\.00/);
    if (model === 'paquete') { assert.match(text, /42 d[ií]as/); assert.match(text, /28 d[ií]as/); }
    else assert.match(text, new RegExp('corte.*' + Number(today().slice(-2))));
    const contract = await generate(s); assert.equal(contract.status, 'enviado'); assert.ok(contract.pdf_document_id);
  }
});
test('faltan identidad, legales o plan: puede previsualizar, pero no enviar; no hay inserción parcial', async () => {
  const s = await scenario('mensualidad', { client: { idDocument: '' } });
  const before = (await api.get('/api/clients/' + s.client.id + '/contracts')).datos.length;
  const preview = ok(await api.post('/api/clients/' + s.client.id + '/contracts/preview', {}), 200);
  assert.equal(preview.canSend, false); assert.match(preview.missing.join(', '), /identidad/);
  assert.match(ok(await api.post('/api/clients/' + s.client.id + '/contracts', { send: true }), 409).error, /identidad/);
  assert.equal((await api.get('/api/clients/' + s.client.id + '/contracts')).datos.length, before);
  ok(await api.patch('/api/account-settings', { legalName: '', legalId: '', contractCity: '' }), 200);
  const missing = ok(await api.post('/api/clients/' + s.client.id + '/contracts', { send: true }), 409);
  assert.match(missing.error, /nombre legal.*identificación legal.*ciudad/);
  ok(await api.patch('/api/account-settings', { legalName: 'Entrenadora Ficticia', legalId: 'ID-FICTICIO-01', contractCity: 'Ciudad de Prueba' }), 200);
  await db`UPDATE clients SET plan_id = NULL WHERE id = ${s.client.id}`;
  assert.match(ok(await api.post('/api/clients/' + s.client.id + '/contracts', { send: true }), 409).error, /plan/);
});
test('guardar otra parte del expediente no borra los nuevos campos; un borrador se envía con los datos vigentes', async () => {
  const s = await scenario(); const draft = ok(await api.post('/api/clients/' + s.client.id + '/contracts', {}));
  const edited = ok(await api.patch('/api/clients/' + s.client.id, { fullName: s.client.full_name, birthDate: '', address: 'Dirección ficticia' }), 200);
  assert.equal(edited.id_document, 'PASAPORTE-FICTICIO');
  ok(await api.patch('/api/clients/' + s.client.id, { fullName: s.client.full_name }), 200);
  const sent = ok(await api.post('/api/contracts/' + draft.id + '/send', {}), 200);
  assert.equal(sent.values.CLIENT_ADDRESS, 'Dirección ficticia'); assert.equal(sent.status, 'enviado');
});
test('aceptación correcta: PDF firmado, SHA exacto, evidencia, aviso único; otro cliente recibe 404', async () => {
  const s = await scenario(); const contract = await generate(s);
  assert.equal((await s.portal.post('/api/contracts/' + contract.id + '/sign', { accepted: true, signedName: 'Nombre diferente' })).estado, 400);
  assert.equal((await s.portal.post('/api/contracts/' + contract.id + '/sign', { signedName: s.client.full_name })).estado, 400);
  const other = await scenario(); assert.equal((await other.portal.get('/api/contracts/' + contract.id + '/download')).estado, 404);
  assert.equal((await other.portal.post('/api/contracts/' + contract.id + '/sign', { accepted: true, signedName: s.client.full_name })).estado, 404);
  const signed = ok(await s.portal.post('/api/contracts/' + contract.id + '/sign', { accepted: true, signedName: 'MARIA CONTRATO MENSUALIDAD' }), 200);
  assert.equal(signed.status, 'firmado'); assert.match(signed.body_text, /Aceptado electrónicamente/); assert.ok(signed.signed_ip && signed.signed_user_agent);
  const download = await fetch(server.base + '/api/contracts/' + contract.id + '/pdf', { headers: { Authorization: 'Bearer ' + s.portalToken } });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer()); assert.equal(createHash('sha256').update(bytes).digest('hex'), signed.pdf_sha256);
  assert.match(pdfText(bytes), /Aceptado electr[oó]nicamente/);
  assert.equal((await db`SELECT kind FROM documents WHERE id = ${signed.pdf_document_id}`)[0].kind, 'contract');
  assert.equal((await s.portal.post('/api/contracts/' + contract.id + '/sign', { accepted: true, signedName: s.client.full_name })).estado, 409);
  const notices = (await api.get('/api/notifications')).datos.filter(x => x.title.includes('Contrato firmado'));
  assert.equal(notices.filter(x => x.body.includes('firmó')).length, 1);
});
test('firma congelada en SQL: ni texto ni PDF ni borrado; nuevo contrato reemplaza sin duplicar vigentes', async () => {
  const s = await scenario(); const c1 = await generate(s);
  const first = ok(await s.portal.post('/api/contracts/' + c1.id + '/sign', { accepted: true, signedName: s.client.full_name }), 200);
  await assert.rejects(db`UPDATE client_contracts SET body_text = 'Cambio' WHERE id = ${c1.id}`, /inmutable/);
  await assert.rejects(db`UPDATE client_contracts SET values = '{}'::jsonb WHERE id = ${c1.id}`, /inmutable/);
  await assert.rejects(db`DELETE FROM documents WHERE id = ${first.pdf_document_id}`, /inmutable/);
  assert.equal((await api.delete('/api/clients/' + s.client.id)).estado, 409);
  ok(await api.patch('/api/plans/' + s.plan.id, { name: s.plan.name, billingModel: 'monthly', price: 330, sessionsIncluded: 12 }), 200);
  ok(await api.patch('/api/clients/' + s.client.id + '/plan', { planId: s.plan.id, cutoffDay: 15 }), 200);
  const c2 = await generate(s);
  const results = await Promise.all([1, 2].map(() => s.portal.post('/api/contracts/' + c2.id + '/sign', { accepted: true, signedName: s.client.full_name })));
  assert.deepEqual(results.map(x => x.estado).sort(), [200, 409]);
  const rows = (await api.get('/api/clients/' + s.client.id + '/contracts')).datos;
  assert.equal(rows.filter(x => x.status === 'firmado').length, 1);
  assert.equal(rows.find(x => x.id === c1.id).status, 'reemplazado');
  const [old] = await db`SELECT body_text, values FROM client_contracts WHERE id = ${c1.id}`;
  assert.equal(old.body_text, first.body_text); assert.equal(old.values.PRICE, '$300.00');
  assert.equal(rows.find(x => x.id === c2.id).values.PRICE, '$330.00');
});
test('menor: nombre e identificación de representante obligatorios; quedan en evidencia y PDF', async () => {
  const year = Number(today().slice(0, 4)) - 16; const s = await scenario('mensualidad', { client: { birthDate: year + '-01-01' } });
  const contract = await generate(s);
  assert.equal((await s.portal.get('/api/contracts/' + contract.id + '/download')).datos.requiresGuardian, true);
  assert.equal((await s.portal.post('/api/contracts/' + contract.id + '/sign', { accepted: true, signedName: s.client.full_name })).estado, 400);
  const signed = ok(await s.portal.post('/api/contracts/' + contract.id + '/sign', { accepted: true, signedName: s.client.full_name, guardianName: 'Tutor Ficticio', guardianId: 'TUTOR-TEST' }), 200);
  assert.equal(signed.guardian_name, 'Tutor Ficticio'); assert.match(signed.body_text, /TUTOR-TEST/);
});
test('papel: exige escaneo listo del mismo expediente; no vale el PDF sin firmar generado', async () => {
  const s = await scenario(); const c = await generate(s);
  assert.equal((await api.post('/api/clients/' + s.client.id + '/contracts/paper', { contractId: c.id })).estado, 400);
  assert.equal((await api.post('/api/clients/' + s.client.id + '/contracts/paper', { contractId: c.id, documentId: c.pdf_document_id })).estado, 400);
  const [scan] = await db`INSERT INTO documents (client_id, kind, object_key, original_name, content_type, upload_status) VALUES (${s.client.id}, 'contract', 'clients/test/contract/scan.pdf', 'scan.pdf', 'application/pdf', 'ready') RETURNING id`;
  const signed = ok(await api.post('/api/clients/' + s.client.id + '/contracts/paper', { contractId: c.id, documentId: scan.id }), 200);
  assert.equal(signed.signed_name, 'Firma en papel'); assert.equal(signed.pdf_document_id, scan.id);
});
test('plan solo rutinas: sin clases ni paquete; mensualidad normal, índice y CHECK válidos', async () => {
  const s = await scenario('rutinas');
  assert.equal((await api.post('/api/sessions', { clientId: s.client.id, startsAt: new Date().toISOString(), durationMinutes: 45, mode: 'Virtual' })).estado, 409);
  assert.equal((await db`SELECT count(*)::int AS n FROM session_packages WHERE client_id = ${s.client.id}`)[0].n, 0);
  const membership = (await db`SELECT amount, renewal_day FROM memberships WHERE client_id = ${s.client.id}`)[0];
  assert.equal(Number(membership.amount), 90); assert.equal(membership.renewal_day, Number(today().slice(-2)));
  ok(await api.post('/api/billing/recurring/generate', {}), 200);
  assert.ok((await db`SELECT id FROM invoices WHERE client_id = ${s.client.id} AND amount = 90`).length, 'la misma generación mensual cobra rutinas');
  assert.equal((await db`SELECT count(*)::int AS n FROM session_packages WHERE client_id = ${s.client.id}`)[0].n, 0, 'el generador tampoco abre clases');
  await assert.rejects(db`UPDATE service_plans SET service_type = 'desconocido' WHERE id = ${s.plan.id}`, /check/);
});
test('plantilla: marcador sin valor impide generar; fecha y hora exactas de Panamá', () => {
  assert.throws(() => renderContractTemplate('mensualidad', {}), /marcadores sin resolver/);
  assert.equal(contractTimestamp(new Date('2030-07-09T04:31:00Z')), '08-07-2030 23:31');
});
test('otro dueño no ve, genera, envía ni descarga contratos; resumen solo de la cuenta', async () => {
  const s = await scenario(); const c = await generate(s);
  await db`INSERT INTO users (email, password_hash, full_name, role) SELECT 'otro.contratos@prueba.test', password_hash, 'Otra Entrenadora', 'trainer' FROM users WHERE email = ${CREDENCIALES.email}`;
  const other = cliente(server.base);
  other.usarToken(ok(await other.post('/api/auth/login', { email: 'otro.contratos@prueba.test', password: CREDENCIALES.password }), 200).token);
  for (const path of ['/api/clients/' + s.client.id + '/contracts', '/api/contracts/' + c.id + '/download', '/api/contracts/' + c.id + '/pdf']) assert.equal((await other.get(path)).estado, 404);
  assert.equal((await other.post('/api/clients/' + s.client.id + '/contracts', { send: true })).estado, 404);
  assert.equal((await other.post('/api/contracts/' + c.id + '/send', {})).estado, 404);
  assert.deepEqual((await other.get('/api/contracts/pending-summary')).datos, { pending: 0, overdue: 0 });
  await db`UPDATE client_contracts SET sent_at = now() - interval '4 days' WHERE id = ${c.id}`;
  const summary = (await api.get('/api/contracts/pending-summary')).datos;
  assert.ok(summary.pending > 0 && summary.overdue > 0);
});
test('paquete no hereda una meta mensual vieja; oferta mensual de rutinas se factura también en el motor nuevo', async () => {
  const pack = await scenario('paquete', { plan: { sessionsIncluded: 6 } });
  await db`UPDATE clients SET monthly_session_target = 18 WHERE id = ${pack.client.id}`;
  assert.equal((await generate(pack)).values.SESSIONS, 6);
  const s = await scenario('rutinas');
  const prevDate = new Date(today() + 'T12:00:00Z'); prevDate.setUTCMonth(prevDate.getUTCMonth() - 1); prevDate.setUTCDate(1);
  const start = prevDate.toISOString().slice(0, 10);
  ok(await api.post('/api/clients/' + s.client.id + '/billing-subscriptions', { beneficiaryClientId: s.client.id, payerClientId: s.client.id, kind: 'monthly', price: 90, startsOn: start }));
  ok(await api.post('/api/billing/invoices', { payerClientId: s.client.id, kind: 'mensual', cycleStart: start, cycleEnd: today(), issuedOn: start, lines: [{ beneficiaryClientId: s.client.id, unitAmount: 90, description: 'Rutinas mensuales' }] }));
  process.env.DATABASE_URL = server.databaseUrl; process.env.JWT_SECRET = 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres'; process.env.SETUP_TOKEN = SETUP_TOKEN; process.env.NODE_ENV = 'test';
  const gen = await import('../dist/billing-generator.js'); const moduleDb = await import('../dist/db.js');
  try {
    const emitted = await gen.runBillingGeneration(s.client.owner_id, today());
    const invoice = emitted.created.find(row => row.payerName === s.client.full_name);
    assert.ok(invoice); assert.equal(invoice.kind, 'mensual'); assert.equal(invoice.total, 90);
    assert.equal((await db`SELECT count(*)::int AS n FROM session_packages WHERE client_id = ${s.client.id}`)[0].n, 0);
  } finally { await moduleDb.sql.end({ timeout: 1 }); }
});
test('horario fijo previo no se extiende al pasar a solo rutinas; agenda individual y batch rechazan', async () => {
  const s = await scenario('rutinas');
  await db`INSERT INTO session_recurrences (client_id, weekdays, time_of_day, duration_minutes, mode, ends_on) VALUES (${s.client.id}, ARRAY[0,1,2,3,4,5,6], '10:00', 45, 'Virtual', NULL)`;
  ok(await api.post('/api/session-recurrences/extend', {}), 200);
  assert.equal((await db`SELECT count(*)::int AS n FROM sessions WHERE client_id = ${s.client.id}`)[0].n, 0);
  assert.equal((await api.post('/api/sessions/batch', { clientId: s.client.id, startsAt: [new Date().toISOString()], durationMinutes: 45, mode: 'Virtual' })).estado, 409);
  assert.equal((await api.post('/api/session-recurrences', { clientId: s.client.id, weekdays: [1], timeOfDay: '09:00' })).estado, 409);
});
test('pantalla a 375 px: expediente, mensualidad sugerida, PDF, aceptación con scroll y sin errores', async () => {
  const s = await scenario();
  const staff = await abrirPantalla({ baseApi: server.base, token, ancho: 375 });
  try {
    await esperar(() => staff.evaluar('data.clients.length') > 0);
    staff.evaluar(`clientDetail('${s.client.id}')`);
    await esperar(() => staff.q('#generate-client-contract'));
    staff.clic(staff.q('#generate-client-contract'));
    assert.equal(staff.q('#contract-editor [name="templateKey"]').value, 'mensualidad');
    staff.clic(staff.q('#preview-contract'));
    await esperar(() => staff.q('.contract-pdf-preview'));
    assert.match(staff.q('.contract-pdf-preview').src, /^data:application\/pdf/);
    staff.q('#contract-editor [name="send"]').checked = true;
    staff.q('#contract-editor').dispatchEvent(new staff.window.Event('submit', { bubbles: true, cancelable: true }));
    await esperar(() => staff.q('#client-contracts')?.textContent.includes('Pendiente de firma'));
    assert.deepEqual(staff.errores, []);
  } finally { await staff.cerrar(); }
  const p = await abrirPantalla({ baseApi: server.base, token: s.portalToken, ancho: 375, hash: '#portal-routines' });
  try {
    await esperar(() => p.q('[data-portal-sign-contract]'));
    p.clic(p.q('[data-portal-sign-contract]'));
    const scroll = p.q('.contract-text');
    Object.defineProperties(scroll, { scrollHeight: { value: 1400 }, clientHeight: { value: 300 } });
    await esperar(() => p.q('.contract-text')?.textContent.includes('CONTRATO DE'));
    scroll.scrollTop = 0; scroll.dispatchEvent(new p.window.Event('scroll'));
    assert.equal(p.q('[name="accept"]').disabled, true);
    scroll.scrollTop = 1100; scroll.dispatchEvent(new p.window.Event('scroll'));
    assert.equal(p.q('[name="accept"]').disabled, false);
    p.q('[name="accept"]').checked = true; p.q('[name="accept"]').dispatchEvent(new p.window.Event('change'));
    p.cambiar(p.q('[name="signedName"]'), s.client.full_name);
    p.q('#portal-sign-contract').dispatchEvent(new p.window.Event('submit', { bubbles: true, cancelable: true }));
    await esperar(() => p.q('#portal-contracts')?.textContent.includes('Contrato firmado'));
    assert.deepEqual(p.errores, []);
  } finally { await p.cerrar(); }
});
test('070: reversa rechaza con datos, acepta orden expresa y sin datos', async () => {
  const down = await readFile(new URL('../migrations-down/070_contracts_from_client_file.down.sql', import.meta.url), 'utf8');
  await assert.rejects(db.unsafe(down), /orden expresa/);
  await db.unsafe('ROLLBACK');
  await db.unsafe("SET billing.allow_destructive_down = 'on'");
  await db.unsafe(down);
  assert.equal((await db`SELECT to_regclass('client_contracts') AS name`)[0].name, null);
  await db.unsafe(await readFile(new URL('../migrations/070_contracts_from_client_file.sql', import.meta.url), 'utf8'));
  await db.unsafe("SET billing.allow_destructive_down = 'off'");
  await db.unsafe(down);
  assert.equal((await db`SELECT to_regclass('client_contracts') AS name`)[0].name, null);
});
