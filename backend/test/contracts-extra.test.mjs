// Datos ficticios: nunca incluir aquí los datos legales de la cuenta real.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let server, api, db, n = 0;
const today = () => new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
before(async () => {
  server = await levantar(); api = cliente(server.base); db = postgres(server.databaseUrl, { onnotice: () => {}, max: 1 });
  const setup = await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN }); api.usarToken(setup.datos.token);
  await api.patch('/api/account-settings', { legalName: 'Entrenadora Ficticia', legalId: 'ID-FICTICIO-01', contractCity: 'Ciudad de Prueba' });
}, { timeout: 90000 });
after(async () => { await db?.end({ timeout: 1 }); await server?.parar(); });
const ok = (r, s = 201) => { assert.equal(r.estado, s, JSON.stringify(r.datos)); return r.datos; };
async function escenario() {
  const plan = ok(await api.post('/api/plans', { name: 'Plan extra ' + (++n), billingModel: 'monthly', price: 300, sessionsIncluded: 12 }));
  const client = ok(await api.post('/api/clients', { fullName: 'Ana Extra ' + n, email: `extra${n}@prueba.test`, cutoffDay: Number(today().slice(-2)), planId: plan.id, idDocument: 'PASAPORTE-FICTICIO' }));
  const link = ok(await api.post(`/api/clients/${client.id}/access-link`, {}));
  const access = ok(await api.post('/api/auth/access-link/' + String(link.url).split('acceso=')[1], { password: 'contrasena-portal-larga' }), 200);
  const portal = cliente(server.base); portal.usarToken(access.token);
  return { client, portal };
}

test('los PDF de borrador y de envío no se apilan como "Contrato" en los documentos del expediente: solo aparece el firmado', async () => {
  const s = await escenario();
  const borrador = ok(await api.post(`/api/clients/${s.client.id}/contracts`, { templateKey: 'mensualidad', send: false }));
  ok(await api.post(`/api/contracts/${borrador.id}/send`, {}), 200);
  ok(await s.portal.post(`/api/contracts/${borrador.id}/sign`, { accepted: true, signedName: s.client.full_name }), 200);
  const docs = ok(await api.get(`/api/documents?clientId=${s.client.id}`), 200).filter(d => d.kind === 'contract');
  assert.equal(docs.length, 1, `un solo documento Contrato (el firmado); hay ${docs.length}: ${docs.map(d => d.original_name).join(', ')}`);
  const [firmado] = await db`SELECT pdf_document_id FROM client_contracts WHERE id = ${borrador.id}`;
  assert.equal(docs[0].id, firmado.pdf_document_id);
  assert.match(docs[0].original_name, /^Contrato firmado \d{2}-\d{2}-\d{4}\.pdf$/, 'nombre legible con la fecha de firma');
});

test('un escaneo en papel subido a mano sigue apareciendo en los documentos', async () => {
  const s = await escenario();
  const [doc] = await db`INSERT INTO documents (client_id, kind, object_key, original_name, content_type, size_bytes, upload_status) VALUES (${s.client.id}, 'contract', ${'clients/x/escaneo.pdf'}, 'escaneo.pdf', 'application/pdf', 10, 'ready') RETURNING id`;
  const docs = ok(await api.get(`/api/documents?clientId=${s.client.id}`), 200);
  assert.ok(docs.some(d => d.id === doc.id));
});
