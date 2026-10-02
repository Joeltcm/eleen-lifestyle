// Documentos PDF con nombre de archivo (J-100): el boleto da una URL cuyo último tramo es el nombre y que responde con Content-Disposition.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { CREDENCIALES, SETUP_TOKEN, cliente, levantar } from './harness.mjs';

let servidor; let api; let facturaId;
before(async () => {
  servidor = await levantar();
  api = cliente(servidor.base);
  await api.post('/api/auth/setup', CREDENCIALES, { 'x-setup-token': SETUP_TOKEN });
  const login = await api.post('/api/auth/login', { email: CREDENCIALES.email, password: CREDENCIALES.password });
  api.usarToken(login.datos.token);
  const c = (await api.post('/api/clients', { fullName: 'Ana', cutoffDay: 1, email: 'ana@prueba.test' })).datos.id;
  const f = await api.post('/api/billing/invoices', { payerClientId: c, kind: 'mensual', cycleStart: '2026-09-01', cycleEnd: '2026-10-01', issuedOn: '2026-09-01', lines: [{ beneficiaryClientId: c, unitAmount: 100 }] });
  assert.equal(f.estado, 201); facturaId = f.datos.id;
}, { timeout: 90_000 });
after(async () => { await servidor?.parar(); });

const pedir = (ruta, cabeceras = {}) => fetch(`${servidor.base}${ruta}`, { headers: cabeceras });

test('el boleto canjea una URL con el NOMBRE del archivo y responde el PDF sin enviar la sesión, inline y como descarga', async () => {
  const t = await api.post('/api/pdf-tickets', { path: `/api/billing/invoices/${facturaId}/pdf` });
  assert.equal(t.estado, 200, JSON.stringify(t.datos));
  const url = `/api/pdf-ticket/${t.datos.id}/factura-FAC-0001.pdf`;
  const inline = await pedir(url);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.match(inline.headers.get('content-disposition'), /^inline; filename="factura-FAC-0001\.pdf"$/);
  assert.equal(inline.headers.get('cache-control'), 'private, no-store');
  const cuerpo = Buffer.from(await inline.arrayBuffer());
  assert.equal(cuerpo.subarray(0, 5).toString(), '%PDF-');
  const descarga = await pedir(`${url}?download=1`);
  assert.match(descarga.headers.get('content-disposition'), /^attachment; filename="factura-FAC-0001\.pdf"$/);
});

test('el nombre se sanea y siempre termina en .pdf', async () => {
  const t = await api.post('/api/pdf-tickets', { path: `/api/billing/invoices/${facturaId}/pdf` });
  const r = await pedir(`/api/pdf-ticket/${t.datos.id}/${encodeURIComponent('factura FAC-0001 ñ/..\\x')}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /filename="[A-Za-z0-9._-]+\.pdf"/);
});

test('seguridad: sin sesión no se pide boleto; solo rutas /api de PDF; un boleto inventado o de otra persona no abre nada', async () => {
  assert.equal((await cliente(servidor.base).post('/api/pdf-tickets', { path: `/api/billing/invoices/${facturaId}/pdf` })).estado, 401);
  assert.equal((await api.post('/api/pdf-tickets', { path: '/api/clients' })).estado, 400, 'no es un PDF');
  assert.equal((await api.post('/api/pdf-tickets', { path: '/api/billing/invoices/../../auth/login/pdf' })).estado, 400, 'sin ..');
  assert.equal((await api.post('/api/pdf-tickets', { path: 'https://otro.sitio/api/x/pdf' })).estado, 400, 'solo rutas /api propias');
  assert.equal((await pedir('/api/pdf-ticket/inventado/a.pdf')).status, 404);
  // un PDF que no existe (factura inexistente) devuelve el error de la ruta original, no un PDF vacío
  const t = await api.post('/api/pdf-tickets', { path: '/api/billing/invoices/00000000-0000-4000-8000-000000000000/pdf' });
  assert.equal((await pedir(`/api/pdf-ticket/${t.datos.id}/x.pdf`)).status, 404);
});

test('el concepto de la línea en el PDF no dice "plan familiar" (Ernesto, plan familiar (4 clases) -> Ernesto (4 clases)); lo guardado no cambia', async () => {
  const { lineConceptText } = await import('../dist/billing-reports.js');
  assert.equal(lineConceptText('Ernesto, plan familiar (4 clases)'), 'Ernesto (4 clases)');
  assert.equal(lineConceptText('Plan familiar Iraida (8 clases)'), 'Iraida (8 clases)');
  assert.equal(lineConceptText('Iraida (8 clases)'), 'Iraida (8 clases)');
  assert.equal(lineConceptText('Mensualidad'), 'Mensualidad');
  const c = (await api.post('/api/clients', { fullName: 'Ernesto', cutoffDay: 1 })).datos.id;
  const f = await api.post('/api/billing/invoices', { payerClientId: c, kind: 'mensual', cycleStart: '2026-09-15', cycleEnd: '2026-10-15', issuedOn: '2026-09-15', lines: [{ beneficiaryClientId: c, unitAmount: 120, description: 'Ernesto, plan familiar (4 clases)' }] });
  assert.equal(f.estado, 201);
  assert.equal((await api.get(`/api/billing/invoices/${f.datos.id}`)).datos.lines[0].description, 'Ernesto, plan familiar (4 clases)', 'el dato guardado sigue igual (inmutable)');
  const pdf = await pedir(`/api/pdf-ticket/${(await api.post('/api/pdf-tickets', { path: `/api/billing/invoices/${f.datos.id}/pdf` })).datos.id}/f.pdf`);
  assert.equal(pdf.status, 200);
});
